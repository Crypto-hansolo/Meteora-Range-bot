import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  binPriceRatio,
  binsForPriceWidth,
  isInRange,
  planRange,
  priceWidthForBins,
} from "../src/math/bins.js";

describe("binPriceRatio", () => {
  it("converts basis points to a multiplier", () => {
    assert.equal(binPriceRatio(20), 1.002);
    assert.equal(binPriceRatio(100), 1.01);
  });

  it("rejects a non-positive bin step", () => {
    assert.throws(() => binPriceRatio(0), /must be > 0/);
  });
});

describe("binsForPriceWidth", () => {
  it("round-trips with priceWidthForBins", () => {
    for (const binStep of [1, 10, 20, 100, 200]) {
      const bins = binsForPriceWidth(binStep, 5);
      const width = priceWidthForBins(binStep, bins);
      assert.ok(Math.abs(width - 0.05) < 0.05, `binStep ${binStep}: width ${width}`);
    }
  });

  it("needs about 25 bins for ±5% at binStep 20", () => {
    // ln(1.05)/ln(1.002) = 24.4
    assert.equal(binsForPriceWidth(20, 5), 24);
  });

  it("never returns fewer than one bin", () => {
    assert.equal(binsForPriceWidth(200, 0.01), 1);
  });
});

describe("planRange", () => {
  it("centres a symmetric range on the active bin", () => {
    const plan = planRange({ activeBinId: 1000, binStep: 20, widthPct: 5, maxBins: 70 });
    assert.equal(plan.minBinId, 1000 - 24);
    assert.equal(plan.maxBinId, 1000 + 24);
    assert.equal(plan.binCount, 49);
    assert.equal(plan.truncated, false);
  });

  it("lands close to the requested width", () => {
    const plan = planRange({ activeBinId: 0, binStep: 20, widthPct: 5, maxBins: 70 });
    assert.ok(Math.abs(plan.upsideDistance - 0.05) < 0.005);
    assert.ok(Math.abs(plan.downsideDistance - 0.048) < 0.005);
  });

  it("is symmetric in log price, so upside exceeds downside", () => {
    const plan = planRange({ activeBinId: 0, binStep: 20, widthPct: 10, maxBins: 200 });
    assert.ok(plan.upsideDistance > plan.downsideDistance);
    assert.ok(Math.abs(plan.upperPriceRatio * plan.lowerPriceRatio - 1) < 1e-12);
  });

  it("truncates when maxBins is the binding constraint", () => {
    const plan = planRange({ activeBinId: 0, binStep: 1, widthPct: 50, maxBins: 70 });
    assert.equal(plan.truncated, true);
    assert.equal(plan.binCount, 69); // 34 per side + active
    assert.ok(plan.upsideDistance < 0.5);
  });

  it("degenerates to a single bin when maxBins is 1", () => {
    const plan = planRange({ activeBinId: 42, binStep: 20, widthPct: 5, maxBins: 1 });
    assert.equal(plan.minBinId, 42);
    assert.equal(plan.maxBinId, 42);
    assert.equal(plan.upsideDistance, 0);
  });

  it("handles negative active bin ids", () => {
    const plan = planRange({ activeBinId: -500, binStep: 20, widthPct: 5, maxBins: 70 });
    assert.equal(plan.minBinId, -524);
    assert.equal(plan.maxBinId, -476);
  });
});

describe("isInRange", () => {
  it("is inclusive on both bounds", () => {
    assert.equal(isInRange(90, 90, 110), true);
    assert.equal(isInRange(110, 90, 110), true);
    assert.equal(isInRange(89, 90, 110), false);
    assert.equal(isInRange(111, 90, 110), false);
  });
});
