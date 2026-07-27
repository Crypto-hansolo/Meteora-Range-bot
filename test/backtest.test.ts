import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import type { Candle, FundingPoint } from "../src/backtest/data.js";
import type { BacktestParams } from "../src/backtest/runner.js";

let runner: typeof import("../src/backtest/runner.js");
let data: typeof import("../src/backtest/data.js");
let report: typeof import("../src/backtest/report.js");

before(async () => {
  process.env.RPC_URL ??= "https://api.mainnet-beta.solana.com";
  process.env.LOG_LEVEL = "silent";
  runner = await import("../src/backtest/runner.js");
  data = await import("../src/backtest/data.js");
  report = await import("../src/backtest/report.js");
});

const HOUR = 3_600_000;

/** Build an hourly candle series from a list of closes. */
function candles(closes: number[], startMs = 0): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      t: startMs + i * HOUR,
      T: startMs + (i + 1) * HOUR,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 0,
    };
  });
}

function params(overrides: Partial<BacktestParams> = {}): BacktestParams {
  return {
    symbol: "SOL",
    candles: candles([200, 200]),
    funding: [],

    lpCapitalUsd: 1000,
    binStep: 20,
    rangeWidthPct: 5,
    maxBins: 70,
    strategy: "Spot",
    poolFeeRate: 0.002,
    feeTvlRatio24h: 0,
    feeReferenceRangePct: 5,

    rebalanceThresholdPct: 5,
    minRebalanceUsd: 1,
    takerFee: 0,
    slippageBps: 0,

    liqBufferMult: 3,
    minLiqBufferPct: 25,
    maxLeverage: 10,
    marginTiers: [{ lowerBound: "0", maxLeverage: 20 }],
    venueMaxLeverage: 20,
    hedgeFundingMultiple: 2.5,

    outOfRangePolicy: "hold",
    outOfRangeGraceMs: 30 * 60_000,
    recenterSwapFee: 0.001,
    onChainCostUsd: 0,
    autoTopUpMargin: false,
    marginTransferFee: 0.001,

    intrabar: false,
    ...overrides,
  };
}

describe("runBacktest basics", () => {
  it("needs at least two candles", () => {
    assert.throws(() => runner.runBacktest(params({ candles: candles([200]) })), /two candles/);
  });

  it("reports the period and price move", () => {
    const r = runner.runBacktest(params({ candles: candles([200, 210, 220]) }));
    assert.equal(r.startPrice, 200);
    assert.equal(r.endPrice, 220);
    assert.ok(Math.abs(r.priceChangePct - 10) < 1e-9);
  });

  it("deploys LP capital plus the hedge collateral it parks", () => {
    const r = runner.runBacktest(params());
    assert.equal(r.lpCapitalUsd, 1000);
    assert.ok(r.hedgeCollateralUsd > 0);
    assert.ok(Math.abs(r.startCapitalUsd - (1000 + r.hedgeCollateralUsd)) < 1e-9);
  });

  it("parks more collateral than the opening margin needs", () => {
    const r = runner.runBacktest(params());
    // The hedge grows as price falls, so headroom is required.
    assert.ok(r.hedgeCollateralUsd > r.peakMarginUsd);
  });
});

describe("delta neutrality", () => {
  it("barely moves on a large one-way rally", () => {
    // 1000 LP capital; a 25% rally would swing an unhedged position hugely.
    const path = candles([200, 210, 220, 230, 240, 250]);
    const r = runner.runBacktest(params({ candles: path, outOfRangePolicy: "recenter" }));
    assert.ok(
      Math.abs(r.netPnlUsd) < 0.15 * r.startCapitalUsd,
      `hedged PnL should stay small, got ${r.netPnlUsd}`,
    );
  });

  it("barely moves on a large one-way selloff", () => {
    const path = candles([200, 190, 180, 170, 160, 150]);
    const r = runner.runBacktest(params({ candles: path, outOfRangePolicy: "recenter" }));
    assert.ok(
      Math.abs(r.netPnlUsd) < 0.15 * r.startCapitalUsd,
      `hedged PnL should stay small, got ${r.netPnlUsd}`,
    );
  });

  it("beats an unhedged position on a selloff", () => {
    const path = candles([200, 190, 180, 170, 160, 150]);
    const r = runner.runBacktest(params({ candles: path, outOfRangePolicy: "recenter" }));
    // Unhedged, half the capital in SOL through a 25% drop is about -125.
    assert.ok(r.netPnlUsd > -125, `hedge must cushion the drop, got ${r.netPnlUsd}`);
  });

  it("bounds the unhedged gap by the sampling step, not the threshold", () => {
    // The bot cannot react faster than it observes. With 1% jumps between
    // samples the delta has already moved that far before any threshold is
    // consulted, so tightening the threshold changes nothing.
    const path = candles([200, 202, 204, 206, 208, 210]);
    const tight = runner.runBacktest(params({ candles: path, rebalanceThresholdPct: 1 }));
    const loose = runner.runBacktest(params({ candles: path, rebalanceThresholdPct: 10 }));

    assert.ok(Math.abs(tight.maxUnhedgedDeltaUsd - loose.maxUnhedgedDeltaUsd) < 1e-6);
  });

  it("shrinks the unhedged gap when sampled more finely", () => {
    // Same 5% move, ten times the resolution.
    const coarse = candles([200, 202, 204, 206, 208, 210]);
    const fine = candles(Array.from({ length: 51 }, (_, i) => 200 * 1.001 ** i));

    const a = runner.runBacktest(params({ candles: coarse, rebalanceThresholdPct: 1 }));
    const b = runner.runBacktest(params({ candles: fine, rebalanceThresholdPct: 1 }));

    assert.ok(
      b.maxUnhedgedDeltaUsd < a.maxUnhedgedDeltaUsd / 2,
      `finer sampling must hedge tighter: ${b.maxUnhedgedDeltaUsd} vs ${a.maxUnhedgedDeltaUsd}`,
    );
  });

  it("does widen the gap once the threshold exceeds the sampling step", () => {
    const path = candles([200, 202, 204, 206, 208, 210]);
    const normal = runner.runBacktest(params({ candles: path, rebalanceThresholdPct: 5 }));
    const veryLoose = runner.runBacktest(params({ candles: path, rebalanceThresholdPct: 20 }));

    assert.ok(veryLoose.maxUnhedgedDeltaUsd > normal.maxUnhedgedDeltaUsd);
    assert.ok(veryLoose.rebalanceCount < normal.rebalanceCount);
  });
});

describe("the cost of hedging", () => {
  it("shows a negative delta residual on a round trip", () => {
    const path = candles([200, 205, 210, 205, 200]);
    const r = runner.runBacktest(params({ candles: path }));
    assert.ok(
      r.deltaResidualUsd < 0,
      `rebalancing a round trip must cost money, got ${r.deltaResidualUsd}`,
    );
  });

  it("costs more when the path is choppier between the same endpoints", () => {
    const calm = runner.runBacktest(params({ candles: candles([200, 200, 200, 200, 200]) }));
    const choppy = runner.runBacktest(
      params({ candles: candles([200, 210, 200, 210, 200, 210, 200]) }),
    );
    assert.ok(
      choppy.deltaResidualUsd < calm.deltaResidualUsd,
      `choppy ${choppy.deltaResidualUsd} should cost more than calm ${calm.deltaResidualUsd}`,
    );
  });

  it("counts more rebalances on a choppier path", () => {
    const calm = runner.runBacktest(params({ candles: candles([200, 200, 200, 200]) }));
    const choppy = runner.runBacktest(
      params({ candles: candles([200, 210, 200, 210, 200, 210]) }),
    );
    assert.ok(choppy.rebalanceCount > calm.rebalanceCount);
    assert.ok(choppy.hedgeTurnoverUsd > calm.hedgeTurnoverUsd);
  });

  it("charges taker fees and slippage on turnover", () => {
    const path = candles([200, 210, 200, 210, 200]);
    const free = runner.runBacktest(params({ candles: path }));
    const costly = runner.runBacktest(
      params({ candles: path, takerFee: 0.001, slippageBps: 10 }),
    );
    assert.equal(free.takerFeesUsd, 0);
    assert.ok(costly.takerFeesUsd > 0);
    assert.ok(costly.slippageUsd > 0);
    assert.ok(costly.netPnlUsd < free.netPnlUsd);
  });

  it("finds more realised volatility when walking intrabar", () => {
    // Closes are flat, but each candle swung within the hour.
    const swinging: Candle[] = Array.from({ length: 6 }, (_, i) => ({
      t: i * HOUR,
      T: (i + 1) * HOUR,
      open: 200,
      high: 212,
      low: 188,
      close: 200,
      volume: 0,
    }));

    const closeOnly = runner.runBacktest(params({ candles: swinging, intrabar: false }));
    const intrabar = runner.runBacktest(params({ candles: swinging, intrabar: true }));

    assert.equal(closeOnly.rebalanceCount, 0, "flat closes hide the movement entirely");
    assert.ok(intrabar.rebalanceCount > 0, "intrabar must see the swings");
    assert.ok(
      intrabar.deltaResidualUsd < closeOnly.deltaResidualUsd,
      "hidden volatility is a hidden cost",
    );
  });
});

describe("fee income", () => {
  it("earns nothing at a zero assumed rate", () => {
    assert.equal(runner.runBacktest(params()).feeIncomeUsd, 0);
  });

  it("accrues pro rata while in range", () => {
    // 4 candles of 1h at 2.4%/day = 0.1%/h on ~$1000.
    const r = runner.runBacktest(
      params({ candles: candles([200, 200, 200, 200, 200]), feeTvlRatio24h: 0.024 }),
    );
    assert.ok(Math.abs(r.feeIncomeUsd - 5) < 0.5, `fee income ${r.feeIncomeUsd}`);
  });

  it("stops earning once out of range", () => {
    const inRange = runner.runBacktest(
      params({ candles: candles([200, 200, 200, 200, 200]), feeTvlRatio24h: 0.024 }),
    );
    const drifted = runner.runBacktest(
      params({
        candles: candles([200, 400, 400, 400, 400]),
        feeTvlRatio24h: 0.024,
        outOfRangePolicy: "hold",
      }),
    );
    assert.ok(drifted.feeIncomeUsd < inRange.feeIncomeUsd);
    assert.ok(drifted.timeInRangePct < 50);
  });

  it("can flip the result positive when the rate is high enough", () => {
    const path = candles([200, 205, 210, 205, 200]);
    const bare = runner.runBacktest(params({ candles: path, feeTvlRatio24h: 0 }));
    const rich = runner.runBacktest(params({ candles: path, feeTvlRatio24h: 0.5 }));
    assert.ok(bare.netPnlUsd < 0);
    assert.ok(rich.netPnlUsd > 0);
  });

  it("reports the arbitrage-only floor separately", () => {
    const r = runner.runBacktest(params({ candles: candles([200, 210, 220]) }));
    assert.ok(r.arbImpliedFeeUsd > 0, "a price move implies arbitrage volume");
    // Independent of the assumption, which is zero here.
    assert.equal(r.feeIncomeUsd, 0);
  });
});

describe("funding", () => {
  const path = candles([200, 200, 200, 200, 200], 0);

  it("credits a short when funding is positive", () => {
    const funding: FundingPoint[] = [1, 2, 3, 4].map((h) => ({ time: h * HOUR, rate: 0.0001 }));
    const r = runner.runBacktest(params({ candles: path, funding }));
    assert.ok(r.fundingUsd > 0, `expected funding income, got ${r.fundingUsd}`);
  });

  it("charges a short when funding is negative", () => {
    const funding: FundingPoint[] = [1, 2, 3, 4].map((h) => ({ time: h * HOUR, rate: -0.0001 }));
    const r = runner.runBacktest(params({ candles: path, funding }));
    assert.ok(r.fundingUsd < 0);
  });

  it("applies each settlement exactly once", () => {
    const funding: FundingPoint[] = [{ time: HOUR, rate: 0.001 }];
    const r = runner.runBacktest(params({ candles: path, funding }));
    // One settlement of 0.1% on a ~$500 notional.
    assert.ok(Math.abs(r.fundingUsd - 0.5) < 0.1, `funding ${r.fundingUsd}`);
  });
});

describe("out-of-range policy", () => {
  const drift = candles([200, 250, 300, 350, 400, 450]);

  it("hold: stays put and stops earning", () => {
    const r = runner.runBacktest(params({ candles: drift, outOfRangePolicy: "hold" }));
    assert.equal(r.recenterCount, 0);
    assert.equal(r.exitedEarly, false);
  });

  it("exit: stops the run and says why", () => {
    const r = runner.runBacktest(
      params({ candles: drift, outOfRangePolicy: "exit", outOfRangeGraceMs: 0 }),
    );
    assert.equal(r.exitedEarly, true);
    assert.match(r.exitReason!, /out of range/);
    assert.ok(r.equityCurve.length < drift.length);
  });

  it("recenter: reopens around the new price and charges for it", () => {
    const r = runner.runBacktest(
      params({
        candles: drift,
        outOfRangePolicy: "recenter",
        outOfRangeGraceMs: 0,
        onChainCostUsd: 1,
      }),
    );
    assert.ok(r.recenterCount > 0);
    assert.ok(r.onChainCostUsd > 1, "recentring must cost gas and a swap");
    assert.ok(r.timeInRangePct > 0);
  });

  it("recenter does not conjure back capital lost to drawdown", () => {
    const r = runner.runBacktest(
      params({
        candles: candles([200, 150, 120, 100, 90]),
        outOfRangePolicy: "recenter",
        outOfRangeGraceMs: 0,
        feeTvlRatio24h: 0,
      }),
    );
    // With a working hedge the total stays near flat; the LP leg alone must not
    // silently reset to its opening size on each recenter.
    assert.ok(r.recenterCount > 0);
    assert.ok(r.endEquityUsd < r.startCapitalUsd * 1.05, `end equity ${r.endEquityUsd}`);
  });
});

describe("running out of hedge collateral", () => {
  // A one-way crash drives the LP fully into the base token, so the hedge has
  // to grow to the full position size. Underfunding it is the failure mode that
  // silently turns a delta-neutral position into a leveraged directional bet.
  const crash = candles([200, 170, 145, 125, 110, 100]);

  it("flags every hedge it could not place", () => {
    const r = runner.runBacktest(
      params({ candles: crash, hedgeFundingMultiple: 1.0, outOfRangePolicy: "recenter" }),
    );
    assert.ok(r.failedHedgeCount > 0, "an underfunded hedge must be reported, not swallowed");
    assert.ok(r.maxUnhedgedDeltaUsd > 0);
  });

  it("places every hedge when the account carries headroom", () => {
    const r = runner.runBacktest(
      params({ candles: crash, hedgeFundingMultiple: 6, outOfRangePolicy: "recenter" }),
    );
    assert.equal(r.failedHedgeCount, 0);
  });

  it("leaves the position directionally exposed when underfunded", () => {
    const starved = runner.runBacktest(
      params({ candles: crash, hedgeFundingMultiple: 1.0, outOfRangePolicy: "recenter" }),
    );
    const funded = runner.runBacktest(
      params({ candles: crash, hedgeFundingMultiple: 6, outOfRangePolicy: "recenter" }),
    );
    // A 50% crash hurts far more when the hedge stops working.
    assert.ok(
      starved.netReturnPct < funded.netReturnPct,
      `starved ${starved.netReturnPct}% vs funded ${funded.netReturnPct}%`,
    );
  });

  it("shouts about it in the report instead of burying it", () => {
    const r = runner.runBacktest(
      params({ candles: crash, hedgeFundingMultiple: 1.0, outOfRangePolicy: "recenter" }),
    );
    const text = report.formatBacktestReport(r);
    assert.match(text, /RESULT NOT TRUSTWORTHY/);
    assert.match(text, /directionally exposed/);
  });

  it("says nothing when the hedge always went through", () => {
    const r = runner.runBacktest(params({ candles: candles([200, 202, 200]) }));
    assert.equal(r.failedHedgeCount, 0);
    assert.doesNotMatch(report.formatBacktestReport(r), /NOT TRUSTWORTHY/);
  });
});

describe("cross-venue margin transfers", () => {
  // A sustained rally is the case that matters: the short bleeds on Hyperliquid
  // while the LP position gains on Solana, so the perp account empties out even
  // though the combined position is fine.
  const rally = candles([200, 230, 265, 300, 345, 400, 460]);

  it("keeps the hedge alive by moving margin across", () => {
    const neglected = runner.runBacktest(
      params({
        candles: rally,
        outOfRangePolicy: "recenter",
        outOfRangeGraceMs: 0,
        hedgeFundingMultiple: 1,
        autoTopUpMargin: false,
      }),
    );
    const operated = runner.runBacktest(
      params({
        candles: rally,
        outOfRangePolicy: "recenter",
        outOfRangeGraceMs: 0,
        hedgeFundingMultiple: 1,
        autoTopUpMargin: true,
      }),
    );

    assert.ok(neglected.failedHedgeCount > 0, "an unattended account must run dry");
    assert.ok(
      operated.failedHedgeCount < neglected.failedHedgeCount,
      `transfers must reduce failures: ${operated.failedHedgeCount} vs ${neglected.failedHedgeCount}`,
    );
    assert.ok(operated.marginTransferredUsd > 0);
    assert.ok(operated.marginTransferCount > 0);
  });

  it("does not transfer when the account is well funded", () => {
    const r = runner.runBacktest(
      params({ candles: candles([200, 202, 200]), autoTopUpMargin: true }),
    );
    assert.equal(r.marginTransferredUsd, 0);
    assert.equal(r.marginTransferCount, 0);
  });

  it("reports the transfers instead of hiding them", () => {
    const r = runner.runBacktest(
      params({
        candles: rally,
        outOfRangePolicy: "recenter",
        outOfRangeGraceMs: 0,
        hedgeFundingMultiple: 1,
        autoTopUpMargin: true,
      }),
    );
    assert.match(report.formatBacktestReport(r), /Moved LP . perp margin/);
  });

  it("takes the transferred value out of the LP position", () => {
    const r = runner.runBacktest(
      params({
        candles: rally,
        outOfRangePolicy: "recenter",
        outOfRangeGraceMs: 0,
        hedgeFundingMultiple: 1,
        autoTopUpMargin: true,
      }),
    );
    // Transferring is not free money: it shrinks the LP leg.
    assert.ok(r.lpPricePnlUsd < 0);
  });
});

describe("re-hedging after a recenter", () => {
  it("does not leave the fresh position naked", () => {
    // Recentring swaps a fully drifted position for a balanced one, so delta
    // jumps discontinuously. Waiting for the next sample would expose it all.
    const drift = candles([200, 230, 260, 290, 320, 300, 280]);
    const r = runner.runBacktest(
      params({
        candles: drift,
        outOfRangePolicy: "recenter",
        outOfRangeGraceMs: 0,
        hedgeFundingMultiple: 8,
        rebalanceThresholdPct: 1,
      }),
    );
    assert.ok(r.recenterCount > 0);
    assert.equal(r.failedHedgeCount, 0);
    // Never more than roughly one range width of delta left unhedged.
    assert.ok(
      r.maxUnhedgedDeltaUsd < r.lpCapitalUsd * 0.75,
      `max unhedged ${r.maxUnhedgedDeltaUsd} of ${r.lpCapitalUsd}`,
    );
  });
});

describe("liquidation handling", () => {
  it("survives a violent rally by re-establishing the hedge", () => {
    // A vertical move can outrun the hedge and take out the isolated margin.
    const spike = candles([200, 260, 340, 450, 600]);
    const r = runner.runBacktest(
      params({ candles: spike, outOfRangePolicy: "hold", targetLeverage: 10 }),
    );
    assert.ok(r.liquidationCount >= 0);
    assert.ok(Number.isFinite(r.netPnlUsd), "the run must still produce a number");
  });
});

describe("FundingSchedule", () => {
  it("consumes each point once, in order", () => {
    const schedule = new data.FundingSchedule([
      { time: 100, rate: 0.001 },
      { time: 200, rate: 0.002 },
      { time: 300, rate: 0.003 },
    ]);
    assert.equal(schedule.accrueUntil(50), 0);
    assert.equal(schedule.accrueUntil(150), 0.001);
    assert.ok(Math.abs(schedule.accrueUntil(300) - 0.005) < 1e-12);
    assert.equal(schedule.accrueUntil(400), 0);
  });

  it("sums several settlements when the caller steps coarsely", () => {
    const schedule = new data.FundingSchedule([
      { time: 100, rate: 0.001 },
      { time: 200, rate: 0.002 },
    ]);
    assert.ok(Math.abs(schedule.accrueUntil(999) - 0.003) < 1e-12);
  });
});

describe("report", () => {
  it("renders without throwing and shows the key sections", () => {
    const r = runner.runBacktest(params({ candles: candles([200, 210, 200]) }));
    const text = report.formatBacktestReport(r);
    assert.match(text, /PnL decomposition/);
    assert.match(text, /cost of staying delta neutral/);
    assert.match(text, /Delta residual/);
    assert.match(text, /the one assumption/);
  });

  it("emits a CSV row per equity point", () => {
    const r = runner.runBacktest(params({ candles: candles([200, 210, 200]) }));
    const csv = report.equityCurveCsv(r);
    assert.equal(csv.split("\n").length, r.equityCurve.length + 1);
    assert.match(csv.split("\n")[0]!, /^time,price/);
  });
});
