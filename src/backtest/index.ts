import { config } from "../config.js";
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

    rebalanceThresholdPct: config.hedge.rebalanceThresholdPct,
    minRebalanceUsd: config.hedge.minRebalanceUsd,
    takerFee: options.takerFee,
    slippageBps: config.hedge.slippageBps,

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

export { runBacktest } from "./runner.js";
export { formatBacktestReport, equityCurveCsv } from "./report.js";
export type { BacktestResult, BacktestParams, OutOfRangePolicy } from "./runner.js";
