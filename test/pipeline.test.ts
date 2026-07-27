import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import type { PoolMetrics } from "../src/meteora/api.js";
import type { MarketSnapshot } from "../src/strategy/planner.js";

/**
 * Offline test of the pool-selection and planning pipeline.
 *
 * Everything here runs without network access: pool rows are synthetic and the
 * Hyperliquid market lookup is a stub. That covers the whole decision path —
 * validate, prefilter, classify, plan, size the hedge, rank — which is where a
 * silent mistake would cost real money.
 *
 * Config is populated before the dynamic imports because `src/config.ts`
 * validates the environment at module load.
 */

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const UNLISTED = "5cAmScAmScAmScAmScAmScAmScAmScAmScAmScAmScAm";

let api: typeof import("../src/meteora/api.js");
let scoring: typeof import("../src/meteora/scoring.js");
let planner: typeof import("../src/strategy/planner.js");
let tokens: typeof import("../src/tokens.js");

before(async () => {
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.LP_CAPITAL_USD = "1000";
  process.env.RANGE_WIDTH_PCT = "5";
  process.env.MIN_TVL_USD = "250000";
  process.env.MIN_VOLUME_24H_USD = "200000";
  process.env.MIN_FEE_TVL_RATIO_24H = "0.01";
  process.env.MIN_HL_OPEN_INTEREST_USD = "2000000";
  process.env.HEDGE_MAX_LEVERAGE = "10";
  process.env.HEDGE_LIQ_BUFFER_MULT = "3";
  process.env.HEDGE_MIN_LIQ_BUFFER_PCT = "25";
  process.env.QUOTE_WHITELIST = "USDC,USDT,SOL";
  process.env.LOG_LEVEL = "silent";
  process.env.DRY_RUN = "true";

  api = await import("../src/meteora/api.js");
  scoring = await import("../src/meteora/scoring.js");
  planner = await import("../src/strategy/planner.js");
  tokens = await import("../src/tokens.js");
});

/** A synthetic row shaped like `/pair/all_with_pagination` output. */
function rawPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
    name: "SOL-USDC",
    mint_x: SOL,
    mint_y: USDC,
    bin_step: 20,
    base_fee_percentage: "0.2",
    liquidity: "1000000",
    fees_24h: 20_000,
    trade_volume_24h: 5_000_000,
    current_price: 200,
    hide: false,
    is_blacklisted: false,
    ...overrides,
  };
}

/** Parse a synthetic row, asserting it survives validation. */
function parsed(overrides: Record<string, unknown> = {}): PoolMetrics {
  const result = api.parsePair(rawPair(overrides));
  assert.ok(result.ok, `expected the row to parse, got: ${result.ok ? "" : result.reason}`);
  return result.pool;
}

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: "SOL",
    markPx: 200,
    maxLeverage: 20,
    szDecimals: 2,
    openInterestUsd: 500_000_000,
    fundingHourly: 0.0000125, // ~11% APR credited to shorts
    marginTiers: [{ lowerBound: "0", maxLeverage: 20 }],
    ...overrides,
  };
}

const lookup = (symbol: string): MarketSnapshot | undefined => {
  if (symbol === "SOL") return market();
  if (symbol === "BTC") return market({ symbol: "BTC", markPx: 60_000, szDecimals: 5 });
  return undefined;
};

/** Adds JUP so the quote-whitelist check is the only thing left to reject on. */
const withJup = (symbol: string): MarketSnapshot | undefined => {
  if (symbol === "JUP") return market({ symbol: "JUP", markPx: 0.5, szDecimals: 1 });
  return lookup(symbol);
};

describe("parsePair", () => {
  it("computes fee/TVL as a fraction from fees and liquidity", () => {
    const pool = parsed();
    assert.equal(pool.tvlUsd, 1_000_000);
    assert.equal(pool.fees24hUsd, 20_000);
    assert.equal(pool.feeTvlRatio24h, 0.02); // 2% of TVL per day
  });

  it("converts the base fee percentage into a fraction", () => {
    assert.equal(parsed().baseFee, 0.002);
  });

  it("coerces numeric strings into numbers", () => {
    const pool = parsed({ liquidity: "2500000.75" });
    assert.equal(pool.tvlUsd, 2_500_000.75);
    assert.equal(typeof pool.tvlUsd, "number");
  });

  it("falls back to the bucketed series when the flat fields are absent", () => {
    const pool = parsed({
      fees_24h: null,
      trade_volume_24h: null,
      fees: { hour_24: 1234 },
      volume: { hour_24: 99_000 },
    });
    assert.equal(pool.fees24hUsd, 1234);
    assert.equal(pool.volume24hUsd, 99_000);
  });

  it("rejects a pool without usable TVL", () => {
    for (const liquidity of ["0", null]) {
      const result = api.parsePair(rawPair({ liquidity }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /TVL/);
    }
  });

  it("rejects a row missing a required field", () => {
    const result = api.parsePair({ name: "SOL-USDC" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unparseable/);
  });

  it("tolerates unknown extra fields, so an API addition cannot break the bot", () => {
    assert.equal(api.parsePair(rawPair({ some_new_field: "whatever" })).ok, true);
  });
});

describe("token allowlist", () => {
  it("accepts a SOL/USDC pool and picks SOL as the hedged leg", () => {
    const result = tokens.classifyPool(SOL, USDC);
    assert.equal(result.eligible, true);
    if (!result.eligible) return;
    assert.equal(result.tokens.x.symbol, "SOL");
    assert.equal(result.tokens.y.kind, "stable");
    assert.deepEqual(result.hedgedSymbols, ["SOL"]);
  });

  it("refuses a mint that is not on the allowlist", () => {
    const result = tokens.classifyPool(UNLISTED, USDC);
    assert.equal(result.eligible, false);
    if (result.eligible) return;
    assert.match(result.reason, /not on the allowlist/);
  });

  it("refuses liquid staking tokens, which a 1:1 SOL short would mis-hedge", () => {
    const result = tokens.classifyPool(JITOSOL, USDC);
    assert.equal(result.eligible, false);
    if (result.eligible) return;
    assert.match(result.reason, /liquid staking/);
  });

  it("refuses a stable/stable pool as having nothing to hedge", () => {
    const result = tokens.classifyPool(USDC, USDT);
    assert.equal(result.eligible, false);
    if (result.eligible) return;
    assert.match(result.reason, /nothing to hedge/);
  });

  it("scales kBONK-style markets by 1000", () => {
    assert.equal(tokens.hlSizeMultiplier("kBONK"), 1000);
    assert.equal(tokens.hlSizeMultiplier("SOL"), 1);
  });
});

describe("prefilter", () => {
  it("passes a healthy pool", () => {
    assert.equal(scoring.prefilter(parsed()), null);
  });

  it("rejects thin TVL", () => {
    assert.match(scoring.prefilter(parsed({ liquidity: "100000" }))!, /TVL/);
  });

  it("rejects low volume", () => {
    assert.match(scoring.prefilter(parsed({ trade_volume_24h: 1000 }))!, /volume/);
  });

  it("rejects a weak fee/TVL ratio", () => {
    // $1000 of fees on $1M of TVL is 0.1%/day, below the 1% floor.
    assert.match(scoring.prefilter(parsed({ fees_24h: 1000 }))!, /fee\/TVL/);
  });

  it("respects the API's own blacklist and hide flags", () => {
    assert.match(scoring.prefilter(parsed({ is_blacklisted: true }))!, /blacklisted/);
    assert.match(scoring.prefilter(parsed({ hide: true }))!, /hidden/);
  });

  it("rejects a bin step outside the configured band", () => {
    assert.match(scoring.prefilter(parsed({ bin_step: 400 }))!, /bin step/);
  });
});

describe("planPosition", () => {
  it("plans a roughly 50/50 deposit for a centred range", () => {
    const result = planner.planPosition({ pool: parsed(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;

    const { plan } = result;
    assert.ok(Math.abs(plan.deposit.xUsd - 500) < 1, `x side $${plan.deposit.xUsd}`);
    assert.ok(Math.abs(plan.deposit.yUsd - 500) < 1, `y side $${plan.deposit.yUsd}`);
    // $500 of SOL at $200 = 2.5 SOL.
    assert.ok(Math.abs(plan.deposit.xUnits - 2.5) < 0.01);
  });

  it("shorts exactly the SOL the LP position will hold", () => {
    const result = planner.planPosition({ pool: parsed(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;

    assert.equal(result.plan.legs.length, 1);
    const leg = result.plan.legs[0]!;
    assert.equal(leg.symbol, "SOL");
    assert.ok(Math.abs(leg.size - result.plan.deposit.xUnits) < 1e-9);
    assert.ok(Math.abs(leg.notionalUsd - 500) < 1);
  });

  it("does not hedge the stable side", () => {
    const result = planner.planPosition({ pool: parsed(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(
      result.plan.legs.map((l) => l.symbol),
      ["SOL"],
    );
  });

  it("keeps the liquidation price outside the LP range", () => {
    const result = planner.planPosition({ pool: parsed(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;

    const leg = result.plan.legs[0]!;
    const rangeTop = 200 * result.plan.range.upperPriceRatio;
    assert.ok(
      leg.liquidationPx > rangeTop,
      `liq $${leg.liquidationPx} must clear the range top $${rangeTop}`,
    );
  });

  it("reports total capital as LP plus hedge collateral", () => {
    const result = planner.planPosition({ pool: parsed(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;

    const { plan } = result;
    assert.ok(plan.totalCollateralUsd > 0);
    assert.ok(Math.abs(plan.totalCapitalUsd - (1000 + plan.totalCollateralUsd)) < 1e-9);
  });

  it("credits positive funding to the net APR", () => {
    const result = planner.planPosition({ pool: parsed(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.plan.expectedReturn.fundingApr > 0);
  });

  it("charges negative funding against the net APR", () => {
    const paying = (symbol: string) =>
      symbol === "SOL" ? market({ fundingHourly: -0.0001 }) : undefined;
    const result = planner.planPosition({ pool: parsed(), markets: paying });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.plan.expectedReturn.fundingApr < 0);
    assert.ok(result.plan.warnings.some((w) => w.includes("funding is negative")));
  });

  it("uses absolute bin ids once the active bin is known", () => {
    const result = planner.planPosition({ pool: parsed(), markets: lookup, activeBinId: 1234 });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.plan.range.minBinId < 1234);
    assert.ok(result.plan.range.maxBinId > 1234);
    assert.equal(result.plan.range.minBinId + result.plan.range.binsBelow, 1234);
  });

  it("refuses a pool whose asset has no perp", () => {
    const result = planner.planPosition({ pool: parsed({ mint_x: UNLISTED }), markets: lookup });
    assert.equal(result.ok, false);
  });

  it("refuses an illiquid perp", () => {
    const thin = (symbol: string) =>
      symbol === "SOL" ? market({ openInterestUsd: 1000 }) : undefined;
    const result = planner.planPosition({ pool: parsed(), markets: thin });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /open interest/);
  });

  it("derives leverage from HEDGE_COLLATERAL_USD when it is set", async () => {
    // Reimport with the knob set, since config reads the environment once.
    const previous = process.env.HEDGE_COLLATERAL_USD;
    process.env.HEDGE_COLLATERAL_USD = "100";
    const { rebuildForTest } = await import("../src/config.js");
    rebuildForTest();
    try {
      const result = planner.planPosition({ pool: parsed(), markets: lookup });
      assert.ok(result.ok);
      if (!result.ok) return;
      // $500 notional on $100 of margin implies 5x.
      assert.equal(result.plan.legs[0]!.leverage, 5);
      assert.equal(result.plan.legs[0]!.leverageBoundBy, "explicit");
      assert.ok(Math.abs(result.plan.totalCollateralUsd - 100) < 1);
    } finally {
      if (previous === undefined) delete process.env.HEDGE_COLLATERAL_USD;
      else process.env.HEDGE_COLLATERAL_USD = previous;
      rebuildForTest();
    }
  });

  it("lets HEDGE_TARGET_LEVERAGE override the collateral figure", async () => {
    const { rebuildForTest } = await import("../src/config.js");
    process.env.HEDGE_COLLATERAL_USD = "100";
    process.env.HEDGE_TARGET_LEVERAGE = "2";
    rebuildForTest();
    try {
      const result = planner.planPosition({ pool: parsed(), markets: lookup });
      assert.ok(result.ok);
      if (!result.ok) return;
      assert.equal(result.plan.legs[0]!.leverage, 2);
    } finally {
      delete process.env.HEDGE_COLLATERAL_USD;
      delete process.env.HEDGE_TARGET_LEVERAGE;
      rebuildForTest();
    }
  });

  it("scales the deposit with LP capital", () => {
    const big = planner.planPosition({
      pool: parsed(),
      markets: lookup,
      lpCapitalUsd: 10_000,
    });
    assert.ok(big.ok);
    if (!big.ok) return;
    assert.ok(Math.abs(big.plan.deposit.xUnits - 25) < 0.1);
    assert.ok(Math.abs(big.plan.legs[0]!.notionalUsd - 5000) < 10);
  });
});

describe("rankPools", () => {
  it("ranks the richer pool first and reports the rejects", () => {
    const rich = parsed({ address: "rich", fees_24h: 40_000 });
    const lean = parsed({ address: "lean", fees_24h: 15_000 });
    const bad = parsed({ address: "bad", mint_x: UNLISTED, name: "???-USDC" });

    const { candidates, rejected } = scoring.rankPools([lean, rich, bad], lookup);

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]!.pool.address, "rich");
    assert.ok(candidates[0]!.score > candidates[1]!.score);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.pool.address, "bad");
  });

  it("scores on total capital, so hedge collateral dilutes the headline ratio", () => {
    const { candidates } = scoring.rankPools([parsed()], lookup);
    const c = candidates[0]!;
    assert.ok(
      c.score < c.plan.expectedReturn.lpFeeApr,
      "net APR must sit below the raw LP fee APR once margin is locked up",
    );
  });

  it("rejects a quote asset outside QUOTE_WHITELIST", () => {
    // JUP is on the mint allowlist and has a perp in the stub, so the whitelist
    // is the only thing left to reject it on.
    const jupQuoted = parsed({ mint_y: JUP, name: "SOL-JUP", current_price: 400 });
    const { candidates, rejected } = scoring.rankPools([jupQuoted], withJup);
    assert.equal(candidates.length, 0);
    assert.match(rejected[0]!.reason, /QUOTE_WHITELIST/);
  });
});

describe("REQUIRE_STABLE_QUOTE", () => {
  const btcSol = () =>
    parsed({ mint_x: WBTC, mint_y: SOL, name: "wBTC-SOL", current_price: 300 });

  it("rejects a two-legged pool by default", () => {
    const { candidates, rejected } = scoring.rankPools([btcSol()], lookup);
    assert.equal(candidates.length, 0);
    assert.match(rejected[0]!.reason, /single short/);
    assert.match(rejected[0]!.reason, /BTC \+ SOL|SOL \+ BTC/);
  });

  it("still accepts a stable-quoted pool", () => {
    const { candidates } = scoring.rankPools([parsed()], lookup);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.plan.legs.length, 1);
  });

  it("lets a two-legged pool through when switched off", async () => {
    const { rebuildForTest } = await import("../src/config.js");
    process.env.REQUIRE_STABLE_QUOTE = "false";
    rebuildForTest();
    try {
      const { candidates } = scoring.rankPools([btcSol()], lookup);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]!.plan.legs.length, 2);
    } finally {
      delete process.env.REQUIRE_STABLE_QUOTE;
      rebuildForTest();
    }
  });
});

describe("pools where both sides carry delta", () => {
  /** wBTC/SOL: neither side is a stablecoin, so both need their own short. */
  const btcSol = () =>
    parsed({
      mint_x: WBTC,
      mint_y: SOL,
      name: "wBTC-SOL",
      // 1 wBTC = 300 SOL, i.e. $60k / $200.
      current_price: 300,
    });

  it("opens one short per volatile side", () => {
    const result = planner.planPosition({ pool: btcSol(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;

    assert.deepEqual(
      result.plan.legs.map((l) => l.symbol).sort(),
      ["BTC", "SOL"],
    );
  });

  it("sizes each leg from its own side of the deposit", () => {
    const result = planner.planPosition({ pool: btcSol(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;

    const btc = result.plan.legs.find((l) => l.symbol === "BTC")!;
    const sol = result.plan.legs.find((l) => l.symbol === "SOL")!;

    // ~$500 per side: 500/60000 BTC and 500/200 SOL.
    assert.ok(Math.abs(btc.size - 500 / 60_000) < 1e-4, `btc size ${btc.size}`);
    assert.ok(Math.abs(sol.size - 500 / 200) < 0.01, `sol size ${sol.size}`);
  });

  it("hedges the full notional across both legs", () => {
    const result = planner.planPosition({ pool: btcSol(), markets: lookup });
    assert.ok(result.ok);
    if (!result.ok) return;
    // The whole LP position is volatile here, so the hedge covers all of it.
    assert.ok(Math.abs(result.plan.totalHedgeNotionalUsd - 1000) < 5);
  });
});

describe("Meteora SDK interop", () => {
  it("loads the CJS build and exposes the class and enums", async () => {
    const sdk = await import("../src/meteora/sdk.js");
    assert.equal(typeof sdk.DLMM, "function");
    assert.equal(typeof sdk.DLMM.create, "function");
    assert.equal(sdk.StrategyType.Spot, 0);
    assert.equal(sdk.StrategyType.Curve, 1);
    assert.equal(sdk.StrategyType.BidAsk, 2);
  });
});

describe("raw amount conversion", () => {
  it("round-trips through 9-decimal lamports", async () => {
    const { toRaw, toUi } = await import("../src/meteora/dlmm.js");
    assert.equal(toRaw(1.5, 9).toString(), "1500000000");
    assert.ok(Math.abs(toUi(toRaw(1.5, 9), 9) - 1.5) < 1e-12);
  });

  it("handles 6-decimal tokens", async () => {
    const { toRaw, toUi } = await import("../src/meteora/dlmm.js");
    assert.equal(toRaw(1234.567891, 6).toString(), "1234567891");
    assert.ok(Math.abs(toUi("1234567891", 6) - 1234.567891) < 1e-9);
  });

  it("truncates below the token's precision rather than rounding up", async () => {
    const { toRaw } = await import("../src/meteora/dlmm.js");
    assert.equal(toRaw(0.0000000009, 6).toString(), "0");
  });

  it("rejects negative amounts", async () => {
    const { toRaw } = await import("../src/meteora/dlmm.js");
    assert.throws(() => toRaw(-1, 9), /invalid amount/);
  });
});
