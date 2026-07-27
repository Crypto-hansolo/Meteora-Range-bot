import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import type { BacktestParams } from "../src/backtest/runner.js";

let paths: typeof import("../src/backtest/paths.js");
let mc: typeof import("../src/backtest/montecarlo.js");

before(async () => {
  process.env.RPC_URL ??= "https://api.mainnet-beta.solana.com";
  process.env.LOG_LEVEL = "silent";
  paths = await import("../src/backtest/paths.js");
  mc = await import("../src/backtest/montecarlo.js");
});

const HOUR = 3_600_000;

describe("generatePath", () => {
  const base = { seed: 1, bars: 24 * 60, barMs: HOUR, startPrice: 200, annualVol: 0.8 };

  it("is reproducible from its seed", () => {
    const a = paths.generatePath(base);
    const b = paths.generatePath(base);
    assert.deepEqual(
      a.map((c) => c.close),
      b.map((c) => c.close),
    );
  });

  it("produces different paths for different seeds", () => {
    const a = paths.generatePath(base);
    const b = paths.generatePath({ ...base, seed: 2 });
    assert.notEqual(a.at(-1)!.close, b.at(-1)!.close);
  });

  it("hits the requested volatility within tolerance", () => {
    for (const annualVol of [0.3, 0.8, 1.5]) {
      const path = paths.generatePath({ ...base, annualVol, bars: 24 * 180 });
      const realised = paths.realisedVol(path, HOUR);
      assert.ok(
        Math.abs(realised - annualVol) / annualVol < 0.25,
        `target ${annualVol}, realised ${realised}`,
      );
    }
  });

  it("keeps highs and lows consistent with open and close", () => {
    for (const c of paths.generatePath(base)) {
      assert.ok(c.high >= Math.max(c.open, c.close) - 1e-9, "high must contain the body");
      assert.ok(c.low <= Math.min(c.open, c.close) + 1e-9, "low must contain the body");
      assert.ok(c.high >= c.low);
      assert.ok(c.close > 0);
    }
  });

  it("chains each bar's open to the previous close", () => {
    const path = paths.generatePath(base);
    for (let i = 1; i < path.length; i++) {
      assert.ok(Math.abs(path[i]!.open - path[i - 1]!.close) < 1e-9);
    }
  });

  it("clusters volatility instead of spreading it evenly", () => {
    // With GARCH the variance of rolling volatility is far higher than it would
    // be for i.i.d. returns, which is the whole point of using it here.
    const path = paths.generatePath({ ...base, bars: 24 * 120 });
    const returns = path.slice(1).map((c, i) => Math.log(c.close / path[i]!.close));

    const window = 24;
    const vols: number[] = [];
    for (let i = 0; i + window < returns.length; i += window) {
      const slice = returns.slice(i, i + window);
      const mean = slice.reduce((s, r) => s + r, 0) / slice.length;
      vols.push(Math.sqrt(slice.reduce((s, r) => s + (r - mean) ** 2, 0) / slice.length));
    }

    const meanVol = vols.reduce((s, v) => s + v, 0) / vols.length;
    const spread = Math.sqrt(
      vols.reduce((s, v) => s + (v - meanVol) ** 2, 0) / vols.length,
    );
    assert.ok(spread / meanVol > 0.3, `vol-of-vol too low: ${spread / meanVol}`);
  });

  it("produces fatter tails than a normal distribution", () => {
    const path = paths.generatePath({ ...base, bars: 24 * 365 });
    const returns = path.slice(1).map((c, i) => Math.log(c.close / path[i]!.close));
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const sd = Math.sqrt(
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1),
    );
    const beyond4Sd = returns.filter((r) => Math.abs(r - mean) > 4 * sd).length;
    // A normal would give ~0.006% of samples beyond 4 sigma; expect clearly more.
    assert.ok(beyond4Sd > 0, "expected at least one 4-sigma move in a year of hours");
  });

  it("rejects a non-stationary GARCH specification", () => {
    assert.throws(
      () => paths.generatePath({ ...base, garchAlpha: 0.5, garchBeta: 0.6 }),
      /must be < 1/,
    );
  });
});

describe("runMonteCarlo", () => {
  const strategy: Omit<BacktestParams, "candles" | "funding"> = {
    symbol: "SOL",
    lpCapitalUsd: 1000,
    binStep: 20,
    rangeWidthPct: 5,
    maxBins: 70,
    strategy: "Spot",
    poolFeeRate: 0.002,
    feeTvlRatio24h: 0.02,
    feeReferenceRangePct: 5,
    rebalanceThresholdPct: 5,
    minRebalanceUsd: 25,
    takerFee: 0.00045,
    slippageBps: 3,
    liqBufferMult: 3,
    minLiqBufferPct: 25,
    maxLeverage: 10,
    marginTiers: [{ lowerBound: "0", maxLeverage: 20 }],
    venueMaxLeverage: 20,
    hedgeFundingMultiple: 4,
    outOfRangePolicy: "recenter",
    outOfRangeGraceMs: 30 * 60_000,
    recenterSwapFee: 0.001,
    onChainCostUsd: 0.5,
    autoTopUpMargin: true,
    marginTransferFee: 0.001,
    intrabar: true,
  };

  const run = (o: Partial<Parameters<typeof mc.runMonteCarlo>[0]> = {}) =>
    mc.runMonteCarlo({
      paths: 30,
      seed: 1,
      bars: 24 * 20,
      barMs: HOUR,
      startPrice: 200,
      annualVol: 0.8,
      fundingHourly: 0.0000125,
      strategy,
      ...o,
    });

  it("runs every path and orders the percentiles", () => {
    const s = run();
    assert.equal(s.paths, 30);
    assert.ok(s.returnPct.p5 <= s.returnPct.median);
    assert.ok(s.returnPct.median <= s.returnPct.p95);
    assert.ok(s.returnPct.min <= s.returnPct.p5);
    assert.ok(s.returnPct.max >= s.returnPct.p95);
  });

  it("is reproducible for a given seed", () => {
    assert.equal(run().returnPct.median, run().returnPct.median);
  });

  it("gives a different distribution for a different seed", () => {
    assert.notEqual(run().returnPct.median, run({ seed: 99 }).returnPct.median);
  });

  it("realises close to the requested volatility", () => {
    const s = run();
    assert.ok(Math.abs(s.annualVolRealised - 0.8) / 0.8 < 0.25);
  });

  it("costs more and wins less as volatility rises", () => {
    const calm = run({ annualVol: 0.3 });
    const wild = run({ annualVol: 1.5 });
    assert.ok(
      wild.deltaResidualUsd.median < calm.deltaResidualUsd.median,
      "higher volatility must cost more to hedge",
    );
    assert.ok(wild.winRatePct <= calm.winRatePct);
    assert.ok(
      wild.breakevenFeePctPerDay.median > calm.breakevenFeePctPerDay.median,
      "a wilder market needs richer fees to break even",
    );
  });

  it("improves with a richer fee assumption", () => {
    const lean = run({ strategy: { ...strategy, feeTvlRatio24h: 0.005 } });
    const rich = run({ strategy: { ...strategy, feeTvlRatio24h: 0.05 } });
    assert.ok(rich.returnPct.median > lean.returnPct.median);
    assert.ok(rich.winRatePct > lean.winRatePct);
  });

  it("shows slippage dominating at high turnover", () => {
    const tight = run({ strategy: { ...strategy, slippageBps: 1 } });
    const wide = run({ strategy: { ...strategy, slippageBps: 30 } });
    assert.ok(
      tight.returnPct.median > wide.returnPct.median,
      "a 30bps fill assumption must cost more than a 1bps one",
    );
  });

  it("keeps the worst path for inspection", () => {
    const s = run();
    assert.ok(s.worst.netReturnPct <= s.returnPct.p5 + 1e-9);
    assert.ok(s.worst.equityCurve.length > 0);
  });

  it("renders a report naming the key columns", () => {
    const text = mc.formatMonteCarloReport(run());
    assert.match(text, /Monte Carlo/);
    assert.match(text, /Return on capital/);
    assert.match(text, /Breakeven fee\/day/);
    assert.match(text, /Profitable paths/);
    assert.match(text, /p5/);
  });

  it("flags paths where the hedge could not be placed", () => {
    const starved = run({
      strategy: { ...strategy, hedgeFundingMultiple: 0.5, autoTopUpMargin: false },
    });
    assert.ok(starved.pathsWithFailedHedge > 0);
    assert.match(mc.formatMonteCarloReport(starved), /not delta neutral/);
  });
});
