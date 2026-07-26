import { config } from "../config.js";
import { planRange, type RangePlan } from "../math/bins.js";
import {
  estimateRangeComposition,
  estimateReturn,
  planHedgeLeg,
  type HedgeLegPlan,
  type HedgeSizingPolicy,
  type MarginTier,
  type RangeComposition,
  type ReturnEstimate,
} from "../math/deltaNeutral.js";
import type { PoolMetrics } from "../meteora/api.js";
import { classifyPool, hlSizeMultiplier, type PoolTokens, type TokenInfo } from "../tokens.js";

/** Everything about a Hyperliquid perp the planner needs. */
export interface MarketSnapshot {
  symbol: string;
  markPx: number;
  maxLeverage: number;
  szDecimals: number;
  /** Open interest in USD. */
  openInterestUsd: number;
  /** Hourly funding rate. Positive means longs pay shorts. */
  fundingHourly: number;
  marginTiers: MarginTier[];
}

export type MarketLookup = (hlSymbol: string) => MarketSnapshot | undefined;

export interface DepositPlan {
  xUsd: number;
  yUsd: number;
  xUnits: number;
  yUnits: number;
  /** USD price used for token X. */
  priceXUsd: number;
  /** USD price used for token Y. */
  priceYUsd: number;
}

export interface PositionPlan {
  pool: PoolMetrics;
  tokens: PoolTokens;
  range: RangePlan;
  composition: RangeComposition;
  deposit: DepositPlan;
  legs: HedgeLegPlan[];
  totalHedgeNotionalUsd: number;
  totalCollateralUsd: number;
  totalCapitalUsd: number;
  expectedReturn: ReturnEstimate;
  warnings: string[];
}

export type PlanResult = { ok: true; plan: PositionPlan } | { ok: false; reason: string };

/**
 * Build a full delta-neutral plan for one pool.
 *
 * `activeBinId` is optional: the range's *geometry* (width, price ratios, and
 * therefore the 50/50-ish composition of a freshly centred position) does not
 * depend on where the active bin happens to sit, so the scanner can rank pools
 * without an RPC round trip. Pass the real active bin id before executing to get
 * absolute bin ids.
 */
export function planPosition(params: {
  pool: PoolMetrics;
  markets: MarketLookup;
  activeBinId?: number;
  lpCapitalUsd?: number;
}): PlanResult {
  const { pool, markets } = params;
  const lpCapitalUsd = params.lpCapitalUsd ?? config.capital.lpUsd;
  const warnings: string[] = [];

  const eligibility = classifyPool(pool.mintX, pool.mintY);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  const { tokens } = eligibility;

  // Every hedged asset must actually be listed and liquid on Hyperliquid.
  for (const token of [tokens.x, tokens.y]) {
    if (token.kind !== "hedgeable") continue;
    const market = markets(token.hlSymbol!);
    if (!market) {
      return { ok: false, reason: `no Hyperliquid perp for ${token.hlSymbol} (${token.symbol})` };
    }
    if (market.markPx <= 0) {
      return { ok: false, reason: `Hyperliquid returned a non-positive mark price for ${market.symbol}` };
    }
  }

  const range = planRange({
    activeBinId: params.activeBinId ?? 0,
    binStep: pool.binStep,
    widthPct: config.lp.rangeWidthPct,
    maxBins: config.lp.maxBins,
  });

  if (range.truncated) {
    warnings.push(
      `MAX_BINS=${config.lp.maxBins} narrowed the range to ±${(range.upsideDistance * 100).toFixed(
        2,
      )}% instead of the requested ±${config.lp.rangeWidthPct}%`,
    );
  }
  if (range.binCount === 1) {
    warnings.push("single-bin range: fees are high but the position leaves range almost instantly");
  }

  const composition = estimateRangeComposition({
    activeBinId: range.minBinId + range.binsBelow,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
  });

  const deposit = planDeposit({ pool, tokens, markets, composition, lpCapitalUsd });
  if (!deposit) {
    return { ok: false, reason: "could not price both pool tokens in USD" };
  }

  // Total notional the hedge will carry, known before the legs are sized because
  // each volatile side is shorted at its full deposit value.
  const plannedNotionalUsd =
    (tokens.x.kind === "hedgeable" ? deposit.xUsd : 0) +
    (tokens.y.kind === "hedgeable" ? deposit.yUsd : 0);

  /**
   * Leverage precedence:
   *   1. `HEDGE_TARGET_LEVERAGE`  — explicit, wins outright
   *   2. `HEDGE_COLLATERAL_USD`   — implies a leverage of notional/collateral
   *   3. the liquidation-buffer solve (default, and the safe one)
   */
  let explicitLeverage = config.hedge.targetLeverage;
  if (explicitLeverage === undefined && config.capital.hedgeCollateralUsd !== undefined) {
    const collateral = config.capital.hedgeCollateralUsd;
    if (collateral > 0 && plannedNotionalUsd > 0) {
      explicitLeverage = plannedNotionalUsd / collateral;
      if (explicitLeverage < 1) {
        // Below 1x the extra margin simply sits idle; cap it so the leverage we
        // send Hyperliquid stays valid.
        warnings.push(
          `HEDGE_COLLATERAL_USD=$${fmt(collateral)} exceeds the $${fmt(
            plannedNotionalUsd,
          )} hedge notional; capping at 1x leaves the surplus idle as margin`,
        );
        explicitLeverage = 1;
      }
    }
  }

  const policy: HedgeSizingPolicy = {
    ...(explicitLeverage !== undefined ? { explicitLeverage } : {}),
    liqBufferMult: config.hedge.liqBufferMult,
    minLiqBuffer: config.hedge.minLiqBufferPct / 100,
    maxLeverage: config.hedge.maxLeverage,
    upsideRangeDistance: range.upsideDistance,
  };

  const legs: HedgeLegPlan[] = [];
  for (const [token, units] of [
    [tokens.x, deposit.xUnits],
    [tokens.y, deposit.yUnits],
  ] as [TokenInfo, number][]) {
    if (token.kind !== "hedgeable" || units <= 0) continue;

    const market = markets(token.hlSymbol!)!;
    if (market.openInterestUsd < config.selection.minHlOpenInterestUsd) {
      return {
        ok: false,
        reason:
          `${market.symbol} open interest $${fmt(market.openInterestUsd)} is below the ` +
          `$${fmt(config.selection.minHlOpenInterestUsd)} minimum`,
      };
    }

    // kBONK-style markets quote 1000 tokens per contract.
    const multiplier = hlSizeMultiplier(market.symbol);
    const leg = planHedgeLeg(
      {
        symbol: market.symbol,
        deltaUnits: units / multiplier,
        price: market.markPx,
        venueMaxLeverage: market.maxLeverage,
        marginTiers: market.marginTiers,
      },
      policy,
    );
    warnings.push(...leg.warnings.map((w) => `${market.symbol}: ${w}`));
    legs.push(leg);
  }

  if (legs.length === 0) {
    return { ok: false, reason: "no hedgeable delta in this pool" };
  }

  const totalHedgeNotionalUsd = legs.reduce((sum, leg) => sum + leg.notionalUsd, 0);
  // Always report the collateral the legs will actually consume. Leverage is an
  // integer on Hyperliquid, so flooring it makes the real margin a little larger
  // than a requested figure — reporting the request would understate capital.
  const totalCollateralUsd = legs.reduce((sum, leg) => sum + leg.collateralUsd, 0);

  const configuredCollateral = config.capital.hedgeCollateralUsd;
  if (configuredCollateral !== undefined && totalCollateralUsd > configuredCollateral * 1.05) {
    warnings.push(
      `hedge margin works out to $${fmt(totalCollateralUsd)} rather than the requested ` +
        `$${fmt(configuredCollateral)}, because Hyperliquid leverage is an integer`,
    );
  }

  // Weight funding by notional so a two-leg hedge blends correctly.
  const weightedFundingHourly =
    totalHedgeNotionalUsd > 0
      ? legs.reduce((sum, leg) => {
          const market = markets(leg.symbol);
          return sum + (market?.fundingHourly ?? 0) * leg.notionalUsd;
        }, 0) / totalHedgeNotionalUsd
      : 0;

  const expectedReturn = estimateReturn({
    feeTvlRatio24h: pool.feeTvlRatio24h,
    lpCapitalUsd,
    hedgeCollateralUsd: totalCollateralUsd,
    hedgeNotionalUsd: totalHedgeNotionalUsd,
    fundingRateHourly: weightedFundingHourly,
  });

  if (weightedFundingHourly < 0) {
    warnings.push(
      `funding is negative (${(weightedFundingHourly * 24 * 365 * 100).toFixed(1)}% APR): ` +
        "the short pays to stay open",
    );
  }

  return {
    ok: true,
    plan: {
      pool,
      tokens,
      range,
      composition,
      deposit,
      legs,
      totalHedgeNotionalUsd,
      totalCollateralUsd,
      totalCapitalUsd: lpCapitalUsd + totalCollateralUsd,
      expectedReturn,
      warnings,
    },
  };
}

/**
 * Price both pool tokens in USD.
 *
 * Stables are $1; anything hedgeable is marked at its Hyperliquid mark price.
 * When only one side is priceable the other is derived through the pool's own
 * X-in-Y price. Returns `null` when neither side can be anchored.
 */
export function priceTokensUsd(
  tokens: PoolTokens,
  markets: MarketLookup,
  poolPriceXInY: number,
): { priceXUsd: number; priceYUsd: number } | null {
  const usdPrice = (token: TokenInfo): number | undefined => {
    if (token.kind === "stable") return 1;
    return markets(token.hlSymbol!)?.markPx;
  };

  let priceXUsd = usdPrice(tokens.x);
  let priceYUsd = usdPrice(tokens.y);

  // The pool quotes X in Y, so either side can be derived from the other.
  if (priceYUsd === undefined && priceXUsd !== undefined && poolPriceXInY > 0) {
    priceYUsd = priceXUsd / poolPriceXInY;
  }
  if (priceXUsd === undefined && priceYUsd !== undefined && poolPriceXInY > 0) {
    priceXUsd = poolPriceXInY * priceYUsd;
  }

  if (priceXUsd === undefined || priceYUsd === undefined) return null;
  if (priceXUsd <= 0 || priceYUsd <= 0) return null;
  return { priceXUsd, priceYUsd };
}

/**
 * Split LP capital across the two sides and convert to token units.
 *
 * Token units come from the *pool's* price (that is the ratio the pool will
 * actually accept), while hedge notionals use Hyperliquid's mark price. The gap
 * between the two is real basis risk, not something to paper over.
 */
function planDeposit(params: {
  pool: PoolMetrics;
  tokens: PoolTokens;
  markets: MarketLookup;
  composition: RangeComposition;
  lpCapitalUsd: number;
}): DepositPlan | null {
  const { pool, tokens, markets, composition, lpCapitalUsd } = params;

  const prices = priceTokensUsd(tokens, markets, pool.currentPrice);
  if (!prices) return null;
  const { priceXUsd, priceYUsd } = prices;

  const xUsd = lpCapitalUsd * composition.valueShareX;
  const yUsd = lpCapitalUsd * composition.valueShareY;

  return {
    xUsd,
    yUsd,
    xUnits: xUsd / priceXUsd,
    yUnits: yUsd / priceYUsd,
    priceXUsd,
    priceYUsd,
  };
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping: true });
