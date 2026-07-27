import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

/**
 * Which commands need which keys.
 *
 * Paper trading, scanning and every analysis command are read-only and must
 * work with no private keys at all — that is what makes them safe to hand
 * someone before they have funded anything. This is easy to break by accident:
 * one `wallet()` call on a read path and paper mode starts demanding a Solana
 * key it never uses. These tests pin the boundary.
 */

let config: typeof import("../src/config.js");

before(async () => {
  // Deliberately no SOLANA_PRIVATE_KEY and no HL_PRIVATE_KEY.
  delete process.env.SOLANA_PRIVATE_KEY;
  delete process.env.HL_PRIVATE_KEY;
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.LOG_LEVEL = "silent";
  config = await import("../src/config.js");
  config.rebuildForTest();
});

describe("config without any keys", () => {
  it("validates with RPC_URL alone", () => {
    assert.equal(config.config.solana.rpcUrl, "https://api.mainnet-beta.solana.com");
    assert.equal(config.config.solana.privateKey, "");
    assert.equal(config.config.hyperliquid.privateKey, "");
  });

  it("defaults DRY_RUN to true so nothing trades by accident", () => {
    assert.equal(config.config.dryRun, true);
  });

  it("refuses live trading and names what is missing", () => {
    assert.throws(() => config.assertTradingCredentials(), /SOLANA_PRIVATE_KEY/);
    assert.throws(() => config.assertTradingCredentials(), /HL_PRIVATE_KEY/);
  });
});

describe("blank values in .env", () => {
  /**
   * `.env.example` ships optional settings as bare keys, and dotenv turns those
   * into empty strings. Zod's `.optional()` only covers *unset*, so `""` used to
   * coerce to 0 and fail `.positive()` — copying the example file produced a
   * config that refused to load at all.
   */
  const blanks = [
    "HEDGE_COLLATERAL_USD",
    "HEDGE_TARGET_LEVERAGE",
    "HEDGE_MARGIN_TOPUP_LEVERAGE",
  ] as const;

  it("treats a blank optional number as not set", () => {
    for (const key of blanks) process.env[key] = "";
    try {
      config.rebuildForTest();
      assert.equal(config.config.capital.hedgeCollateralUsd, undefined);
      assert.equal(config.config.hedge.targetLeverage, undefined);
      assert.equal(config.config.hedge.marginTopupLeverage, undefined);
    } finally {
      for (const key of blanks) delete process.env[key];
      config.rebuildForTest();
    }
  });

  it("treats a blank value with a default as not set", () => {
    process.env.MIN_TVL_USD = "";
    process.env.RANGE_WIDTH_PCT = "   ";
    try {
      config.rebuildForTest();
      // The default, not zero.
      assert.equal(config.config.selection.minTvlUsd, 250_000);
      assert.equal(config.config.lp.rangeWidthPct, 5);
    } finally {
      delete process.env.MIN_TVL_USD;
      delete process.env.RANGE_WIDTH_PCT;
      config.rebuildForTest();
    }
  });

  it("still honours a value that is actually set", () => {
    process.env.HEDGE_TARGET_LEVERAGE = "4";
    try {
      config.rebuildForTest();
      assert.equal(config.config.hedge.targetLeverage, 4);
    } finally {
      delete process.env.HEDGE_TARGET_LEVERAGE;
      config.rebuildForTest();
    }
  });

  it("still rejects a value that is set but invalid", () => {
    process.env.HEDGE_TARGET_LEVERAGE = "-1";
    try {
      assert.throws(() => config.rebuildForTest(), /HEDGE_TARGET_LEVERAGE/);
    } finally {
      delete process.env.HEDGE_TARGET_LEVERAGE;
      config.rebuildForTest();
    }
  });
});

describe("read-only clients without keys", () => {
  it("builds a Hyperliquid client that can read but not trade", async () => {
    const { HyperliquidHedger } = await import("../src/hedge/hyperliquid.js");
    const hedger = new HyperliquidHedger();
    assert.equal(hedger.canTrade, false, "no key means no trading");
  });

  it("builds a paper hedger that can trade against the simulator", async () => {
    const { PaperHedger } = await import("../src/paper/venues.js");
    const paper = new PaperHedger(1000);
    assert.equal(paper.canTrade, true);
    assert.equal(paper.address, "paper");
  });

  it("keeps paper state in its own file, away from a live session", async () => {
    const { paperStatePath } = await import("../src/paper/index.js");
    assert.notEqual(paperStatePath(), config.config.statePath);
    assert.match(paperStatePath(), /\.paper\.json$/);
  });
});

describe("the wallet is only touched by paths that spend money", () => {
  it("throws a clear error when a key really is required", async () => {
    const { wallet } = await import("../src/solana.js");
    assert.throws(() => wallet(), /SOLANA_PRIVATE_KEY is not set/);
  });

  it("lets the paper engine start without ever asking for one", async () => {
    // Constructing the paper engine must not reach for a key. It will need the
    // network later, but that is a separate failure with a separate message.
    const { PaperHedger } = await import("../src/paper/venues.js");
    const { Engine } = await import("../src/strategy/engine.js");

    const engine = new Engine({
      hedger: new PaperHedger(1000),
      openPool: async () => {
        throw new Error("network");
      },
      checkBalances: async () => ({ ok: true, shortfalls: [] }),
      mode: "paper",
      statePath: "/tmp/mdn-credentials-test.json",
    });

    // No session yet, and reaching that answer must not need a key.
    const { session } = await engine.status();
    assert.equal(session, null);
  });
});
