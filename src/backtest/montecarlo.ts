import type { FundingPoint } from "./data.js";
import { generatePath, realisedVol } from "./paths.js";
import { runBacktest, type BacktestParams, type BacktestResult } from "./runner.js";

/**
 * Run the strategy over many independent price paths.
 *
 * A single backtest tells you what happened once. This tells you the *spread*,
 * which is the only thing worth acting on: a strategy that averages a small
 * profit but loses badly in the worst 5% of paths is a different proposition
 * from one that grinds out the same average safely.
 */

export interface MonteCarloParams {
  paths: number;
  seed: number;
  bars: number;
  barMs: number;
  startPrice: number;
  annualVol: number;
  annualDrift?: number;
  /** Constant hourly funding applied across every path. */
  fundingHourly: number;
  /** Everything the backtest needs except the candles and funding. */
  strategy: Omit<BacktestParams, "candles" | "funding">;
}

export interface MonteCarloStats {
  paths: number;
  annualVolTarget: number;
  annualVolRealised: number;
  days: number;

  /** Net return on total capital, in percent, across paths. */
  returnPct: Percentiles;
  /** Annualised, in percent. */
  aprPct: Percentiles;
  /** Max drawdown per path, in percent. */
  drawdownPct: Percentiles;
  /** Delta residual — the rebalancing cost — in USD. */
  deltaResidualUsd: Percentiles;
  /** Fee income needed per day to break even, in percent of LP capital. */
  breakevenFeePctPerDay: Percentiles;

  /** Share of paths that ended in profit. */
  winRatePct: number;
  /** Paths where the hedge could not be placed at least once. */
  pathsWithFailedHedge: number;
  /** Paths with at least one liquidation. */
  pathsWithLiquidation: number;
  meanRebalances: number;
  meanTurnoverUsd: number;
  meanTimeInRangePct: number;

  /** The single worst path, for inspection. */
  worst: BacktestResult;
}

export interface Percentiles {
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[idx]!;
  };
  return {
    p5: at(0.05),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    mean: values.reduce((s, v) => s + v, 0) / (values.length || 1),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function runMonteCarlo(params: MonteCarloParams): MonteCarloStats {
  const results: BacktestResult[] = [];
  const vols: number[] = [];

  for (let i = 0; i < params.paths; i++) {
    const candles = generatePath({
      seed: params.seed + i * 7919, // stride by a prime so seeds do not collide
      bars: params.bars,
      barMs: params.barMs,
      startPrice: params.startPrice,
      annualVol: params.annualVol,
      ...(params.annualDrift !== undefined ? { annualDrift: params.annualDrift } : {}),
    });

    vols.push(realisedVol(candles, params.barMs));

    const funding: FundingPoint[] = candles.map((c) => ({
      time: c.T,
      rate: params.fundingHourly * (params.barMs / 3_600_000),
    }));

    results.push(runBacktest({ ...params.strategy, candles, funding }));
  }

  const lpCapital = params.strategy.lpCapitalUsd;
  const breakeven = results.map((r) => {
    const cost = -r.deltaResidualUsd + r.takerFeesUsd + r.slippageUsd + r.onChainCostUsd;
    return (cost / lpCapital / Math.max(r.days, 1e-9)) * 100;
  });

  const worst = results.reduce((a, b) => (b.netReturnPct < a.netReturnPct ? b : a));

  return {
    paths: results.length,
    annualVolTarget: params.annualVol,
    annualVolRealised: vols.reduce((s, v) => s + v, 0) / (vols.length || 1),
    days: results[0]?.days ?? 0,

    returnPct: percentiles(results.map((r) => r.netReturnPct)),
    aprPct: percentiles(results.map((r) => r.apr * 100)),
    drawdownPct: percentiles(results.map((r) => r.maxDrawdownPct)),
    deltaResidualUsd: percentiles(results.map((r) => r.deltaResidualUsd)),
    breakevenFeePctPerDay: percentiles(breakeven),

    winRatePct: (results.filter((r) => r.netPnlUsd > 0).length / results.length) * 100,
    pathsWithFailedHedge: results.filter((r) => r.failedHedgeCount > 0).length,
    pathsWithLiquidation: results.filter((r) => r.liquidationCount > 0).length,
    meanRebalances: results.reduce((s, r) => s + r.rebalanceCount, 0) / results.length,
    meanTurnoverUsd: results.reduce((s, r) => s + r.hedgeTurnoverUsd, 0) / results.length,
    meanTimeInRangePct: results.reduce((s, r) => s + r.timeInRangePct, 0) / results.length,

    worst,
  };
}

export function formatMonteCarloReport(s: MonteCarloStats): string {
  const lines: string[] = [];
  const push = (t = "") => lines.push(t);

  const dist = (label: string, p: Percentiles, unit: string) =>
    `  ${label.padEnd(26)}` +
    [p.p5, p.p25, p.median, p.p75, p.p95]
      .map((v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}${unit}`.padStart(11))
      .join("");

  push(`Monte Carlo: ${s.paths} paths x ${s.days.toFixed(1)} days`);
  push("=".repeat(82));
  push(
    `Volatility  ${(s.annualVolTarget * 100).toFixed(0)}% target, ` +
      `${(s.annualVolRealised * 100).toFixed(0)}% realised   ` +
      `(GARCH clustering + fat tails)`,
  );
  push();
  push(`  ${"".padEnd(26)}${["p5", "p25", "median", "p75", "p95"].map((h) => h.padStart(11)).join("")}`);
  push("  " + "-".repeat(80));
  push(dist("Return on capital", s.returnPct, "%"));
  push(dist("Annualised", s.aprPct, "%"));
  push(dist("Max drawdown", s.drawdownPct, "%"));
  push(dist("Rebalancing cost", s.deltaResidualUsd, "$"));
  push(dist("Breakeven fee/day", s.breakevenFeePctPerDay, "%"));
  push();

  push("Outcomes");
  push("-".repeat(82));
  push(`  Profitable paths          ${s.winRatePct.toFixed(1)}%`);
  push(
    `  Worst path                ${s.worst.netReturnPct.toFixed(2)}% ` +
      `(drawdown ${s.worst.maxDrawdownPct.toFixed(1)}%)`,
  );
  push(
    `  Paths with a failed hedge ${s.pathsWithFailedHedge}` +
      (s.pathsWithFailedHedge ? "   !! those results are not delta neutral" : ""),
  );
  push(
    `  Paths with a liquidation  ${s.pathsWithLiquidation}` +
      (s.pathsWithLiquidation ? "   !!" : ""),
  );
  push(`  Mean rebalances           ${s.meanRebalances.toFixed(0)}`);
  push(
    `  Mean hedge turnover       $${s.meanTurnoverUsd.toFixed(0)} ` +
      `(${(s.meanTurnoverUsd / Math.max(s.worst.lpCapitalUsd, 1)).toFixed(1)}x LP capital)`,
  );
  push(`  Mean time in range        ${s.meanTimeInRangePct.toFixed(1)}%`);
  push();
  push(
    "Read the p5 column, not the median: it is the bad-but-plausible case, and it",
  );
  push("is what decides whether the position survives long enough to earn anything.");

  return lines.join("\n");
}
