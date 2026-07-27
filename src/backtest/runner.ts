import { planRange } from "../math/bins.js";
import {
  decideRebalance,
  planHedgeLeg,
  type HedgeLegPlan,
  type MarginTier,
} from "../math/deltaNeutral.js";
import { PaperBroker } from "../sim/broker.js";
import { balancedValueShareX, type StrategyName } from "../sim/distribution.js";
import { SimulatedLpPosition } from "../sim/lpPosition.js";
import { FundingSchedule, type Candle, type FundingPoint } from "./data.js";

/**
 * Replay a price path through the LP position and its hedge.
 *
 * The rebalancing decisions come from the *production* functions — the same
 * `decideRebalance` and `planHedgeLeg` the live bot calls. That is the point:
 * this measures the strategy as implemented, not a second model of it that
 * might quietly disagree.
 */

export type OutOfRangePolicy =
  /** Sit out of range earning nothing, keeping the hedge tracking. */
  | "hold"
  /** Unwind everything and stop, mirroring EXIT_ON_OUT_OF_RANGE_MS. */
  | "exit"
  /** Withdraw and reopen a fresh range around the current price. */
  | "recenter";

export interface BacktestParams {
  symbol: string;
  candles: Candle[];
  funding: FundingPoint[];

  lpCapitalUsd: number;
  binStep: number;
  rangeWidthPct: number;
  maxBins: number;
  strategy: StrategyName;
  /** Pool swap fee as a fraction, e.g. 0.002. */
  poolFeeRate: number;

  /**
   * Assumed daily fee yield on LP capital, as a fraction (0.02 = 2%/day).
   * This is the pool's fees/TVL from `scan`, and the one genuinely assumed
   * input in the whole run — everything else comes from market data.
   */
  feeTvlRatio24h: number;
  /**
   * Range half-width, in percent, at which `feeTvlRatio24h` was observed.
   *
   * Concentrated liquidity pays in proportion to density: halving the range
   * roughly doubles the fee rate per dollar while in range. Without this,
   * comparing range widths is meaningless — every width would earn the same
   * rate while the wider ones paid less to hedge, and wide would always "win"
   * as a pure artefact.
   *
   * Set it equal to `rangeWidthPct` to disable the adjustment.
   */
  feeReferenceRangePct: number;

  rebalanceThresholdPct: number;
  minRebalanceUsd: number;
  takerFee: number;
  slippageBps: number;

  liqBufferMult: number;
  minLiqBufferPct: number;
  maxLeverage: number;
  targetLeverage?: number;
  marginTiers: MarginTier[];
  venueMaxLeverage: number;
  /**
   * Multiple of the initial margin to park on Hyperliquid. The hedge grows as
   * price falls toward the range bottom, so funding only the opening margin
   * would strand the bot exactly when it needs to short more. 2.5x covers a
   * position going fully one-sided with room to spare.
   */
  hedgeFundingMultiple: number;

  outOfRangePolicy: OutOfRangePolicy;
  /** Grace period before `exit` or `recenter` fires, ms. */
  outOfRangeGraceMs: number;
  /** Cost of swapping back to the target ratio when recentering, as a fraction. */
  recenterSwapFee: number;
  /** Flat on-chain cost charged per LP open or close, in USD. */
  onChainCostUsd: number;
  /**
   * Move margin from the LP side to Hyperliquid when the hedge cannot be
   * funded.
   *
   * In a sustained trend the hedge loses on Hyperliquid while the matching gain
   * accrues in the LP position on Solana, so the perp account drains even
   * though the combined position is fine. A correctly operated setup transfers
   * across; leaving this off shows what happens when nobody does.
   */
  autoTopUpMargin: boolean;
  /** Cost of one cross-venue transfer, as a fraction of the amount moved. */
  marginTransferFee: number;

  /**
   * Walk open -> high -> low -> close inside each candle instead of jumping to
   * the close. Closes alone hide most of the realised volatility, and realised
   * volatility is precisely what the hedge pays for.
   */
  intrabar: boolean;
}

export interface EquityPoint {
  time: number;
  price: number;
  lpValueUsd: number;
  hedgeValueUsd: number;
  feeIncomeUsd: number;
  equityUsd: number;
  inRange: boolean;
}

export interface BacktestResult {
  symbol: string;
  startTime: number;
  endTime: number;
  days: number;
  startPrice: number;
  endPrice: number;
  priceChangePct: number;

  startCapitalUsd: number;
  lpCapitalUsd: number;
  hedgeCollateralUsd: number;
  peakMarginUsd: number;
  endEquityUsd: number;
  netPnlUsd: number;
  netReturnPct: number;
  apr: number;

  /** Fee income from the assumed fee/TVL rate, while in range. */
  feeIncomeUsd: number;
  /** What arbitrage flow alone would have paid — a floor on fee income. */
  arbImpliedFeeUsd: number;
  /** Fee rate actually applied, after adjusting for liquidity concentration. */
  effectiveFeeTvlRatio24h: number;
  /** LP liquidity value change, excluding fees. */
  lpPricePnlUsd: number;
  hedgePnlUsd: number;
  fundingUsd: number;
  takerFeesUsd: number;
  slippageUsd: number;
  onChainCostUsd: number;

  /**
   * LP price PnL plus hedge PnL. A perfect continuous hedge would leave zero;
   * what remains is the loss-versus-rebalancing that fees have to beat.
   */
  deltaResidualUsd: number;

  rebalanceCount: number;
  hedgeTurnoverUsd: number;
  timeInRangePct: number;
  recenterCount: number;
  liquidationCount: number;
  maxDrawdownPct: number;
  /** Largest delta left unhedged at any sample, in USD. */
  maxUnhedgedDeltaUsd: number;
  /**
   * Times the hedge could not be established or extended because the account
   * ran out of collateral. Every one of these is a stretch of time the position
   * was directionally exposed, so a non-zero count invalidates the headline.
   */
  failedHedgeCount: number;
  /** Value moved from the LP side to the perp account to keep the hedge alive. */
  marginTransferredUsd: number;
  marginTransferCount: number;

  equityCurve: EquityPoint[];
  exitedEarly: boolean;
  exitReason: string | null;
}

interface Leg {
  lp: SimulatedLpPosition;
  minBinId: number;
  maxBinId: number;
}

export function runBacktest(params: BacktestParams): BacktestResult {
  const { candles, lpCapitalUsd, poolFeeRate, feeTvlRatio24h, intrabar } = params;

  if (candles.length < 2) throw new Error("runBacktest: need at least two candles");
  if (params.rangeWidthPct <= 0 || params.feeReferenceRangePct <= 0) {
    throw new Error("runBacktest: range widths must be positive");
  }

  // Narrower ranges concentrate liquidity and earn proportionally more.
  const concentration = params.feeReferenceRangePct / params.rangeWidthPct;
  const effectiveFeeRate = feeTvlRatio24h * concentration;

  const first = candles[0]!;
  const startPrice = first.open;

  let leg = openLeg(params, startPrice, lpCapitalUsd);

  // Size the hedge before funding the account, so the collateral parked on
  // Hyperliquid is derived from the plan rather than guessed.
  const openingPlan = planHedge(params, leg, startPrice);
  const hedgeCollateralUsd = openingPlan
    ? openingPlan.collateralUsd * params.hedgeFundingMultiple
    : 0;

  const broker = new PaperBroker({
    takerFee: params.takerFee,
    slippage: params.slippageBps / 10_000,
    startingCollateralUsd: hedgeCollateralUsd,
  });
  broker.registerMarket(params.symbol, params.marginTiers);
  if (openingPlan) executeHedge(broker, params.symbol, openingPlan, startPrice);

  const startCapitalUsd = lpCapitalUsd + hedgeCollateralUsd;
  const fundingSchedule = new FundingSchedule(params.funding);

  let feeIncomeUsd = 0;
  let arbImpliedFeeUsd = 0;
  let onChainCostUsd = params.onChainCostUsd; // opening the position
  let rebalanceCount = 0;
  let hedgeTurnoverUsd = 0;
  let recenterCount = 0;
  let inRangeSamples = 0;
  let totalSamples = 0;
  let maxUnhedgedDeltaUsd = 0;
  let failedHedgeCount = 0;
  let marginTransferredUsd = 0;
  let marginTransferCount = 0;
  let peakMarginUsd = broker.getPosition(params.symbol)?.marginUsd ?? 0;
  let outOfRangeSince: number | null = null;
  let exitedEarly = false;
  let exitReason: string | null = null;

  const equityCurve: EquityPoint[] = [];
  let peakEquity = startCapitalUsd;
  let maxDrawdownPct = 0;

  // Liquidity value at the start, before any fees accrue.
  const lpLiquidityAtStart = leg.lp.valueInQuote(startPrice);

  for (const candle of candles) {
    const path = intrabar ? [candle.open, candle.high, candle.low, candle.close] : [candle.close];

    for (const price of path) {
      const swap = leg.lp.moveToPrice(price);
      // The bin walk is arbitrage flow: a floor on what the position earns.
      arbImpliedFeeUsd += swap.volumeQuote * poolFeeRate;

      const targetDelta = leg.lp.xUnits;
      const currentSzi = broker.sizeOf(params.symbol);

      const decision = decideRebalance({
        targetDeltaUnits: targetDelta,
        currentSzi,
        price,
        thresholdPct: params.rebalanceThresholdPct,
        minNotionalUsd: params.minRebalanceUsd,
      });

      maxUnhedgedDeltaUsd = Math.max(maxUnhedgedDeltaUsd, decision.deltaNotionalUsd);

      if (decision.shouldRebalance) {
        const outcome = tradeWithTopUp(
          params,
          broker,
          leg,
          decision.deltaSize,
          price,
        );
        if (outcome.filled) {
          rebalanceCount++;
          hedgeTurnoverUsd += outcome.turnoverUsd;
        } else {
          // Out of collateral even after a top-up: the hedge cannot be placed,
          // so the position is running directionally exposed.
          failedHedgeCount++;
        }
        if (outcome.transferredUsd > 0) {
          marginTransferredUsd += outcome.transferredUsd;
          marginTransferCount++;
        }
      }

      peakMarginUsd = Math.max(peakMarginUsd, broker.getPosition(params.symbol)?.marginUsd ?? 0);

      if (broker.checkLiquidations(() => price, candle.T).length) {
        // The hedge is gone. Re-establish it so the run keeps measuring the
        // strategy instead of an accidental naked long.
        const plan = planHedge(params, leg, price);
        if (plan) executeHedge(broker, params.symbol, plan, price);
      }
    }

    const closePrice = candle.close;
    const dtMs = candle.T - candle.t;

    // --- fee income (the one assumed input) --------------------------------
    if (leg.lp.inRange) {
      const lpValueNow = leg.lp.valueInQuote(closePrice);
      feeIncomeUsd += lpValueNow * effectiveFeeRate * (dtMs / 86_400_000);
      inRangeSamples++;
    }
    totalSamples++;

    // --- funding -----------------------------------------------------------
    const rate = fundingSchedule.accrueUntil(candle.T);
    if (rate !== 0) broker.applyFunding(params.symbol, rate, closePrice);

    // --- out-of-range policy ----------------------------------------------
    if (leg.lp.inRange) {
      outOfRangeSince = null;
    } else {
      outOfRangeSince ??= candle.T;
      const outFor = candle.T - outOfRangeSince;

      if (outFor >= params.outOfRangeGraceMs) {
        if (params.outOfRangePolicy === "exit") {
          exitedEarly = true;
          exitReason = `out of range for ${Math.round(outFor / 60_000)} min`;
        } else if (params.outOfRangePolicy === "recenter") {
          // Carry over the *liquidity* value only, not the original capital:
          // recentring after a drawdown cannot conjure the lost value back.
          // The simulator's own fee accrual is dropped here because headline
          // income comes from the assumed rate; keeping it would double-count.
          const liquidityValue =
            leg.lp.valueInQuote(closePrice) - (leg.lp.feeX * closePrice + leg.lp.feeY);
          onChainCostUsd += params.onChainCostUsd + recenterSwapCost(params, leg, closePrice);
          leg = openLeg(params, closePrice, liquidityValue, leg.lp.priceAtBinZero);
          recenterCount++;
          outOfRangeSince = null;

          // Re-hedge immediately. A fresh range is roughly 50/50, while the old
          // one had drifted fully to one side, so the delta jumps discontinuously
          // at this instant. Waiting for the next sample would leave most of the
          // position naked — and a live bot must do the same thing here.
          const target = leg.lp.xUnits;
          const gap = broker.sizeOf(params.symbol) + target;
          if (Math.abs(gap) * closePrice > params.minRebalanceUsd) {
            const outcome = tradeWithTopUp(params, broker, leg, gap, closePrice);
            if (outcome.filled) {
              rebalanceCount++;
              hedgeTurnoverUsd += outcome.turnoverUsd;
            } else {
              failedHedgeCount++;
            }
            if (outcome.transferredUsd > 0) {
              marginTransferredUsd += outcome.transferredUsd;
              marginTransferCount++;
            }
          }
        }
      }
    }

    // --- mark to market ----------------------------------------------------
    const lpValue = leg.lp.valueInQuote(closePrice);
    const hedgeValue = broker.accountValueUsd(() => closePrice);
    const equity = lpValue + hedgeValue + feeIncomeUsd - onChainCostUsd;

    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / peakEquity) * 100);
    }

    equityCurve.push({
      time: candle.T,
      price: closePrice,
      lpValueUsd: lpValue,
      hedgeValueUsd: hedgeValue,
      feeIncomeUsd,
      equityUsd: equity,
      inRange: leg.lp.inRange,
    });

    if (exitedEarly) break;
  }

  // --- settlement -----------------------------------------------------------
  const lastPoint = equityCurve.at(-1)!;
  const endPrice = lastPoint.price;
  broker.closeAll(() => endPrice);
  onChainCostUsd += params.onChainCostUsd; // closing the position

  // Strip the simulator's own fee accrual out of the liquidity value: headline
  // income comes from the assumed rate, and counting both would double-count.
  const lpFeeValueAtEnd = leg.lp.feeX * endPrice + leg.lp.feeY;
  const lpLiquidityAtEnd = leg.lp.valueInQuote(endPrice) - lpFeeValueAtEnd;
  const lpPricePnlUsd = lpLiquidityAtEnd - lpLiquidityAtStart;

  const hedgeValueAtEnd = broker.accountValueUsd(() => endPrice);
  const hedgePnlUsd = hedgeValueAtEnd - hedgeCollateralUsd;

  const endEquityUsd = lpLiquidityAtEnd + hedgeValueAtEnd + feeIncomeUsd - onChainCostUsd;
  const netPnlUsd = endEquityUsd - startCapitalUsd;

  const startTime = first.t;
  const endTime = lastPoint.time;
  const days = (endTime - startTime) / 86_400_000;

  return {
    symbol: params.symbol,
    startTime,
    endTime,
    days,
    startPrice,
    endPrice,
    priceChangePct: (endPrice / startPrice - 1) * 100,

    startCapitalUsd,
    lpCapitalUsd,
    hedgeCollateralUsd,
    peakMarginUsd,
    endEquityUsd,
    netPnlUsd,
    netReturnPct: startCapitalUsd > 0 ? (netPnlUsd / startCapitalUsd) * 100 : 0,
    apr: startCapitalUsd > 0 && days > 0 ? (netPnlUsd / startCapitalUsd) * (365 / days) : 0,

    feeIncomeUsd,
    arbImpliedFeeUsd,
    effectiveFeeTvlRatio24h: effectiveFeeRate,
    lpPricePnlUsd,
    hedgePnlUsd,
    fundingUsd: broker.fundingUsd,
    takerFeesUsd: broker.feesPaidUsd,
    slippageUsd: broker.slippageCostUsd,
    onChainCostUsd,

    deltaResidualUsd: lpPricePnlUsd + hedgePnlUsd,

    rebalanceCount,
    hedgeTurnoverUsd,
    timeInRangePct: totalSamples > 0 ? (inRangeSamples / totalSamples) * 100 : 0,
    recenterCount,
    liquidationCount: broker.liquidations.length,
    maxDrawdownPct,
    maxUnhedgedDeltaUsd,
    failedHedgeCount,
    marginTransferredUsd,
    marginTransferCount,

    equityCurve,
    exitedEarly,
    exitReason,
  };
}

/**
 * Build an LP position centred on `price` with `capitalUsd` of value.
 *
 * Bin ids stay anchored to the run's first price so they remain comparable
 * across recenters.
 */
function openLeg(
  params: BacktestParams,
  price: number,
  capitalUsd: number,
  anchorPrice?: number,
): Leg {
  const anchor = anchorPrice ?? price;
  const ratio = 1 + params.binStep / 10_000;
  const activeBinId = Math.floor(Math.log(price / anchor) / Math.log(ratio) + 1e-9);

  const range = planRange({
    activeBinId,
    binStep: params.binStep,
    widthPct: params.rangeWidthPct,
    maxBins: params.maxBins,
  });

  const shareX = balancedValueShareX({
    strategy: params.strategy,
    activeBinId,
    binStep: params.binStep,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
  });

  const lp = new SimulatedLpPosition({
    strategy: params.strategy,
    binStep: params.binStep,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    activeBinId,
    xUnits: (capitalUsd * shareX) / price,
    yUnits: capitalUsd * (1 - shareX),
    feeRate: params.poolFeeRate,
    priceAtBinZero: anchor,
  });

  return { lp, minBinId: range.minBinId, maxBinId: range.maxBinId };
}

/**
 * Cost of recentring: the swap needed to get back to the target token ratio.
 *
 * Withdrawing and redepositing pays no pool fee, but a position that drifted
 * out of range is lopsided, so returning to a balanced ratio means trading the
 * excess.
 */
function recenterSwapCost(params: BacktestParams, leg: Leg, price: number): number {
  const xValue = leg.lp.xUnits * price;
  const yValue = leg.lp.yUnits;
  const total = xValue + yValue;
  if (total <= 0) return 0;

  const swapValue = Math.abs(xValue - total / 2);
  return swapValue * params.recenterSwapFee;
}

/** Size the hedge with the production planner. Returns null when delta is zero. */
function planHedge(params: BacktestParams, leg: Leg, price: number): HedgeLegPlan | null {
  const delta = leg.lp.xUnits;
  if (delta <= 0) return null;

  const ratio = 1 + params.binStep / 10_000;
  const upsideDistance = ratio ** Math.max(leg.maxBinId - leg.lp.activeBinId, 0) - 1;

  return planHedgeLeg(
    {
      symbol: params.symbol,
      deltaUnits: delta,
      price,
      venueMaxLeverage: params.venueMaxLeverage,
      marginTiers: params.marginTiers,
    },
    {
      ...(params.targetLeverage !== undefined ? { explicitLeverage: params.targetLeverage } : {}),
      liqBufferMult: params.liqBufferMult,
      minLiqBuffer: params.minLiqBufferPct / 100,
      maxLeverage: params.maxLeverage,
      upsideRangeDistance: Math.max(upsideDistance, 1e-6),
    },
  );
}

function executeHedge(
  broker: PaperBroker,
  symbol: string,
  plan: HedgeLegPlan,
  price: number,
): void {
  broker.setLeverage(symbol, plan.leverage);
  broker.trade({ symbol, size: plan.size, markPx: price });
}

/**
 * Place a hedge trade, topping the perp account up from the LP side if the
 * margin is not there.
 *
 * The transfer is the honest part: a delta-neutral position spans two venues,
 * and the one that loses money in a trend is not the one that gains it. Without
 * moving margin across, a long enough trend kills the hedge.
 */
function tradeWithTopUp(
  params: BacktestParams,
  broker: PaperBroker,
  leg: Leg,
  size: number,
  price: number,
): { filled: boolean; turnoverUsd: number; transferredUsd: number } {
  const first = broker.trade({ symbol: params.symbol, size, markPx: price });
  if (first) return { filled: true, turnoverUsd: first.size * first.price, transferredUsd: 0 };

  if (!params.autoTopUpMargin) return { filled: false, turnoverUsd: 0, transferredUsd: 0 };

  // Ask for the full margin the trade needs, plus a working buffer so the next
  // few rebalances do not each trigger their own transfer.
  const position = broker.getPosition(params.symbol);
  const leverage = position?.leverage ?? 1;
  const needed = (Math.abs(size) * price) / Math.max(leverage, 1);
  const wanted = needed * 3 - broker.freeCollateralUsd;
  if (wanted <= 0) return { filled: false, turnoverUsd: 0, transferredUsd: 0 };

  const moved = leg.lp.withdrawValue(price, wanted);
  if (moved <= 0) return { filled: false, turnoverUsd: 0, transferredUsd: 0 };

  const net = moved * (1 - params.marginTransferFee);
  broker.freeCollateralUsd += net;

  const retry = broker.trade({ symbol: params.symbol, size, markPx: price });
  return {
    filled: retry !== null,
    turnoverUsd: retry ? retry.size * retry.price : 0,
    transferredUsd: moved,
  };
}
