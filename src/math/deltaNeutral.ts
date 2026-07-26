/**
 * Delta-neutral sizing math for a Meteora DLMM position hedged on Hyperliquid.
 *
 * ## Why the hedge size equals the token balance
 *
 * Let a concentrated-liquidity position hold `x` units of the volatile token X
 * and `y` units of the quote token Y. Measured in Y, its value is
 *
 *     V(P) = x(P) * P + y(P)
 *
 * Inside a DLMM bin all swaps execute at that bin's fixed price, so an
 * infinitesimal move rebalances X against Y at exactly price `P`:
 *
 *     P * dx + dy = 0
 *
 * Differentiating V and substituting:
 *
 *     dV/dP = x + P * dx/dP + dy/dP = x + (P * dx + dy)/dP = x
 *
 * So the position's delta, expressed in units of X, is simply **the amount of X
 * currently held** — no Uniswap-v3 closed form needed, and it holds for every
 * liquidity shape (Spot, Curve, BidAsk). The hedge is therefore a short of `x`
 * units of X.
 *
 * `x` is *not* constant: it shrinks toward 0 as price climbs to the range top
 * and grows to the full deposit as price falls to the range bottom. That is why
 * the hedge has to be rebalanced continuously rather than set once.
 *
 * If the quote side is itself volatile (e.g. a JUP/SOL pool), then `y` is a
 * plain spot holding with delta 1, so it needs its own short of `y` units.
 * `positionDeltas()` handles both legs uniformly.
 */

/** Hyperliquid margin tier as returned by the `meta` info endpoint. */
export interface MarginTier {
  lowerBound: string;
  maxLeverage: number;
}

/**
 * Maintenance margin fraction for a given notional.
 *
 * Hyperliquid sets maintenance margin to half the initial margin at the tier's
 * max leverage, i.e. `mmf = 1 / (2 * maxLeverage)`.
 */
export function maintenanceMarginFraction(tiers: MarginTier[], notionalUsd: number): number {
  if (!tiers.length) throw new Error("maintenanceMarginFraction: no margin tiers provided");

  const sorted = [...tiers].sort((a, b) => Number(a.lowerBound) - Number(b.lowerBound));
  let tier = sorted[0]!;
  for (const candidate of sorted) {
    if (notionalUsd >= Number(candidate.lowerBound)) tier = candidate;
    else break;
  }
  if (tier.maxLeverage <= 0) throw new Error("maintenanceMarginFraction: invalid tier leverage");
  return 1 / (2 * tier.maxLeverage);
}

/**
 * Liquidation price of an isolated short.
 *
 * Liquidation triggers when isolated equity falls to the maintenance
 * requirement:
 *
 *     C + S*(P0 - P) = S*P*mmf   =>   P_liq = (C/S + P0) / (1 + mmf)
 *
 * where `C` is isolated margin, `S` the (positive) short size and `P0` the
 * entry price. Shorts can only be liquidated to the upside, so the result is
 * always above `P0`.
 *
 * For a *live* position prefer Hyperliquid's reported `liquidationPx`; this
 * function is for pre-trade planning.
 */
export function liquidationPriceShort(params: {
  size: number;
  entryPx: number;
  isolatedMarginUsd: number;
  mmf: number;
}): number {
  const { size, entryPx, isolatedMarginUsd, mmf } = params;
  if (size <= 0) return Number.POSITIVE_INFINITY;
  return (isolatedMarginUsd / size + entryPx) / (1 + mmf);
}

/**
 * Leverage that places the liquidation price `buffer` above spot.
 *
 * Inverting the relation above with `C = S*P0/L`:
 *
 *     buffer = P_liq/P0 - 1 = (1/L - mmf) / (1 + mmf)
 *     =>  L = 1 / (buffer * (1 + mmf) + mmf)
 *
 * Returns `Infinity` when no positive leverage can reach the buffer, which
 * happens once `buffer` is unreachable for the asset's maintenance margin.
 */
export function leverageForLiquidationBuffer(buffer: number, mmf: number): number {
  if (buffer <= 0) throw new Error("leverageForLiquidationBuffer: buffer must be > 0");
  const inv = buffer * (1 + mmf) + mmf;
  return inv <= 0 ? Number.POSITIVE_INFINITY : 1 / inv;
}

/** Fraction of spot the liquidation price sits above spot, for a given leverage. */
export function liquidationBufferForLeverage(leverage: number, mmf: number): number {
  if (leverage <= 0) throw new Error("liquidationBufferForLeverage: leverage must be > 0");
  return (1 / leverage - mmf) / (1 + mmf);
}

// ---------------------------------------------------------------------------
// LP composition
// ---------------------------------------------------------------------------

export interface RangeComposition {
  /** Share of deposited value held in token X (the delta-carrying side). */
  valueShareX: number;
  /** Share of deposited value held in token Y. */
  valueShareY: number;
  binsBelowActive: number;
  binsAboveActive: number;
  binCount: number;
}

/**
 * Estimate how a `Spot` (uniform-value) deposit splits across X and Y.
 *
 * Bins above the active bin hold only X, bins below hold only Y, and the active
 * bin is assumed half-and-half. Used for pre-trade planning; once the position
 * exists we read the real amounts from chain instead.
 */
export function estimateRangeComposition(params: {
  activeBinId: number;
  minBinId: number;
  maxBinId: number;
}): RangeComposition {
  const { activeBinId, minBinId, maxBinId } = params;
  if (maxBinId < minBinId) throw new Error("estimateRangeComposition: maxBinId < minBinId");

  const binCount = maxBinId - minBinId + 1;
  // Clamp so an out-of-range active bin yields a fully one-sided composition.
  const below = Math.min(Math.max(activeBinId - minBinId, 0), binCount);
  const above = Math.min(Math.max(maxBinId - activeBinId, 0), binCount);
  const activeInRange = activeBinId >= minBinId && activeBinId <= maxBinId;
  const activeWeight = activeInRange ? 0.5 : 0;

  const shareX = (above + activeWeight) / binCount;
  const shareY = (below + activeWeight) / binCount;
  // Normalise: when the active bin sits outside the range the two halves do not
  // sum to 1 on their own.
  const total = shareX + shareY;

  return {
    valueShareX: total > 0 ? shareX / total : 0,
    valueShareY: total > 0 ? shareY / total : 1,
    binsBelowActive: below,
    binsAboveActive: above,
    binCount,
  };
}

// ---------------------------------------------------------------------------
// Hedge plan
// ---------------------------------------------------------------------------

export interface HedgeLegPlan {
  /** Hyperliquid perp symbol, e.g. "SOL". */
  symbol: string;
  /** Short size in base units. */
  size: number;
  /** Mark price used for sizing. */
  price: number;
  /** `size * price`. */
  notionalUsd: number;
  /** Isolated margin to allocate. */
  collateralUsd: number;
  /** Integer leverage sent to Hyperliquid (it only accepts integers). */
  leverage: number;
  /** Maintenance margin fraction used. */
  mmf: number;
  /** Projected liquidation price at this size/collateral. */
  liquidationPx: number;
  /** Liquidation distance as a fraction of spot. */
  liquidationBuffer: number;
  /** Constraint that ended up determining the leverage. */
  leverageBoundBy: "liquidation-buffer" | "config-max" | "venue-max" | "explicit";
  warnings: string[];
}

export interface HedgeLegRequest {
  symbol: string;
  /** Delta in base units that the LP leg is long. */
  deltaUnits: number;
  price: number;
  /** Asset max leverage from Hyperliquid `meta.universe`. */
  venueMaxLeverage: number;
  marginTiers: MarginTier[];
}

export interface HedgeSizingPolicy {
  /** Force this leverage; skips the liquidation-buffer solve. */
  explicitLeverage?: number;
  /** Multiple of the upside range distance the liquidation price must clear. */
  liqBufferMult: number;
  /** Absolute floor for the liquidation buffer, as a fraction of spot. */
  minLiqBuffer: number;
  /** Hard cap from config. */
  maxLeverage: number;
  /**
   * Upside distance to the range top as a fraction of spot (e.g. 0.05 for a
   * range topping out 5% above spot). Drives the required buffer.
   */
  upsideRangeDistance: number;
}

/**
 * Size one hedge leg.
 *
 * Leverage comes from a liquidation-safety constraint rather than a gut feel:
 * above the LP range top the position stops gaining on the upside while the
 * short keeps losing, so the liquidation price must sit comfortably beyond it.
 * Required buffer is `max(upsideRangeDistance * liqBufferMult, minLiqBuffer)`,
 * then capped by config and venue limits.
 */
export function planHedgeLeg(req: HedgeLegRequest, policy: HedgeSizingPolicy): HedgeLegPlan {
  const warnings: string[] = [];
  const size = Math.abs(req.deltaUnits);
  const notionalUsd = size * req.price;
  const mmf = maintenanceMarginFraction(req.marginTiers, notionalUsd);

  const requiredBuffer = Math.max(
    policy.upsideRangeDistance * policy.liqBufferMult,
    policy.minLiqBuffer,
  );

  let leverage: number;
  let boundBy: HedgeLegPlan["leverageBoundBy"];

  if (policy.explicitLeverage !== undefined) {
    leverage = policy.explicitLeverage;
    boundBy = "explicit";
  } else {
    const safe = leverageForLiquidationBuffer(requiredBuffer, mmf);
    leverage = safe;
    boundBy = "liquidation-buffer";
    if (leverage > policy.maxLeverage) {
      leverage = policy.maxLeverage;
      boundBy = "config-max";
    }
  }

  if (leverage > req.venueMaxLeverage) {
    leverage = req.venueMaxLeverage;
    boundBy = "venue-max";
  }

  // Hyperliquid's updateLeverage action takes an integer. Round down so the
  // effective liquidation buffer is never worse than planned.
  const intLeverage = Math.max(1, Math.floor(leverage));
  if (intLeverage < 1) warnings.push("leverage rounded up to the 1x minimum");

  const collateralUsd = intLeverage > 0 ? notionalUsd / intLeverage : notionalUsd;
  const liquidationPx = liquidationPriceShort({
    size,
    entryPx: req.price,
    isolatedMarginUsd: collateralUsd,
    mmf,
  });
  const liquidationBuffer = req.price > 0 ? liquidationPx / req.price - 1 : 0;

  if (liquidationBuffer < requiredBuffer) {
    warnings.push(
      `liquidation buffer ${(liquidationBuffer * 100).toFixed(1)}% is below the ` +
        `required ${(requiredBuffer * 100).toFixed(1)}% (capped by ${boundBy})`,
    );
  }
  if (liquidationBuffer <= policy.upsideRangeDistance) {
    warnings.push(
      "liquidation price sits inside the LP range - the short can be liquidated " +
        "while the LP position is still in range",
    );
  }

  return {
    symbol: req.symbol,
    size,
    price: req.price,
    notionalUsd,
    collateralUsd,
    leverage: intLeverage,
    mmf,
    liquidationPx,
    liquidationBuffer,
    leverageBoundBy: boundBy,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Rebalance decision
// ---------------------------------------------------------------------------

export interface RebalanceDecision {
  shouldRebalance: boolean;
  /** Positive = sell (increase short). Negative = buy (reduce short). */
  deltaSize: number;
  deltaNotionalUsd: number;
  /** Threshold the drift was compared against, in USD. */
  thresholdUsd: number;
  reason: string;
}

/**
 * Decide whether to re-hedge.
 *
 * `currentSzi` follows Hyperliquid's convention: negative for a short.
 * `targetDeltaUnits` is the LP position's current long delta in base units, so
 * the desired signed position is `-targetDeltaUnits`.
 */
export function decideRebalance(params: {
  targetDeltaUnits: number;
  currentSzi: number;
  price: number;
  thresholdPct: number;
  minNotionalUsd: number;
}): RebalanceDecision {
  const { targetDeltaUnits, currentSzi, price, thresholdPct, minNotionalUsd } = params;

  // Desired signed position is -targetDeltaUnits. Express the gap as the amount
  // still to *sell*, so a positive number always means "short more".
  const deltaSize = currentSzi + targetDeltaUnits;
  const deltaNotionalUsd = Math.abs(deltaSize) * price;
  const targetNotionalUsd = Math.abs(targetDeltaUnits) * price;
  const thresholdUsd = Math.max(minNotionalUsd, (thresholdPct / 100) * targetNotionalUsd);

  if (deltaNotionalUsd < thresholdUsd) {
    return {
      shouldRebalance: false,
      deltaSize,
      deltaNotionalUsd,
      thresholdUsd,
      reason: `drift $${deltaNotionalUsd.toFixed(2)} < threshold $${thresholdUsd.toFixed(2)}`,
    };
  }

  return {
    shouldRebalance: true,
    deltaSize,
    deltaNotionalUsd,
    thresholdUsd,
    reason:
      `drift $${deltaNotionalUsd.toFixed(2)} >= threshold $${thresholdUsd.toFixed(2)} ` +
      `(${deltaSize > 0 ? "increase" : "reduce"} short by ${Math.abs(deltaSize)})`,
  };
}

/** Effective leverage of a live isolated position. */
export function effectiveLeverage(notionalUsd: number, marginUsd: number): number {
  if (marginUsd <= 0) return Number.POSITIVE_INFINITY;
  return notionalUsd / marginUsd;
}

// ---------------------------------------------------------------------------
// Expected return
// ---------------------------------------------------------------------------

export interface ReturnEstimate {
  /** Annualised LP fee yield on LP capital alone. */
  lpFeeApr: number;
  /** Annualised funding earned (positive) or paid (negative) by the shorts. */
  fundingApr: number;
  /** Combined APR on total deployed capital (LP + hedge collateral). */
  netAprOnTotalCapital: number;
  lpCapitalUsd: number;
  hedgeCollateralUsd: number;
  totalCapitalUsd: number;
}

/**
 * Blend LP fees and perp funding into one number on total deployed capital.
 *
 * Fee APR is earned on LP capital only, while the hedge collateral sits idle as
 * margin, so the combined figure is diluted by the collateral requirement. This
 * is the number that matters when comparing pools: a pool with a fat fee/TVL
 * ratio but a hedge that eats 50% of capital can lose to a tamer one.
 *
 * `fundingRateHourly` is Hyperliquid's hourly rate; a positive rate means longs
 * pay shorts, so a short *earns* it.
 */
export function estimateReturn(params: {
  feeTvlRatio24h: number;
  lpCapitalUsd: number;
  hedgeCollateralUsd: number;
  hedgeNotionalUsd: number;
  fundingRateHourly: number;
}): ReturnEstimate {
  const { feeTvlRatio24h, lpCapitalUsd, hedgeCollateralUsd, hedgeNotionalUsd, fundingRateHourly } =
    params;

  const lpFeeApr = feeTvlRatio24h * 365;
  const fundingUsdPerYear = fundingRateHourly * 24 * 365 * hedgeNotionalUsd;
  const totalCapitalUsd = lpCapitalUsd + hedgeCollateralUsd;

  const lpUsdPerYear = lpFeeApr * lpCapitalUsd;
  const netAprOnTotalCapital =
    totalCapitalUsd > 0 ? (lpUsdPerYear + fundingUsdPerYear) / totalCapitalUsd : 0;

  return {
    lpFeeApr,
    fundingApr: lpCapitalUsd > 0 ? fundingUsdPerYear / lpCapitalUsd : 0,
    netAprOnTotalCapital,
    lpCapitalUsd,
    hedgeCollateralUsd,
    totalCapitalUsd,
  };
}
