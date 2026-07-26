import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { AccountState, FillResult, LivePosition } from "../src/hedge/hyperliquid.js";
import type { PoolMetrics } from "../src/meteora/api.js";
import type { OpenPositionResult, PositionSnapshot } from "../src/meteora/dlmm.js";
import { PaperBroker } from "../src/sim/broker.js";
import { SimulatedLpPosition } from "../src/sim/lpPosition.js";
import type { MarketSnapshot } from "../src/strategy/planner.js";
import type { HedgeVenue, LpVenue, PoolSource } from "../src/strategy/venues.js";

/**
 * End-to-end test of the production engine loop with stubbed venues.
 *
 * This is the same code path paper trading uses: real `open()`, real `tick()`,
 * real `decideRebalance`, real exit conditions — only the execution and the
 * market data are stand-ins. It is the only test that proves the loop wires
 * together, which no amount of unit testing of the pieces can show.
 */

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let Engine: typeof import("../src/strategy/engine.js").Engine;
let stateDir: string;

before(async () => {
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.LP_CAPITAL_USD = "1000";
  process.env.RANGE_WIDTH_PCT = "5";
  process.env.MIN_HL_OPEN_INTEREST_USD = "0";
  process.env.HEDGE_REBALANCE_THRESHOLD_PCT = "5";
  process.env.HEDGE_MIN_REBALANCE_USD = "1";
  process.env.REBALANCE_COOLDOWN_MS = "0";
  process.env.CLAIM_FEES_INTERVAL_MS = "0";
  process.env.EXIT_ON_OUT_OF_RANGE_MS = "0";
  process.env.MAX_DRAWDOWN_PCT = "99";
  process.env.DRY_RUN = "true";
  process.env.LOG_LEVEL = "silent";

  ({ Engine } = await import("../src/strategy/engine.js"));
  stateDir = await mkdtemp(join(tmpdir(), "mdn-engine-"));
});

after(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** A price the test drives directly, shared between both stub venues. */
class Market {
  price = 200;
  readonly binStep = 20;

  get activeBinId(): number {
    return Math.floor(Math.log(this.price / 200) / Math.log(1.002) + 1e-9);
  }

  snapshot(): MarketSnapshot {
    return {
      symbol: "SOL",
      markPx: this.price,
      maxLeverage: 20,
      szDecimals: 2,
      openInterestUsd: 1e9,
      fundingHourly: 0,
      marginTiers: [{ lowerBound: "0", maxLeverage: 20 }],
    };
  }
}

class StubHedger implements HedgeVenue {
  readonly canTrade = true;
  readonly address = "stub";
  readonly broker: PaperBroker;
  /** Set to make the next trade throw, to exercise the unwind path. */
  failNextTrade = false;

  constructor(private readonly market: Market) {
    this.broker = new PaperBroker({
      takerFee: 0,
      slippage: 0,
      startingCollateralUsd: 5000,
    });
    this.broker.registerMarket("SOL", [{ lowerBound: "0", maxLeverage: 20 }]);
  }

  async marketLookup(): Promise<(symbol: string) => MarketSnapshot | undefined> {
    return (symbol) => (symbol === "SOL" ? this.market.snapshot() : undefined);
  }

  async getAccountState(): Promise<AccountState> {
    const positions = new Map<string, LivePosition>();
    const p = this.broker.getPosition("SOL");
    if (p) {
      positions.set("SOL", {
        symbol: "SOL",
        szi: p.szi,
        entryPx: p.entryPx,
        positionValueUsd: Math.abs(p.szi) * this.market.price,
        unrealizedPnlUsd: p.szi * (this.market.price - p.entryPx),
        marginUsedUsd: p.marginUsd,
        liquidationPx: this.broker.liquidationPx("SOL"),
        leverage: { type: "isolated", value: p.leverage },
        maxLeverage: 20,
      });
    }
    return {
      accountValueUsd: this.broker.accountValueUsd(() => this.market.price),
      withdrawableUsd: this.broker.freeCollateralUsd,
      totalNotionalUsd: [...positions.values()].reduce((s, x) => s + x.positionValueUsd, 0),
      positions,
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.broker.setLeverage(symbol, leverage);
  }

  async adjustIsolatedMargin(): Promise<void> {}

  async trade(params: { symbol: string; size: number }): Promise<FillResult | null> {
    if (this.failNextTrade) {
      this.failNextTrade = false;
      throw new Error("simulated venue outage");
    }
    const fill = this.broker.trade({
      symbol: params.symbol,
      size: params.size,
      markPx: this.market.price,
    });
    if (!fill) return null;
    return {
      symbol: fill.symbol,
      side: fill.side,
      requestedSize: fill.size,
      filledSize: fill.size,
      avgPx: fill.price,
      dryRun: true,
    };
  }

  async closePosition(symbol: string): Promise<FillResult | null> {
    const szi = this.broker.sizeOf(symbol);
    if (szi === 0) return null;
    return this.trade({ symbol, size: szi });
  }
}

class StubPool implements LpVenue {
  readonly mintX = SOL;
  readonly mintY = USDC;
  readonly decimalsX = 9;
  readonly decimalsY = 6;
  position: SimulatedLpPosition | null = null;
  closed = false;
  claimCount = 0;
  /** Set to make openPosition throw, to exercise the hedge unwind. */
  failOpen = false;

  constructor(private readonly market: Market) {}

  async refresh(): Promise<void> {}

  async getActiveBin(): Promise<{ binId: number; priceXInY: number }> {
    return { binId: this.market.activeBinId, priceXInY: this.market.price };
  }

  async openPosition(params: {
    minBinId: number;
    maxBinId: number;
    xUnits: number;
    yUnits: number;
  }): Promise<OpenPositionResult> {
    if (this.failOpen) throw new Error("simulated chain failure");
    this.position = new SimulatedLpPosition({
      strategy: "Spot",
      binStep: this.market.binStep,
      minBinId: params.minBinId,
      maxBinId: params.maxBinId,
      activeBinId: this.market.activeBinId,
      xUnits: params.xUnits,
      yUnits: params.yUnits,
      feeRate: 0.002,
      priceAtBinZero: 200,
    });
    return {
      positionPubkey: "stub-position",
      signature: "stub",
      lowerBinId: params.minBinId,
      upperBinId: params.maxBinId,
      activeBinId: this.market.activeBinId,
    };
  }

  async snapshot(key: string): Promise<PositionSnapshot | null> {
    if (!this.position || key !== "stub-position") return null;
    this.position.moveToPrice(this.market.price);
    return {
      publicKey: key,
      lowerBinId: this.position.minBinId,
      upperBinId: this.position.maxBinId,
      activeBinId: this.market.activeBinId,
      inRange: this.position.inRange,
      xUnits: this.position.xUnits,
      yUnits: this.position.yUnits,
      unclaimedFeeXUnits: this.position.feeX,
      unclaimedFeeYUnits: this.position.feeY,
      priceXInY: this.market.price,
    };
  }

  async claimFees(): Promise<string[]> {
    this.claimCount++;
    this.position?.claimFees();
    return ["stub-claim"];
  }

  async closePosition(): Promise<string[]> {
    this.closed = true;
    this.position = null;
    return ["stub-close"];
  }
}

const POOL: PoolMetrics = {
  address: "StubPool1111111111111111111111111111111111",
  name: "SOL-USDC",
  mintX: SOL,
  mintY: USDC,
  binStep: 20,
  baseFee: 0.002,
  tvlUsd: 1_000_000,
  fees24hUsd: 20_000,
  volume24hUsd: 5_000_000,
  feeTvlRatio24h: 0.02,
  currentPrice: 200,
  tags: [],
  raw: {} as PoolMetrics["raw"],
};

const poolSource: PoolSource = {
  async fetchPair() {
    return POOL;
  },
  async fetchPairs() {
    return [POOL];
  },
};

let seq = 0;
function makeEngine(market: Market) {
  const hedger = new StubHedger(market);
  const pool = new StubPool(market);
  const engine = new Engine({
    hedger,
    openPool: async () => pool,
    checkBalances: async () => ({ ok: true, shortfalls: [] }),
    poolSource,
    mode: "test",
    statePath: join(stateDir, `state-${seq++}.json`),
  });
  return { engine, hedger, pool, market };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Engine.open", () => {
  it("opens both legs and records the session", async () => {
    const { engine, hedger, pool } = makeEngine(new Market());
    const session = await engine.open(POOL.address);

    assert.equal(session.poolAddress, POOL.address);
    assert.equal(session.positionPubkey, "stub-position");
    assert.ok(pool.position, "LP position must exist");
    assert.ok(hedger.broker.sizeOf("SOL") < 0, "hedge must be short");
  });

  it("shorts approximately the LP position's token balance", async () => {
    const { engine, hedger, pool } = makeEngine(new Market());
    await engine.open(POOL.address);

    const delta = pool.position!.xUnits;
    const short = Math.abs(hedger.broker.sizeOf("SOL"));
    assert.ok(
      Math.abs(short - delta) / delta < 0.02,
      `hedge ${short} should match delta ${delta}`,
    );
  });

  it("refuses to open a second session", async () => {
    const { engine } = makeEngine(new Market());
    await engine.open(POOL.address);
    await assert.rejects(engine.open(POOL.address), /already open/);
  });

  it("unwinds the hedge when the LP leg fails", async () => {
    const { engine, hedger, pool } = makeEngine(new Market());
    pool.failOpen = true;

    await assert.rejects(engine.open(POOL.address), /simulated chain failure/);
    assert.equal(
      hedger.broker.sizeOf("SOL"),
      0,
      "a failed LP open must not leave a naked short behind",
    );
  });

  it("leaves nothing open when the hedge itself fails", async () => {
    const { engine, hedger } = makeEngine(new Market());
    hedger.failNextTrade = true;

    await assert.rejects(engine.open(POOL.address), /simulated venue outage/);
    assert.equal(hedger.broker.sizeOf("SOL"), 0);
  });
});

describe("Engine.tick", () => {
  it("re-hedges after the price moves", async () => {
    const market = new Market();
    const { engine, hedger, pool } = makeEngine(market);
    await engine.open(POOL.address);

    const shortBefore = hedger.broker.sizeOf("SOL");
    market.price = 208; // a 4% rally shrinks the LP's delta
    await engine.tick();

    const shortAfter = hedger.broker.sizeOf("SOL");
    assert.ok(
      shortAfter > shortBefore,
      `rally must shrink the short: ${shortAfter} vs ${shortBefore}`,
    );
    assert.ok(
      Math.abs(Math.abs(shortAfter) - pool.position!.xUnits) / pool.position!.xUnits < 0.06,
      "hedge must track the new delta",
    );
  });

  it("increases the short after a selloff", async () => {
    const market = new Market();
    const { engine, hedger } = makeEngine(market);
    await engine.open(POOL.address);

    const before = hedger.broker.sizeOf("SOL");
    market.price = 192;
    await engine.tick();

    assert.ok(hedger.broker.sizeOf("SOL") < before, "a selloff must grow the short");
  });

  it("stays put when the drift is below the threshold", async () => {
    const market = new Market();
    const { engine, hedger } = makeEngine(market);
    await engine.open(POOL.address);

    const before = hedger.broker.sizeOf("SOL");
    market.price = 200.2; // well inside the 5% band
    const report = await engine.tick();

    assert.equal(hedger.broker.sizeOf("SOL"), before);
    assert.ok(report.legs[0]!.rebalanced === false);
  });

  it("keeps the combined position near flat through a round trip", async () => {
    const market = new Market();
    const { engine } = makeEngine(market);
    await engine.open(POOL.address);
    const start = (await engine.tick()).equityUsd;

    for (const price of [204, 208, 204, 200]) {
      market.price = price;
      await engine.tick();
    }

    const end = (await engine.tick()).equityUsd;
    // Delta neutral, so a round trip should cost only the rebalancing bleed.
    assert.ok(Math.abs(end - start) < 0.03 * start, `equity moved from ${start} to ${end}`);
  });

  it("reports out-of-range without exiting while the timer is disabled", async () => {
    const market = new Market();
    const { engine } = makeEngine(market);
    await engine.open(POOL.address);

    market.price = 400;
    const report = await engine.tick();

    assert.equal(report.inRange, false);
    // EXIT_ON_OUT_OF_RANGE_MS is 0 for this suite, which means "never exit".
    assert.equal(report.exitReason, null);
    assert.ok(report.actions.some((a) => a.includes("out of range")));
  });

  it("exits only after the grace period has actually elapsed", async () => {
    const { rebuildForTest } = await import("../src/config.js");
    const previous = process.env.EXIT_ON_OUT_OF_RANGE_MS;
    process.env.EXIT_ON_OUT_OF_RANGE_MS = "1";
    rebuildForTest();

    try {
      const market = new Market();
      const { engine } = makeEngine(market);
      await engine.open(POOL.address);

      market.price = 400;
      // The first tick starts the clock; it cannot already have expired.
      const first = await engine.tick();
      assert.equal(first.inRange, false);
      assert.equal(first.exitReason, null);

      await new Promise((r) => setTimeout(r, 5));

      const second = await engine.tick();
      assert.match(second.exitReason ?? "", /out of range/);
    } finally {
      if (previous === undefined) delete process.env.EXIT_ON_OUT_OF_RANGE_MS;
      else process.env.EXIT_ON_OUT_OF_RANGE_MS = previous;
      rebuildForTest();
    }
  });

  it("raises an alarm when the hedge cannot be placed", async () => {
    const market = new Market();
    const { engine, hedger } = makeEngine(market);
    await engine.open(POOL.address);

    // Drain the paper account so the next short cannot be margined. This is
    // what an underfunded Hyperliquid account looks like from the engine's side.
    hedger.broker.freeCollateralUsd = 0;
    market.price = 180; // a selloff grows the delta, demanding a bigger short

    const report = await engine.tick();

    assert.equal(report.hedgeDegraded, true, "a failed hedge must be visible in the report");
    assert.equal(report.legs[0]!.hedgeFailed, true);
    assert.equal(report.legs[0]!.rebalanced, false);
    assert.ok(report.actions.some((a) => a.includes("HEDGE FAILED")));
    assert.ok(report.legs[0]!.driftUsd > 0, "the unhedged amount must be quantified");
  });

  it("reports a healthy hedge as not degraded", async () => {
    const market = new Market();
    const { engine } = makeEngine(market);
    await engine.open(POOL.address);

    market.price = 208;
    const report = await engine.tick();

    assert.equal(report.hedgeDegraded, false);
    assert.equal(report.legs[0]!.hedgeFailed, false);
  });

  it("fails loudly when the position vanished from the venue", async () => {
    const market = new Market();
    const { engine, pool } = makeEngine(market);
    await engine.open(POOL.address);

    pool.position = null;
    await assert.rejects(engine.tick(), /no longer exists/);
  });
});

describe("Engine.close", () => {
  it("closes the LP position and flattens the hedge", async () => {
    const { engine, hedger, pool } = makeEngine(new Market());
    await engine.open(POOL.address);
    await engine.close();

    assert.equal(pool.closed, true);
    assert.equal(hedger.broker.sizeOf("SOL"), 0);
  });

  it("clears the session so a new one can start", async () => {
    const { engine } = makeEngine(new Market());
    await engine.open(POOL.address);
    await engine.close();

    const { session } = await engine.status();
    assert.equal(session, null);
  });

  it("is a no-op without a session", async () => {
    const { engine } = makeEngine(new Market());
    await engine.close();
  });

  it("keeps the hedge open when the LP leg cannot be closed", async () => {
    const { engine, hedger, pool } = makeEngine(new Market());
    await engine.open(POOL.address);

    pool.closePosition = async () => {
      throw new Error("chain unavailable");
    };

    await assert.rejects(engine.close(), /could not be closed/);
    assert.ok(
      hedger.broker.sizeOf("SOL") < 0,
      "the spot side is still exposed, so the hedge must stay on",
    );
  });
});

describe("Engine.status", () => {
  it("reports the live legs without trading", async () => {
    const { engine, hedger } = makeEngine(new Market());
    await engine.open(POOL.address);

    const sizeBefore = hedger.broker.sizeOf("SOL");
    const { session, report } = await engine.status();

    assert.ok(session);
    assert.ok(report);
    assert.equal(report.legs.length, 1);
    assert.equal(report.legs[0]!.symbol, "SOL");
    assert.equal(hedger.broker.sizeOf("SOL"), sizeBefore, "status must not trade");
  });

  it("returns nothing when no session exists", async () => {
    const { engine } = makeEngine(new Market());
    const { session, report } = await engine.status();
    assert.equal(session, null);
    assert.equal(report, null);
  });
});
