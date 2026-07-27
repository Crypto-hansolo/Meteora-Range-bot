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
