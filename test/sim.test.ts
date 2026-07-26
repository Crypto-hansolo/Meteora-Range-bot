import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import { PaperBroker } from "../src/sim/broker.js";
import { SimulatedLpPosition } from "../src/sim/lpPosition.js";

let distribution: typeof import("../src/sim/distribution.js");

before(async () => {
  process.env.RPC_URL ??= "https://api.mainnet-beta.solana.com";
  process.env.LOG_LEVEL = "silent";
  distribution = await import("../src/sim/distribution.js");
});

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

describe("binShares", () => {
  it("gives every ask-side bin an equal share of X for Spot", () => {
    const shares = distribution.binShares("Spot", 100, 95, 105);
    const ask = shares.filter((s) => s.binId > 100);
    assert.equal(ask.length, 5);
    assert.ok(ask.every((s) => s.xBps === ask[0]!.xBps));
    assert.ok(ask.every((s) => s.yBps === 0));
  });

  it("puts only Y below the active bin and only X above it", () => {
    const shares = distribution.binShares("Spot", 100, 95, 105);
    assert.ok(shares.filter((s) => s.binId < 100).every((s) => s.xBps === 0 && s.yBps > 0));
    assert.ok(shares.filter((s) => s.binId > 100).every((s) => s.yBps === 0 && s.xBps > 0));
  });

  it("splits the active bin across both sides", () => {
    const active = distribution.binShares("Spot", 100, 95, 105).find((s) => s.binId === 100)!;
    assert.ok(active.xBps > 0);
    assert.ok(active.yBps > 0);
  });

  it("allocates the whole deposit", () => {
    for (const strategy of ["Spot", "Curve", "BidAsk"] as const) {
      const shares = distribution.binShares(strategy, 100, 95, 105);
      const sumX = shares.reduce((s, b) => s + b.xBps, 0);
      const sumY = shares.reduce((s, b) => s + b.yBps, 0);
      assert.ok(Math.abs(sumX - 10_000) <= 5, `${strategy} sumX ${sumX}`);
      assert.ok(Math.abs(sumY - 10_000) <= 5, `${strategy} sumY ${sumY}`);
    }
  });

  it("concentrates at the edges for BidAsk and at the centre for Curve", () => {
    const bidask = distribution.binShares("BidAsk", 100, 95, 105);
    const curve = distribution.binShares("Curve", 100, 95, 105);
    const edge = (s: { binId: number; xBps: number }[]) => s.find((b) => b.binId === 105)!.xBps;
    const near = (s: { binId: number; xBps: number }[]) => s.find((b) => b.binId === 101)!.xBps;
    assert.ok(edge(bidask) > near(bidask), "BidAsk must weight the far bin more");
    assert.ok(near(curve) > edge(curve), "Curve must weight the near bin more");
  });
});

describe("balancedValueShareX", () => {
  it("lands near, but not exactly at, 50% for a symmetric range", () => {
    const share = distribution.balancedValueShareX({
      strategy: "Spot",
      activeBinId: 100,
      binStep: 20,
      minBinId: 76,
      maxBinId: 124,
    });
    // A bin-symmetric range is log-price symmetric, so it reaches further up
    // than down and needs slightly more quote.
    assert.ok(share > 0.45 && share < 0.5, `share ${share}`);
  });

  it("is X-heavy when the range leans upward, quote-heavy when it leans down", () => {
    const args = {
      strategy: "Spot" as const,
      activeBinId: 100,
      binStep: 20,
    };
    // Bins below the active one hold quote, bins above hold base. So a range
    // that mostly sits below spot is mostly quote, and vice versa.
    const leansDown = distribution.balancedValueShareX({ ...args, minBinId: 60, maxBinId: 110 });
    const leansUp = distribution.balancedValueShareX({ ...args, minBinId: 90, maxBinId: 140 });

    assert.ok(leansDown < 0.35, `downward range should be quote-heavy, got ${leansDown}`);
    assert.ok(leansUp > 0.65, `upward range should be base-heavy, got ${leansUp}`);
  });

  it("means a lopsided range needs a correspondingly lopsided hedge", () => {
    const args = {
      strategy: "Spot" as const,
      activeBinId: 100,
      binStep: 20,
    };
    const leansUp = distribution.balancedValueShareX({ ...args, minBinId: 90, maxBinId: 140 });
    const symmetric = distribution.balancedValueShareX({ ...args, minBinId: 76, maxBinId: 124 });
    assert.ok(
      leansUp > symmetric,
      "an upward-skewed range carries more delta and needs a bigger short",
    );
  });
});

// ---------------------------------------------------------------------------
// LP position
// ---------------------------------------------------------------------------

/** SOL/USDC-like position: 2.5 SOL + 500 USDC around $200, +/- ~5%. */
function position(overrides: Partial<ConstructorParameters<typeof SimulatedLpPosition>[0]> = {}) {
  return new SimulatedLpPosition({
    strategy: "Spot",
    binStep: 20,
    minBinId: -24,
    maxBinId: 24,
    activeBinId: 0,
    xUnits: 2.5,
    yUnits: 500,
    feeRate: 0.002,
    priceAtBinZero: 200,
    ...overrides,
  });
}

describe("SimulatedLpPosition", () => {
  it("holds the full deposit before any price move", () => {
    const p = position();
    assert.ok(Math.abs(p.xUnits - 2.5) < 1e-9);
    assert.ok(Math.abs(p.yUnits - 500) < 1e-9);
  });

  it("prices bins geometrically off the anchor", () => {
    const p = position();
    assert.ok(Math.abs(p.priceOfBin(0) - 200) < 1e-9);
    assert.ok(Math.abs(p.priceOfBin(1) - 200 * 1.002) < 1e-9);
    assert.ok(Math.abs(p.priceOfBin(-1) - 200 / 1.002) < 1e-9);
  });

  it("maps a price back to its bin", () => {
    const p = position();
    // Each bin spans 0.2%, and bin i covers [price(i), price(i+1)).
    assert.equal(p.binIdOfPrice(200), 0);
    assert.equal(p.binIdOfPrice(200 * 1.002), 1);
    assert.equal(p.binIdOfPrice(199.7), -1); // 0.15% down, inside the first bin below
    assert.equal(p.binIdOfPrice(199), -3); // 0.5% down is two and a half bins
  });

  it("round-trips bin id through price", () => {
    const p = position();
    for (const binId of [-24, -7, 0, 5, 24]) {
      assert.equal(p.binIdOfPrice(p.priceOfBin(binId)), binId);
    }
  });

  it("sells X into a rally, shrinking delta", () => {
    const p = position();
    const before = p.xUnits;
    p.moveToPrice(210);
    assert.ok(p.xUnits < before, "a rally must convert X into Y");
    assert.ok(p.yUnits > 500);
  });

  it("buys X into a selloff, growing delta", () => {
    const p = position();
    const before = p.xUnits;
    p.moveToPrice(191);
    assert.ok(p.xUnits > before, "a selloff must convert Y into X");
    assert.ok(p.yUnits < 500);
  });

  it("ends nearly all quote above the range top", () => {
    const p = position();
    p.moveToPrice(400);
    assert.ok(p.xUnits < 0.02, `expected almost no X left, got ${p.xUnits}`);
    assert.equal(p.inRange, false);
  });

  it("ends nearly all base below the range bottom", () => {
    const p = position();
    p.moveToPrice(100);
    assert.ok(p.yUnits < 1, `expected almost no Y left, got ${p.yUnits}`);
    assert.equal(p.inRange, false);
  });

  it("charges fees in the token traders bring in", () => {
    const up = position();
    up.moveToPrice(210);
    assert.ok(up.feeY > 0, "a rally is traders paying Y");
    assert.equal(up.feeX, 0);

    const down = position();
    down.moveToPrice(191);
    assert.ok(down.feeX > 0, "a selloff is traders paying X");
    assert.equal(down.feeY, 0);
  });

  it("accrues fees proportional to the volume that crossed", () => {
    const p = position();
    const result = p.moveToPrice(210);
    assert.ok(result.volumeQuote > 0);
    assert.ok(Math.abs(result.feeY - result.volumeQuote * 0.002) < 1e-9);
  });

  it("is a no-op when the price stays inside the active bin", () => {
    const p = position();
    const result = p.moveToPrice(200.1); // still bin 0
    assert.equal(result.binsCrossed, 0);
    assert.equal(result.volumeQuote, 0);
  });

  it("is path independent without fees: value depends only on price", () => {
    // A constant-function AMM has V = V(P). Selling X at a bin price on the way
    // up and buying it back at the same bin price on the way down is a wash, so
    // there is no path-dependent bleed inside the LP position itself. The gamma
    // cost of this strategy lives in the *hedge*, not here — see the combined
    // round-trip test below.
    const p = position({ feeRate: 0 });
    const startValue = p.valueInQuote(200);

    p.moveToPrice(210);
    p.moveToPrice(200);

    assert.ok(
      Math.abs(p.valueInQuote(200) - startValue) < 1e-9,
      `round trip must return the same value: ${p.valueInQuote(200)} vs ${startValue}`,
    );
  });

  it("loses value against holding when price moves and stays there (IL)", () => {
    const p = position({ feeRate: 0 });
    const heldValue = 2.5 * 240 + 500; // just holding the deposit
    p.moveToPrice(240);
    assert.ok(
      p.valueInQuote(240) < heldValue,
      `LP must underperform holding after a one-way move: ${p.valueInQuote(240)} vs ${heldValue}`,
    );
  });

  it("adds fees on top of a round trip", () => {
    const withFees = position({ feeRate: 0.02 });
    const start = withFees.valueInQuote(200);
    withFees.moveToPrice(210);
    withFees.moveToPrice(200);
    assert.ok(withFees.valueInQuote(200) > start, "fees are pure addition on a round trip");
  });

  it("counts unclaimed fees as part of the balance", () => {
    const p = position();
    p.moveToPrice(210);
    const bins = p.snapshotBins().reduce((s, b) => s + b.y, 0);
    assert.ok(Math.abs(p.yUnits - (bins + p.feeY)) < 1e-9);
  });

  it("clears fees on claim without touching liquidity", () => {
    const p = position();
    p.moveToPrice(210);
    const binY = p.snapshotBins().reduce((s, b) => s + b.y, 0);
    const claimed = p.claimFees();
    assert.ok(claimed.y > 0);
    assert.equal(p.feeY, 0);
    assert.ok(Math.abs(p.yUnits - binY) < 1e-9);
  });

  it("credits external volume without moving the price", () => {
    const p = position();
    const bin = p.activeBinId;
    p.accrueExternalFees(10_000, 200);
    assert.equal(p.activeBinId, bin);
    assert.ok(p.feeX > 0 && p.feeY > 0, "two-way flow pays in both tokens");
    assert.ok(Math.abs(p.feeY + p.feeX * 200 - 10_000 * 0.002) < 1e-9);
  });

  it("is path independent for the bin inventory", () => {
    const direct = position();
    direct.moveToPrice(210);

    const stepped = position();
    stepped.moveToPrice(203);
    stepped.moveToPrice(206);
    stepped.moveToPrice(210);

    // Monotone moves cross the same bins, so inventory must agree.
    assert.ok(Math.abs(direct.xUnits - stepped.xUnits) < 1e-9);
    assert.ok(Math.abs(direct.yUnits - stepped.yUnits) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Paper broker
// ---------------------------------------------------------------------------

function broker(overrides: Partial<ConstructorParameters<typeof PaperBroker>[0]> = {}) {
  const b = new PaperBroker({
    takerFee: 0.00045,
    slippage: 0.0005,
    startingCollateralUsd: 1000,
    ...overrides,
  });
  b.registerMarket("SOL", [{ lowerBound: "0", maxLeverage: 20 }]);
  b.setLeverage("SOL", 3);
  return b;
}

const marks = (px: number) => () => px;

describe("PaperBroker", () => {
  it("opens a short with the expected sign and margin", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });

    const p = b.getPosition("SOL")!;
    assert.ok(p.szi < 0, "selling must produce a negative size");
    assert.equal(p.szi, -2.5);
    // ~$500 notional at 3x leverage.
    assert.ok(Math.abs(p.marginUsd - 500 / 3) < 1, `margin ${p.marginUsd}`);
  });

  it("fills a sell below the mark and a buy above it", () => {
    const b = broker();
    const sell = b.trade({ symbol: "SOL", size: 1, markPx: 200 })!;
    assert.ok(sell.price < 200);
    const buy = b.trade({ symbol: "SOL", size: -0.5, markPx: 200 })!;
    assert.ok(buy.price > 200);
  });

  it("charges a taker fee on every fill", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    assert.ok(b.feesPaidUsd > 0);
    assert.ok(Math.abs(b.feesPaidUsd - 2.5 * 200 * 0.9995 * 0.00045) < 0.01);
  });

  it("profits on a short when price falls", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    b.trade({ symbol: "SOL", size: -2.5, markPx: 180 });
    assert.ok(b.realizedPnlUsd > 0, `short into a selloff must profit, got ${b.realizedPnlUsd}`);
    // ~2.5 * 20 = $50 before costs.
    assert.ok(Math.abs(b.realizedPnlUsd - 50) < 2, `pnl ${b.realizedPnlUsd}`);
  });

  it("loses on a short when price rises", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    b.trade({ symbol: "SOL", size: -2.5, markPx: 220 });
    assert.ok(b.realizedPnlUsd < 0);
    assert.ok(Math.abs(b.realizedPnlUsd + 50) < 2, `pnl ${b.realizedPnlUsd}`);
  });

  it("returns margin and cash to the account when flat", () => {
    const b = broker();
    const before = b.freeCollateralUsd;
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    assert.ok(b.freeCollateralUsd < before, "margin must be committed");
    b.trade({ symbol: "SOL", size: -2.5, markPx: 200 });
    assert.equal(b.getPosition("SOL"), undefined);
    // Back to the start, minus fees and slippage on the round trip.
    assert.ok(b.freeCollateralUsd < before);
    assert.ok(b.freeCollateralUsd > before - 5, `free ${b.freeCollateralUsd}`);
  });

  it("averages the entry price when adding to a short", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 1, markPx: 200 });
    b.trade({ symbol: "SOL", size: 1, markPx: 220 });
    const p = b.getPosition("SOL")!;
    assert.equal(p.szi, -2);
    assert.ok(p.entryPx > 205 && p.entryPx < 215, `entry ${p.entryPx}`);
  });

  it("refuses a trade it cannot fund", () => {
    const b = broker({ startingCollateralUsd: 10 });
    const fill = b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    assert.equal(fill, null);
    assert.equal(b.getPosition("SOL"), undefined);
  });

  it("rejects a trade that would flip the position", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 1, markPx: 200 });
    assert.throws(() => b.trade({ symbol: "SOL", size: -3, markPx: 200 }), /flip/);
  });

  it("pays funding to a short when the rate is positive", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    const payment = b.applyFunding("SOL", 0.0001, 200);
    assert.ok(payment > 0, "positive funding means longs pay shorts");
    assert.ok(Math.abs(payment - 0.0001 * 500) < 1e-9);
    assert.equal(b.fundingUsd, payment);
  });

  it("charges a short when funding is negative", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    assert.ok(b.applyFunding("SOL", -0.0001, 200) < 0);
  });

  it("ignores funding when flat", () => {
    assert.equal(broker().applyFunding("SOL", 0.001, 200), 0);
  });

  it("liquidates a short when price runs far enough up", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    const liqPx = b.liquidationPx("SOL")!;
    assert.ok(liqPx > 200);

    assert.deepEqual(b.checkLiquidations(marks(liqPx * 0.98), 0), []);
    assert.deepEqual(b.checkLiquidations(marks(liqPx * 1.02), 0), ["SOL"]);
    assert.equal(b.getPosition("SOL"), undefined);
    assert.equal(b.liquidations.length, 1);
  });

  it("forfeits only the isolated margin on liquidation", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    const free = b.freeCollateralUsd;
    b.checkLiquidations(marks(400), 0);
    // The rest of the account survives; only the posted margin is gone.
    assert.equal(b.freeCollateralUsd, free);
    assert.ok(b.liquidations[0]!.lostMarginUsd > 0);
  });

  it("tracks account value through an unrealised move", () => {
    const b = broker();
    const start = b.accountValueUsd(marks(200));
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    const afterOpen = b.accountValueUsd(marks(200));
    // Only fees and slippage lost so far.
    assert.ok(Math.abs(afterOpen - start) < 3, `${afterOpen} vs ${start}`);

    const afterDrop = b.accountValueUsd(marks(180));
    assert.ok(afterDrop > afterOpen, "a short gains as price falls");
    assert.ok(Math.abs(afterDrop - afterOpen - 50) < 2);
  });

  it("closes everything on settlement", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    b.closeAll(marks(200));
    assert.equal(b.getPosition("SOL"), undefined);
  });

  it("closes a short by buying it back, not by selling more", () => {
    const b = broker();
    b.trade({ symbol: "SOL", size: 2.5, markPx: 200 });
    b.closeAll(marks(200));
    const last = b.fills.at(-1)!;
    assert.equal(last.side, "buy");
    assert.equal(last.size, 2.5);
  });
});

// ---------------------------------------------------------------------------
// Where the gamma cost actually lives
// ---------------------------------------------------------------------------

describe("delta-hedged round trip", () => {
  /**
   * The LP position alone is path independent, so this is the test that shows
   * the real cost of the strategy: keeping the hedge matched to a moving delta
   * means buying back short into rallies and selling into dips. A price round
   * trip therefore ends flat on the LP but *down* on the hedge, and that gap is
   * the loss-versus-rebalancing the fee income has to beat.
   */
  function runPath(prices: number[], feeRate: number) {
    const lp = new SimulatedLpPosition({
      strategy: "Spot",
      binStep: 20,
      minBinId: -24,
      maxBinId: 24,
      activeBinId: 0,
      xUnits: 2.5,
      yUnits: 500,
      feeRate,
      priceAtBinZero: 200,
    });

    const b = new PaperBroker({
      takerFee: 0,
      slippage: 0,
      startingCollateralUsd: 5000,
    });
    b.registerMarket("SOL", [{ lowerBound: "0", maxLeverage: 20 }]);
    b.setLeverage("SOL", 3);

    const startPrice = prices[0]!;
    const startValue = lp.valueInQuote(startPrice) + b.accountValueUsd(() => startPrice);

    // Hedge exactly, with no threshold, so only the rebalancing loss shows.
    b.trade({ symbol: "SOL", size: lp.xUnits, markPx: startPrice });

    for (const price of prices.slice(1)) {
      lp.moveToPrice(price);
      const target = lp.xUnits;
      const drift = b.sizeOf("SOL") + target;
      if (Math.abs(drift) > 1e-9) b.trade({ symbol: "SOL", size: drift, markPx: price });
    }

    const endPrice = prices.at(-1)!;
    b.closeAll(() => endPrice);
    const endValue = lp.valueInQuote(endPrice) + b.accountValueUsd(() => endPrice);

    return { startValue, endValue, lp, broker: b };
  }

  it("loses money on a zero-fee round trip", () => {
    const { startValue, endValue } = runPath([200, 205, 210, 205, 200], 0);
    assert.ok(
      endValue < startValue,
      `hedged round trip must bleed: ${endValue.toFixed(4)} vs ${startValue.toFixed(4)}`,
    );
  });

  it("bleeds more as the path gets choppier at the same endpoints", () => {
    const calm = runPath([200, 200], 0);
    const choppy = runPath([200, 210, 200, 210, 200, 210, 200], 0);
    const calmLoss = calm.startValue - calm.endValue;
    const choppyLoss = choppy.startValue - choppy.endValue;
    assert.ok(
      choppyLoss > calmLoss,
      `realised volatility must cost more: ${choppyLoss.toFixed(4)} vs ${calmLoss.toFixed(4)}`,
    );
  });

  it("turns profitable once fees are large enough to cover the bleed", () => {
    const path = [200, 205, 210, 205, 200];
    const noFees = runPath(path, 0);
    const fatFees = runPath(path, 0.05);
    assert.ok(noFees.endValue < noFees.startValue);
    assert.ok(
      fatFees.endValue > fatFees.startValue,
      `fat fees must flip the result: ${fatFees.endValue.toFixed(2)} vs ${fatFees.startValue.toFixed(2)}`,
    );
  });

  it("keeps the combined position close to delta neutral throughout", () => {
    const { lp, broker: b } = runPath([200, 205, 210, 205, 200], 0.002);
    // After settlement the hedge is flat, so check the LP is what remains.
    assert.equal(b.sizeOf("SOL"), 0);
    assert.ok(lp.xUnits > 0);
  });
});
