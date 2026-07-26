import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  decideRebalance,
  effectiveLeverage,
  estimateRangeComposition,
  estimateReturn,
  leverageForLiquidationBuffer,
  liquidationBufferForLeverage,
  liquidationPriceShort,
  maintenanceMarginFraction,
  planHedgeLeg,
  type HedgeSizingPolicy,
  type MarginTier,
} from "../src/math/deltaNeutral.js";

const SOL_TIERS: MarginTier[] = [
  { lowerBound: "0", maxLeverage: 20 },
  { lowerBound: "20000000", maxLeverage: 10 },
];

describe("maintenanceMarginFraction", () => {
  it("uses half the initial margin at the tier's max leverage", () => {
    assert.equal(maintenanceMarginFraction(SOL_TIERS, 1_000), 1 / 40);
  });

  it("picks the tier by notional", () => {
    assert.equal(maintenanceMarginFraction(SOL_TIERS, 25_000_000), 1 / 20);
  });

  it("stays on the lowest tier below the first bound", () => {
    assert.equal(maintenanceMarginFraction(SOL_TIERS, 0), 1 / 40);
  });

  it("rejects an empty tier table", () => {
    assert.throws(() => maintenanceMarginFraction([], 100), /no margin tiers/);
  });
});

describe("liquidationPriceShort", () => {
  it("matches the closed form (C/S + P0) / (1 + mmf)", () => {
    // 10 SOL short at $200 => $2000 notional, 4x leverage => $500 margin.
    const px = liquidationPriceShort({
      size: 10,
      entryPx: 200,
      isolatedMarginUsd: 500,
      mmf: 0.025,
    });
    assert.ok(Math.abs(px - (500 / 10 + 200) / 1.025) < 1e-9);
    assert.ok(px > 200, "a short liquidates above entry");
  });

  it("agrees with Hyperliquid's margin-available formulation", () => {
    const size = 7;
    const entryPx = 143.21;
    const isolatedMarginUsd = 400;
    const mmf = 1 / 40;

    const ours = liquidationPriceShort({ size, entryPx, isolatedMarginUsd, mmf });
    // HL: liq = P - side*marginAvailable/|S|/(1 - mmf*side), side = -1 for shorts,
    // marginAvailable(isolated) = isolatedMargin - maintenanceMarginRequired.
    const marginAvailable = isolatedMarginUsd - size * entryPx * mmf;
    const theirs = entryPx + marginAvailable / size / (1 + mmf);
    assert.ok(Math.abs(ours - theirs) < 1e-9);
  });

  it("treats a zero-size position as unliquidatable", () => {
    assert.equal(
      liquidationPriceShort({ size: 0, entryPx: 200, isolatedMarginUsd: 0, mmf: 0.025 }),
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("leverageForLiquidationBuffer", () => {
  it("round-trips against liquidationBufferForLeverage", () => {
    const mmf = 0.025;
    for (const buffer of [0.1, 0.25, 0.5, 1]) {
      const lev = leverageForLiquidationBuffer(buffer, mmf);
      assert.ok(Math.abs(liquidationBufferForLeverage(lev, mmf) - buffer) < 1e-12);
    }
  });

  it("produces the documented 25%-buffer example", () => {
    // 1 / (0.25 * 1.025 + 0.025) = 3.555...
    const lev = leverageForLiquidationBuffer(0.25, 0.025);
    assert.ok(Math.abs(lev - 3.5555555555555554) < 1e-9);
  });

  it("yields the buffer it promises when fed back into the price formula", () => {
    const mmf = 0.025;
    const entryPx = 200;
    const size = 10;
    const lev = leverageForLiquidationBuffer(0.3, mmf);
    const liq = liquidationPriceShort({
      size,
      entryPx,
      isolatedMarginUsd: (size * entryPx) / lev,
      mmf,
    });
    assert.ok(Math.abs(liq / entryPx - 1 - 0.3) < 1e-12);
  });

  it("rejects a non-positive buffer", () => {
    assert.throws(() => leverageForLiquidationBuffer(0, 0.025), /must be > 0/);
  });
});

describe("estimateRangeComposition", () => {
  it("splits roughly 50/50 for a symmetric range", () => {
    const c = estimateRangeComposition({ activeBinId: 100, minBinId: 90, maxBinId: 110 });
    assert.equal(c.valueShareX, 0.5);
    assert.equal(c.valueShareY, 0.5);
    assert.equal(c.binCount, 21);
  });

  it("is all quote when price sits at the range top", () => {
    const c = estimateRangeComposition({ activeBinId: 110, minBinId: 90, maxBinId: 110 });
    assert.ok(c.valueShareX < 0.03, `expected almost no X exposure, got ${c.valueShareX}`);
  });

  it("is all base when price sits at the range bottom", () => {
    const c = estimateRangeComposition({ activeBinId: 90, minBinId: 90, maxBinId: 110 });
    assert.ok(c.valueShareX > 0.97, `expected almost full X exposure, got ${c.valueShareX}`);
  });

  it("goes fully one-sided when price falls below the range", () => {
    const c = estimateRangeComposition({ activeBinId: 80, minBinId: 90, maxBinId: 110 });
    assert.equal(c.valueShareX, 1);
    assert.equal(c.valueShareY, 0);
  });

  it("goes fully quote-sided when price rises above the range", () => {
    const c = estimateRangeComposition({ activeBinId: 130, minBinId: 90, maxBinId: 110 });
    assert.equal(c.valueShareX, 0);
    assert.equal(c.valueShareY, 1);
  });

  it("always sums the two shares to 1", () => {
    for (const active of [70, 90, 100, 110, 130]) {
      const c = estimateRangeComposition({ activeBinId: active, minBinId: 90, maxBinId: 110 });
      assert.ok(Math.abs(c.valueShareX + c.valueShareY - 1) < 1e-12);
    }
  });
});

describe("planHedgeLeg", () => {
  const policy: HedgeSizingPolicy = {
    liqBufferMult: 3,
    minLiqBuffer: 0.25,
    maxLeverage: 10,
    upsideRangeDistance: 0.05,
  };

  const req = {
    symbol: "SOL",
    deltaUnits: 2.5,
    price: 200,
    venueMaxLeverage: 20,
    marginTiers: SOL_TIERS,
  };

  it("shorts exactly the LP delta", () => {
    const plan = planHedgeLeg(req, policy);
    assert.equal(plan.size, 2.5);
    assert.equal(plan.notionalUsd, 500);
  });

  it("derives leverage from the liquidation buffer", () => {
    const plan = planHedgeLeg(req, policy);
    // required buffer = max(0.05*3, 0.25) = 0.25 -> 3.55x -> floored to 3x
    assert.equal(plan.leverage, 3);
    assert.equal(plan.leverageBoundBy, "liquidation-buffer");
    assert.ok(Math.abs(plan.collateralUsd - 500 / 3) < 1e-9);
  });

  it("keeps the liquidation price clear of the range top", () => {
    const plan = planHedgeLeg(req, policy);
    assert.ok(
      plan.liquidationBuffer > policy.upsideRangeDistance,
      "liquidation must sit outside the LP range",
    );
    assert.equal(plan.warnings.length, 0);
  });

  it("floors leverage so the realised buffer beats the required one", () => {
    const plan = planHedgeLeg(req, policy);
    assert.ok(plan.liquidationBuffer >= 0.25);
  });

  it("respects the config leverage cap", () => {
    const plan = planHedgeLeg(req, { ...policy, minLiqBuffer: 0.001, maxLeverage: 5 });
    assert.equal(plan.leverage, 5);
    assert.equal(plan.leverageBoundBy, "config-max");
  });

  it("respects the venue leverage cap", () => {
    const plan = planHedgeLeg(
      { ...req, venueMaxLeverage: 3 },
      { ...policy, minLiqBuffer: 0.001, maxLeverage: 50 },
    );
    assert.equal(plan.leverage, 3);
    assert.equal(plan.leverageBoundBy, "venue-max");
  });

  it("honours an explicit leverage override", () => {
    const plan = planHedgeLeg(req, { ...policy, explicitLeverage: 2 });
    assert.equal(plan.leverage, 2);
    assert.equal(plan.leverageBoundBy, "explicit");
  });

  it("warns when the cap pushes liquidation inside the LP range", () => {
    const plan = planHedgeLeg(req, {
      ...policy,
      explicitLeverage: 20,
      upsideRangeDistance: 0.5,
    });
    assert.ok(plan.liquidationBuffer < 0.5);
    assert.ok(
      plan.warnings.some((w) => w.includes("inside the LP range")),
      `expected an in-range liquidation warning, got ${JSON.stringify(plan.warnings)}`,
    );
  });

  it("widens the required buffer for wide ranges", () => {
    const narrow = planHedgeLeg(req, { ...policy, upsideRangeDistance: 0.05 });
    const wide = planHedgeLeg(req, { ...policy, upsideRangeDistance: 0.2 });
    assert.ok(
      wide.leverage < narrow.leverage,
      "a wider range must lead to a more conservative hedge",
    );
  });
});

describe("decideRebalance", () => {
  const base = {
    targetDeltaUnits: 10,
    price: 200,
    thresholdPct: 5,
    minNotionalUsd: 25,
  };

  it("holds still when the hedge already matches the delta", () => {
    const d = decideRebalance({ ...base, currentSzi: -10 });
    assert.equal(d.shouldRebalance, false);
    assert.equal(d.deltaSize, 0);
  });

  it("sells more when the short is too small", () => {
    const d = decideRebalance({ ...base, currentSzi: -8 });
    assert.equal(d.shouldRebalance, true);
    assert.equal(d.deltaSize, 2); // positive => sell
    assert.equal(d.deltaNotionalUsd, 400);
  });

  it("buys back when the short is too large", () => {
    const d = decideRebalance({ ...base, currentSzi: -12 });
    assert.equal(d.shouldRebalance, true);
    assert.equal(d.deltaSize, -2); // negative => buy
  });

  it("ignores drift below the percentage threshold", () => {
    // target notional 2000, threshold 5% = 100 USD; drift 0.4 SOL = 80 USD
    const d = decideRebalance({ ...base, currentSzi: -9.6 });
    assert.equal(d.shouldRebalance, false);
    assert.equal(d.thresholdUsd, 100);
  });

  it("uses the absolute floor when the position is tiny", () => {
    const d = decideRebalance({ ...base, targetDeltaUnits: 0.1, currentSzi: -0.05 });
    assert.equal(d.thresholdUsd, 25); // 5% of $20 = $1, floor wins
    assert.equal(d.shouldRebalance, false);
  });

  it("opens the full short from flat", () => {
    const d = decideRebalance({ ...base, currentSzi: 0 });
    assert.equal(d.shouldRebalance, true);
    assert.equal(d.deltaSize, 10);
  });

  it("closes the short entirely once the delta is gone", () => {
    const d = decideRebalance({ ...base, targetDeltaUnits: 0, currentSzi: -10 });
    assert.equal(d.shouldRebalance, true);
    assert.equal(d.deltaSize, -10);
  });
});

describe("effectiveLeverage", () => {
  it("is notional over margin", () => {
    assert.equal(effectiveLeverage(1000, 250), 4);
  });

  it("treats zero margin as infinite leverage", () => {
    assert.equal(effectiveLeverage(1000, 0), Number.POSITIVE_INFINITY);
  });
});

describe("estimateReturn", () => {
  it("annualises the fee/TVL ratio", () => {
    const r = estimateReturn({
      feeTvlRatio24h: 0.01,
      lpCapitalUsd: 1000,
      hedgeCollateralUsd: 0,
      hedgeNotionalUsd: 500,
      fundingRateHourly: 0,
    });
    assert.equal(r.lpFeeApr, 3.65);
    assert.equal(r.netAprOnTotalCapital, 3.65);
  });

  it("dilutes the return by hedge collateral", () => {
    const r = estimateReturn({
      feeTvlRatio24h: 0.01,
      lpCapitalUsd: 1000,
      hedgeCollateralUsd: 1000,
      hedgeNotionalUsd: 500,
      fundingRateHourly: 0,
    });
    // Same fees, twice the capital.
    assert.ok(Math.abs(r.netAprOnTotalCapital - 1.825) < 1e-12);
  });

  it("credits a short with positive funding", () => {
    const withFunding = estimateReturn({
      feeTvlRatio24h: 0.01,
      lpCapitalUsd: 1000,
      hedgeCollateralUsd: 200,
      hedgeNotionalUsd: 500,
      fundingRateHourly: 0.00001,
    });
    const without = estimateReturn({
      feeTvlRatio24h: 0.01,
      lpCapitalUsd: 1000,
      hedgeCollateralUsd: 200,
      hedgeNotionalUsd: 500,
      fundingRateHourly: 0,
    });
    assert.ok(withFunding.netAprOnTotalCapital > without.netAprOnTotalCapital);
  });

  it("charges a short for negative funding", () => {
    const r = estimateReturn({
      feeTvlRatio24h: 0,
      lpCapitalUsd: 1000,
      hedgeCollateralUsd: 200,
      hedgeNotionalUsd: 500,
      fundingRateHourly: -0.0001,
    });
    assert.ok(r.netAprOnTotalCapital < 0);
  });
});
