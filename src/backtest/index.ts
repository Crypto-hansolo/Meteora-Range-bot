import { config } from "../config.js";
import { planRange } from "../math/bins.js";
import { HyperliquidHedger } from "../hedge/hyperliquid.js";
import { logger } from "../logger.js";
import { MeteoraApi } from "../meteora/api.js";
import { classifyPool } from "../tokens.js";
import { MarketDataSource, type CandleInterval } from "./data.js";
import { runBacktest, type BacktestParams, type BacktestResult, type OutOfRangePolicy } from "./runner.js";

/**
 * Wire the live pool metadata and Hyperliquid history into a backtest run.
 *
 * Pool parameters (bin step, fee rate, fees/TVL) come from the Meteora API for
 * the pool you name, so the run is calibrated to a real pool rather than to
 * invented numbers.
 */

export interface BacktestOptions {
  /** Pool address to calibrate against. Falls back to POOL_ADDRESS. */
  poolAddress?: string;
  /** Hyperliquid coin. Inferred from the pool when omitted. */
  symbol?: string;
  days: number;
  interval: CandleInterval;
  outOfRangePolicy: OutOfRangePolicy;
  intrabar: boolean;
  /** Override the pool's observed fees/TVL, as a daily fraction. */
  feeTvlRatio24h?: number;
  takerFee: number;
  hedgeFundingMultiple: number;
  recenterSwapFee: number;
  onChainCostUsd: number;
  autoTopUpMargin: boolean;
  marginTransferFee: number;
  /**
   * Expected slippage per fill, in bps.
   *
   * Deliberately *not* `HEDGE_SLIPPAGE_BPS`: that one is how far through the
   * book the IOC limit is priced, i.e. a worst-case bound on a fill, and using
   * it as the realised cost overstates the strategy's expenses badly. On a
   * 30-day run with ~70x turnover the difference between 30 bps and 3 bps moved
   * the median outcome from -12% to -0.5%.
   */
  executionSlippageBps: number;
}

export const DEFAULT_BACKTEST_OPTIONS: Omit<BacktestOptions, "poolAddress" | "symbol"> = {
  days: 30,
  interval: "1h",
  outOfRangePolicy: "recenter",
  intrabar: true,
  // Hyperliquid's base taker fee.
  takerFee: 0.00045,
  /**
   * The hedge's worst case is the LP position going fully one-sided, which is
   * roughly twice the opening delta, and losses eat into the collateral on the
   * way there. Backtesting at 80% annualised volatility showed 2.5x running out
   * and leaving the position unhedged, so the default carries real headroom.
   */
  hedgeFundingMultiple: 4,
  // A Jupiter-style swap to rebalance the token ratio on recentring.
  recenterSwapFee: 0.001,
  onChainCostUsd: 0.5,
  /**
   * Move margin from the LP side to Hyperliquid when the perp account runs
   * short. Real operation requires this, so modelling it on by default measures
   * the strategy rather than a funding accident. Turn it off to see what a
   * neglected account does.
   */
  autoTopUpMargin: true,
  /** Bridging Solana <-> Hyperliquid, round numbers. */
  marginTransferFee: 0.001,
  /** Typical taker slippage on a liquid perp for retail-sized clips. */
  executionSlippageBps: 3,
};

export async function runBacktestFromLiveConfig(
  options: BacktestOptions,
): Promise<BacktestResult> {
  const poolAddress = options.poolAddress ?? config.selection.poolAddress;
  if (!poolAddress) {
    throw new Error(
      "A pool address is required so the backtest can use that pool's real bin step, " +
        "fee rate and fees/TVL. Pass it as an argument or set POOL_ADDRESS.",
    );
  }

  const api = new MeteoraApi();
  const hedger = new HyperliquidHedger();

  const pool = await api.fetchPair(poolAddress);
  const eligibility = classifyPool(pool.mintX, pool.mintY);
  if (!eligibility.eligible) {
    throw new Error(`Pool ${poolAddress} is not usable: ${eligibility.reason}`);
  }

  // Backtest one hedged leg. A two-volatile-sided pool would need one price
  // path per asset plus their correlation, which is a different exercise.
  const hedged = [eligibility.tokens.x, eligibility.tokens.y].filter(
    (t) => t.kind === "hedgeable",
  );
  if (hedged.length !== 1 && !options.symbol) {
    throw new Error(
      `Pool ${pool.name} has ${hedged.length} hedgeable sides. Pass an explicit symbol ` +
        `to pick one; the backtest models a single price path.`,
    );
  }
  const symbol = options.symbol ?? hedged[0]!.hlSymbol!;

  const markets = await hedger.loadMarkets();
  const market = markets.get(symbol);
  if (!market) throw new Error(`No Hyperliquid perp for ${symbol}`);

  const endTime = Date.now();
  const startTime = endTime - options.days * 86_400_000;

  const data = new MarketDataSource();
  const [candles, funding] = await Promise.all([
    data.fetchCandles({ coin: symbol, interval: options.interval, startTime, endTime }),
    data.fetchFunding({ coin: symbol, startTime, endTime }),
  ]);

  const feeTvlRatio24h = options.feeTvlRatio24h ?? pool.feeTvlRatio24h;

  logger.info(
    {
      pool: pool.name,
      symbol,
      binStep: pool.binStep,
      poolFeeRate: pool.baseFee,
      feeTvlRatio24h: `${(feeTvlRatio24h * 100).toFixed(3)}%/day`,
      candles: candles.length,
      fundingPoints: funding.length,
    },
    "backtest inputs",
  );

  const params: BacktestParams = {
    symbol,
    candles,
    funding,

    lpCapitalUsd: config.capital.lpUsd,
    binStep: pool.binStep,
    rangeWidthPct: config.lp.rangeWidthPct,
    maxBins: config.lp.maxBins,
    strategy: config.lp.strategy,
    poolFeeRate: pool.baseFee,
    feeTvlRatio24h,
    // The pool's observed rate belongs to the width we are running, so no
    // concentration adjustment applies to a single calibrated backtest.
    feeReferenceRangePct: config.lp.rangeWidthPct,

    rebalanceThresholdPct: config.hedge.rebalanceThresholdPct,
    minRebalanceUsd: config.hedge.minRebalanceUsd,
    takerFee: options.takerFee,
    slippageBps: options.executionSlippageBps,

    liqBufferMult: config.hedge.liqBufferMult,
    minLiqBufferPct: config.hedge.minLiqBufferPct,
    maxLeverage: config.hedge.maxLeverage,
    ...(config.hedge.targetLeverage !== undefined
      ? { targetLeverage: config.hedge.targetLeverage }
      : {}),
    marginTiers: market.marginTiers,
    venueMaxLeverage: market.maxLeverage,
    hedgeFundingMultiple: options.hedgeFundingMultiple,

    outOfRangePolicy: options.outOfRangePolicy,
    outOfRangeGraceMs: config.loop.exitOnOutOfRangeMs,
    recenterSwapFee: options.recenterSwapFee,
    onChainCostUsd: options.onChainCostUsd,
    autoTopUpMargin: options.autoTopUpMargin,
    marginTransferFee: options.marginTransferFee,

    intrabar: options.intrabar,
  };

  return runBacktest(params);
}

/**
 * Assemble strategy parameters for a Monte Carlo run.
 *
 * Real pool and market data are used when reachable, so the simulation is
 * calibrated to something that exists. When they are not — offline, or a
 * restricted network — it falls back to documented SOL-like defaults and says
 * so, because a simulation that silently invents its own inputs is worse than
 * one that admits to them.
 */
export async function buildSimulationStrategy(options: {
  poolAddress?: string;
  outOfRangePolicy: OutOfRangePolicy;
  feeTvlRatio24h?: number;
  intrabar: boolean;
  executionSlippageBps?: number;
}): Promise<{
  params: Omit<BacktestParams, "candles" | "funding">;
  startPrice: number;
  /** Range width the plan can actually build, after the MAX_BINS cap. */
  achievedRangePct: number;
}> {
  const defaults = DEFAULT_BACKTEST_OPTIONS;

  // SOL-like fallbacks, used only when live data cannot be fetched.
  let symbol = "SOL";
  let binStep = 20;
  let poolFeeRate = 0.002;
  let feeTvlRatio24h = options.feeTvlRatio24h ?? 0.02;
  let startPrice = 200;
  let marginTiers = [{ lowerBound: "0", maxLeverage: 20 }];
  let venueMaxLeverage = 20;
  let calibrated = false;

  const poolAddress = options.poolAddress ?? config.selection.poolAddress;

  if (poolAddress) {
    try {
      const pool = await new MeteoraApi().fetchPair(poolAddress);
      const eligibility = classifyPool(pool.mintX, pool.mintY);
      if (!eligibility.eligible) {
        throw new Error(eligibility.reason);
      }
      const hedged = [eligibility.tokens.x, eligibility.tokens.y].find(
        (t) => t.kind === "hedgeable",
      );
      if (!hedged) throw new Error("no hedgeable side");

      symbol = hedged.hlSymbol!;
      binStep = pool.binStep;
      poolFeeRate = pool.baseFee;
      feeTvlRatio24h = options.feeTvlRatio24h ?? pool.feeTvlRatio24h;

      const markets = await new HyperliquidHedger().loadMarkets();
      const market = markets.get(symbol);
      if (market) {
        startPrice = market.markPx;
        marginTiers = market.marginTiers;
        venueMaxLeverage = market.maxLeverage;
        calibrated = true;
      }
    } catch (error) {
      logger.warn(
        { pool: poolAddress, err: String(error) },
        "could not fetch live pool/market data; simulating with SOL-like defaults",
      );
    }
  }

  logger.info(
    {
      calibrated,
      symbol,
      binStep,
      poolFeeRate,
      feeTvlRatio24h: `${(feeTvlRatio24h * 100).toFixed(3)}%/day`,
      startPrice,
    },
    calibrated ? "simulating against live pool parameters" : "simulating with defaults",
  );

  // MAX_BINS caps how wide a single position can reach, so a requested +/-20%
  // can silently become +/-7%. Report what is actually achievable.
  const achieved = planRange({
    activeBinId: 0,
    binStep,
    widthPct: config.lp.rangeWidthPct,
    maxBins: config.lp.maxBins,
  });
  if (achieved.truncated) {
    logger.warn(
      {
        requested: `${config.lp.rangeWidthPct}%`,
        achieved: `${(achieved.upsideDistance * 100).toFixed(2)}%`,
        binStep,
        maxBins: config.lp.maxBins,
      },
      "MAX_BINS caps the range; widen MAX_BINS or use a pool with a larger bin step",
    );
  }

  return {
    startPrice,
    achievedRangePct: achieved.upsideDistance * 100,
    params: {
      symbol,
      lpCapitalUsd: config.capital.lpUsd,
      binStep,
      rangeWidthPct: config.lp.rangeWidthPct,
      maxBins: config.lp.maxBins,
      strategy: config.lp.strategy,
      poolFeeRate,
      feeTvlRatio24h,
      feeReferenceRangePct: config.lp.rangeWidthPct,

      rebalanceThresholdPct: config.hedge.rebalanceThresholdPct,
      minRebalanceUsd: config.hedge.minRebalanceUsd,
      takerFee: defaults.takerFee,
      slippageBps: options.executionSlippageBps ?? defaults.executionSlippageBps,

      liqBufferMult: config.hedge.liqBufferMult,
      minLiqBufferPct: config.hedge.minLiqBufferPct,
      maxLeverage: config.hedge.maxLeverage,
      ...(config.hedge.targetLeverage !== undefined
        ? { targetLeverage: config.hedge.targetLeverage }
        : {}),
      marginTiers,
      venueMaxLeverage,
      hedgeFundingMultiple: defaults.hedgeFundingMultiple,

      outOfRangePolicy: options.outOfRangePolicy,
      outOfRangeGraceMs: config.loop.exitOnOutOfRangeMs,
      recenterSwapFee: defaults.recenterSwapFee,
      onChainCostUsd: defaults.onChainCostUsd,
      autoTopUpMargin: defaults.autoTopUpMargin,
      marginTransferFee: defaults.marginTransferFee,

      intrabar: options.intrabar,
    },
  };
}

export { runBacktest } from "./runner.js";
export { formatBacktestReport, equityCurveCsv } from "./report.js";
export { runMonteCarlo, formatMonteCarloReport } from "./montecarlo.js";
export { generatePath, realisedVol } from "./paths.js";
export type { BacktestResult, BacktestParams, OutOfRangePolicy } from "./runner.js";
export type { MonteCarloStats } from "./montecarlo.js";
