import { config } from "../config.js";
import { HyperliquidHedger, type AccountState } from "../hedge/hyperliquid.js";
import { logger } from "../logger.js";
import { decideRebalance, effectiveLeverage } from "../math/deltaNeutral.js";
import { MeteoraApi, type PoolMetrics } from "../meteora/api.js";
import { DlmmPool, type PositionSnapshot } from "../meteora/dlmm.js";
import { rankPools, type ScanResult } from "../meteora/scoring.js";
import { StateStore, type Session } from "../state/store.js";
import { hlSizeMultiplier, type PoolTokens } from "../tokens.js";
import { checkBalances } from "../util/balances.js";
import { sleep } from "../util/http.js";
import type {
  BalanceChecker,
  HedgeVenue,
  LpVenue,
  LpVenueFactory,
  PoolSource,
} from "./venues.js";
import {
  planPosition,
  priceTokensUsd,
  type MarketLookup,
  type PositionPlan,
} from "./planner.js";

export interface TickReport {
  inRange: boolean;
  lpValueUsd: number;
  hedgeAccountValueUsd: number;
  equityUsd: number;
  drawdownPct: number;
  legs: {
    symbol: string;
    targetShort: number;
    currentSzi: number;
    driftUsd: number;
    rebalanced: boolean;
    /** The hedge was needed but did not go through; delta is exposed. */
    hedgeFailed: boolean;
    liquidationPx: number | null;
    effectiveLeverage: number;
  }[];
  actions: string[];
  exitReason: string | null;
  /** True when any leg failed to hedge this tick. */
  hedgeDegraded: boolean;
}

export interface EngineDeps {
  /** Perp venue. Defaults to the live Hyperliquid client. */
  hedger?: HedgeVenue;
  /** Opens a pool handle. Defaults to the on-chain DLMM pool. */
  openPool?: LpVenueFactory;
  /** Wallet funding check. Defaults to reading real balances. */
  checkBalances?: BalanceChecker;
  /** Label shown in logs, e.g. "paper". */
  mode?: string;
  /** Overrides STATE_PATH so paper runs cannot collide with a live session. */
  statePath?: string;
  /** Pool metrics provider. Defaults to the live Meteora API. */
  poolSource?: PoolSource;
}

/**
 * Orchestrates the delta-neutral session: pick a pool, open both legs, keep the
 * hedge tracking the LP delta, and unwind on the configured exit conditions.
 */
export class Engine {
  private readonly store: StateStore;
  private readonly api: PoolSource;
  private readonly hedger: HedgeVenue;
  private readonly openPool: LpVenueFactory;
  private readonly checkBalances: BalanceChecker;
  readonly mode: string;

  /**
   * Both venues are injectable so paper trading can drive the exact same loop
   * with simulated execution instead of a parallel implementation.
   */
  constructor(deps: EngineDeps = {}) {
    this.store = new StateStore(deps.statePath ?? config.statePath);
    this.api = deps.poolSource ?? new MeteoraApi();
    this.hedger = deps.hedger ?? new HyperliquidHedger();
    this.openPool = deps.openPool ?? ((address) => DlmmPool.load(address));
    this.checkBalances = deps.checkBalances ?? checkBalances;
    this.mode = deps.mode ?? "live";
  }

  // ------------------------------------------------------------------- scan

  /** Rank pools by the return the hedged strategy can expect. */
  async scan(): Promise<ScanResult> {
    const [pools, markets] = await Promise.all([
      this.api.fetchPairs({ sortKey: "feetvlratio", orderBy: "desc", limit: 400 }),
      this.hedger.marketLookup(),
    ]);
    logger.info({ pools: pools.length }, "fetched Meteora pairs");
    return rankPools(pools, markets);
  }

  /** Build the plan for a specific pool, or for the best scan result. */
  async plan(poolAddress?: string): Promise<PositionPlan> {
    const address = poolAddress ?? config.selection.poolAddress;
    const markets = await this.hedger.marketLookup();

    if (address) {
      const pool = await this.api.fetchPair(address);
      const result = planPosition({ pool, markets });
      if (!result.ok) throw new Error(`Pool ${address} is not usable: ${result.reason}`);
      return result.plan;
    }

    const { candidates, rejected } = await this.scan();
    if (!candidates.length) {
      const sample = rejected
        .slice(0, 5)
        .map((r) => `  ${r.pool.name}: ${r.reason}`)
        .join("\n");
      throw new Error(
        `No pool passed the filters (${rejected.length} rejected). Sample:\n${sample}`,
      );
    }
    return candidates[0]!.plan;
  }

  // ------------------------------------------------------------------- open

  /**
   * Open both legs.
   *
   * Order of operations, and why: the hedge goes on **first**, sized from the
   * plan. Opening the LP position is the slow, failure-prone leg (multiple
   * instructions, blockhash expiry, slippage guards), whereas the perp short is
   * a single fast call. Hedging first means a crash between the two legs leaves
   * a *short* — an understood, closable position — rather than a naked long
   * spot bag. If the LP leg then fails, the hedge is unwound before returning.
   *
   * After the LP position exists the hedge is reconciled against the actual
   * on-chain amounts, which differ slightly from the plan because of rounding
   * and the active bin's internal split.
   */
  async open(poolAddress?: string): Promise<Session> {
    const existing = (await this.store.load()).session;
    if (existing) {
      throw new Error(
        `A session is already open on ${existing.poolName} (position ${existing.positionPubkey}). ` +
          `Close it first with the "close" command.`,
      );
    }
    if (!this.hedger.canTrade && !config.dryRun) {
      throw new Error("HL_PRIVATE_KEY is required to trade. Set DRY_RUN=true to simulate.");
    }

    const plan = await this.plan(poolAddress);
    const pool = await this.openPool(plan.pool.address);
    await pool.refresh();

    // Re-plan against the live active bin so the bin ids are absolute and the
    // composition reflects the price we are actually entering at.
    const active = await pool.getActiveBin();
    const markets = await this.hedger.marketLookup();
    const replanned = planPosition({
      pool: plan.pool,
      markets,
      activeBinId: active.binId,
    });
    if (!replanned.ok) throw new Error(`Pool became unusable: ${replanned.reason}`);
    const finalPlan = replanned.plan;

    logSummary(finalPlan);

    const balances = await this.checkBalances([
      {
        mint: pool.mintX,
        symbol: finalPlan.tokens.x.symbol,
        decimals: pool.decimalsX,
        required: finalPlan.deposit.xUnits,
      },
      {
        mint: pool.mintY,
        symbol: finalPlan.tokens.y.symbol,
        decimals: pool.decimalsY,
        required: finalPlan.deposit.yUnits,
      },
    ]);

    if (!balances.ok) {
      const lines = balances.shortfalls
        .map(
          (s) =>
            `  ${s.symbol}: need ${s.required.toFixed(6)}, have ${s.available.toFixed(6)} ` +
            `(short ${(s.required - s.available).toFixed(6)})`,
        )
        .join("\n");
      throw new Error(
        `Wallet is underfunded for this deposit. The bot does not swap — fund both ` +
          `sides first:\n${lines}`,
      );
    }

    // --- leg 1: hedge -------------------------------------------------------
    for (const leg of finalPlan.legs) {
      await this.hedger.setLeverage(leg.symbol, leg.leverage, config.hedge.isolated);
    }
    const opened: string[] = [];
    try {
      for (const leg of finalPlan.legs) {
        await this.hedger.trade({ symbol: leg.symbol, size: leg.size });
        opened.push(leg.symbol);
      }
    } catch (error) {
      logger.error({ err: String(error) }, "hedge leg failed; unwinding what was opened");
      await this.unwindHedges(opened);
      throw error;
    }

    // --- leg 2: LP ----------------------------------------------------------
    let position;
    try {
      position = await pool.openPosition({
        minBinId: finalPlan.range.minBinId,
        maxBinId: finalPlan.range.maxBinId,
        xUnits: finalPlan.deposit.xUnits,
        yUnits: finalPlan.deposit.yUnits,
      });
    } catch (error) {
      logger.error(
        { err: String(error) },
        "LP position failed to open; unwinding the hedge so no naked short is left behind",
      );
      await this.unwindHedges(finalPlan.legs.map((l) => l.symbol));
      throw error;
    }

    const account = await this.hedger.getAccountState();
    const session: Session = {
      startedAt: Date.now(),
      poolAddress: finalPlan.pool.address,
      poolName: finalPlan.pool.name,
      positionPubkey: position.positionPubkey,
      lowerBinId: position.lowerBinId,
      upperBinId: position.upperBinId,
      startEquityUsd: config.capital.lpUsd + account.accountValueUsd,
      lpCapitalUsd: config.capital.lpUsd,
      hedgeLegs: finalPlan.legs.map((leg) => ({
        symbol: leg.symbol,
        targetLeverage: leg.leverage,
        plannedSize: leg.size,
        plannedCollateralUsd: leg.collateralUsd,
        plannedLiquidationPx: leg.liquidationPx,
      })),
      lastRebalanceAt: Date.now(),
      lastClaimAt: Date.now(),
      outOfRangeSince: null,
    };

    const state = await this.store.load();
    state.session = session;
    await this.store.save(state);

    logger.info(
      { position: position.positionPubkey, pool: finalPlan.pool.name },
      "session open; reconciling the hedge against on-chain amounts",
    );

    // --- reconcile ----------------------------------------------------------
    await this.tick();
    return session;
  }

  private async unwindHedges(symbols: string[]): Promise<void> {
    for (const symbol of symbols) {
      try {
        await this.hedger.closePosition(symbol);
      } catch (error) {
        logger.error(
          { symbol, err: String(error) },
          "FAILED to unwind hedge leg — close it manually on Hyperliquid",
        );
      }
    }
  }

  // ------------------------------------------------------------------- tick

  /** One monitoring pass: re-hedge, top up margin, claim fees, check exits. */
  async tick(): Promise<TickReport> {
    const state = await this.store.load();
    const session = state.session;
    if (!session) throw new Error("No open session");

    const pool = await this.openPool(session.poolAddress);
    const snapshot = await pool.snapshot(session.positionPubkey);

    if (!snapshot) {
      throw new Error(
        `Position ${session.positionPubkey} no longer exists on chain. It may have been ` +
          `closed outside the bot. Run "close" to flatten the hedge and clear the state.`,
      );
    }

    const markets = await this.hedger.marketLookup();
    const account = await this.hedger.getAccountState();

    const tokens = await this.poolTokens(session, pool);
    const prices = priceTokensUsd(tokens, markets, snapshot.priceXInY);
    if (!prices) throw new Error("Could not price the pool tokens in USD");

    const lpValueUsd =
      snapshot.xUnits * prices.priceXUsd + snapshot.yUnits * prices.priceYUsd;
    const equityUsd = lpValueUsd + account.accountValueUsd;
    const drawdownPct =
      session.startEquityUsd > 0
        ? ((session.startEquityUsd - equityUsd) / session.startEquityUsd) * 100
        : 0;

    const actions: string[] = [];
    const targets = this.deltaTargets(tokens, snapshot);
    const cooldownOk =
      Date.now() - (session.lastRebalanceAt ?? 0) >= config.loop.rebalanceCooldownMs;

    const legs: TickReport["legs"] = [];
    let rebalancedAny = false;

    for (const [symbol, targetUnits] of targets) {
      const market = markets(symbol);
      if (!market) {
        actions.push(`${symbol}: market unavailable, skipped this tick`);
        continue;
      }
      const position = account.positions.get(symbol);
      const currentSzi = position?.szi ?? 0;

      const decision = decideRebalance({
        targetDeltaUnits: targetUnits,
        currentSzi,
        price: market.markPx,
        thresholdPct: config.hedge.rebalanceThresholdPct,
        minNotionalUsd: config.hedge.minRebalanceUsd,
      });

      let rebalanced = false;
      let hedgeFailed = false;
      if (decision.shouldRebalance && cooldownOk) {
        // Reducing an existing short is reduce-only so a stale delta reading can
        // never accidentally flip the hedge into a long.
        const reduceOnly = decision.deltaSize < 0 && currentSzi < 0;
        const fill = await this.hedger.trade({
          symbol,
          size: decision.deltaSize,
          reduceOnly,
        });
        rebalanced = fill !== null && fill.filledSize > 0;
        rebalancedAny ||= rebalanced;

        if (rebalanced) {
          actions.push(`${symbol}: re-hedged (${decision.reason})`);
        } else {
          // The hedge was needed and did not happen. Backtesting showed this is
          // the failure that matters most: a position that quietly stops being
          // delta neutral looks fine in the logs while it turns into a
          // leveraged directional bet. Usually it means the Hyperliquid account
          // is out of collateral to post as margin.
          hedgeFailed = true;
          actions.push(
            `${symbol}: HEDGE FAILED — $${decision.deltaNotionalUsd.toFixed(2)} of delta ` +
              `is unhedged (check collateral on Hyperliquid)`,
          );
          logger.error(
            { symbol, unhedgedUsd: decision.deltaNotionalUsd, size: decision.deltaSize },
            "hedge order did not fill; the position is directionally exposed",
          );
        }
      } else if (decision.shouldRebalance) {
        actions.push(`${symbol}: re-hedge due but cooling down`);
      }

      const notional = Math.abs(currentSzi) * market.markPx;
      const margin = position?.marginUsedUsd ?? 0;
      const effLev = effectiveLeverage(notional, margin);

      const topupThreshold = config.hedge.marginTopupLeverage;
      if (
        topupThreshold !== undefined &&
        position &&
        position.leverage.type === "isolated" &&
        effLev > topupThreshold
      ) {
        const targetMargin = notional / topupThreshold;
        const topup = targetMargin - margin;
        if (topup > 1) {
          await this.hedger.adjustIsolatedMargin(symbol, topup);
          actions.push(
            `${symbol}: topped up isolated margin by $${topup.toFixed(2)} ` +
              `(effective leverage ${effLev.toFixed(2)}x > ${topupThreshold}x)`,
          );
        }
      }

      legs.push({
        symbol,
        targetShort: targetUnits,
        currentSzi,
        driftUsd: decision.deltaNotionalUsd,
        rebalanced,
        hedgeFailed,
        liquidationPx: position?.liquidationPx ?? null,
        effectiveLeverage: effLev,
      });
    }

    // --- fees ---------------------------------------------------------------
    if (
      config.loop.claimFeesIntervalMs > 0 &&
      Date.now() - (session.lastClaimAt ?? 0) >= config.loop.claimFeesIntervalMs &&
      (snapshot.unclaimedFeeXUnits > 0 || snapshot.unclaimedFeeYUnits > 0)
    ) {
      const sigs = await pool.claimFees(session.positionPubkey);
      if (sigs.length) actions.push(`claimed swap fees (${sigs.length} tx)`);
      session.lastClaimAt = Date.now();
    }

    // --- exit conditions ----------------------------------------------------
    let exitReason: string | null = null;

    if (snapshot.inRange) {
      session.outOfRangeSince = null;
    } else {
      session.outOfRangeSince ??= Date.now();
      const outFor = Date.now() - session.outOfRangeSince;
      if (config.loop.exitOnOutOfRangeMs > 0 && outFor >= config.loop.exitOnOutOfRangeMs) {
        exitReason = `price out of range for ${Math.round(outFor / 60_000)} min`;
      } else {
        actions.push(`out of range for ${Math.round(outFor / 1000)}s (earning no fees)`);
      }
    }

    if (drawdownPct >= config.loop.maxDrawdownPct) {
      exitReason = `drawdown ${drawdownPct.toFixed(2)}% >= ${config.loop.maxDrawdownPct}%`;
    }

    if (rebalancedAny) session.lastRebalanceAt = Date.now();
    state.session = session;
    await this.store.save(state);

    return {
      inRange: snapshot.inRange,
      lpValueUsd,
      hedgeAccountValueUsd: account.accountValueUsd,
      equityUsd,
      drawdownPct,
      legs,
      actions,
      exitReason,
      hedgeDegraded: legs.some((l) => l.hedgeFailed),
    };
  }

  /**
   * Target short size per Hyperliquid symbol, in contract units.
   *
   * Each pool side contributes its own token balance as delta (see the proof in
   * `math/deltaNeutral.ts`). Contributions are summed per symbol so a pool whose
   * two sides map to the same perp — wBTC/cbBTC, say — produces one combined
   * short instead of two competing ones.
   */
  private deltaTargets(tokens: PoolTokens, snapshot: PositionSnapshot): Map<string, number> {
    const targets = new Map<string, number>();

    for (const [token, units] of [
      [tokens.x, snapshot.xUnits],
      [tokens.y, snapshot.yUnits],
    ] as const) {
      if (token.kind !== "hedgeable") continue;
      const symbol = token.hlSymbol!;
      const contracts = units / hlSizeMultiplier(symbol);
      targets.set(symbol, (targets.get(symbol) ?? 0) + contracts);
    }

    return targets;
  }

  private async poolTokens(session: Session, pool: LpVenue): Promise<PoolTokens> {
    const { classifyPool } = await import("../tokens.js");
    const eligibility = classifyPool(pool.mintX, pool.mintY);
    if (!eligibility.eligible) {
      throw new Error(
        `Pool ${session.poolName} is no longer classifiable: ${eligibility.reason}`,
      );
    }
    return eligibility.tokens;
  }

  // ------------------------------------------------------------------ close

  /**
   * Unwind everything.
   *
   * The LP position is withdrawn first: once the spot side is gone the hedge is
   * a plain short we can flatten with a reduce-only order. Doing it the other
   * way round would leave the spot bag directionally exposed while the slower
   * on-chain withdrawal confirms.
   */
  async close(): Promise<void> {
    const state = await this.store.load();
    const session = state.session;
    if (!session) {
      logger.info("no open session; nothing to close");
      return;
    }

    let lpClosed = false;
    try {
      const pool = await this.openPool(session.poolAddress);
      const sigs = await pool.closePosition(session.positionPubkey);
      logger.info({ transactions: sigs.length }, "LP position closed");
      lpClosed = true;
    } catch (error) {
      logger.error(
        { err: String(error) },
        "failed to close the LP position; leaving the hedge in place so the position stays hedged",
      );
    }

    if (!lpClosed) {
      throw new Error(
        "LP position could not be closed. The hedge was left open on purpose — the spot " +
          "side is still exposed. Retry, or close both legs manually.",
      );
    }

    for (const leg of session.hedgeLegs) {
      try {
        await this.hedger.closePosition(leg.symbol);
      } catch (error) {
        logger.error(
          { symbol: leg.symbol, err: String(error) },
          "FAILED to close hedge leg — close it manually on Hyperliquid",
        );
        throw error;
      }
    }

    await this.store.clearSession();
    logger.info("session closed");
  }

  // -------------------------------------------------------------------- run

  /** Open a session if needed, then monitor until an exit condition fires. */
  async run(poolAddress?: string): Promise<void> {
    let state = await this.store.load();
    if (!state.session) {
      await this.open(poolAddress);
      state = await this.store.load();
    } else {
      logger.info(
        { pool: state.session.poolName, position: state.session.positionPubkey },
        "resuming existing session",
      );
    }

    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      logger.info("shutdown requested; finishing the current tick then exiting");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    while (!stopping) {
      try {
        const report = await this.tick();
        logTick(report);

        if (report.exitReason) {
          logger.warn({ reason: report.exitReason }, "exit condition met; unwinding");
          await this.close();
          return;
        }
      } catch (error) {
        logger.error({ err: String(error) }, "tick failed; retrying after the poll interval");
      }

      const waited = await sleepInterruptible(config.loop.pollIntervalMs, () => stopping);
      if (!waited) break;
    }

    logger.info(
      "loop stopped. The position and hedge are still open — run the close command to unwind.",
    );
  }

  // ----------------------------------------------------------------- status

  async status(): Promise<{ session: Session | null; report: TickReport | null }> {
    const state = await this.store.load();
    if (!state.session) return { session: null, report: null };

    // A status read must not trade, so mirror the tick's reads without writes.
    const pool = await this.openPool(state.session.poolAddress);
    const snapshot = await pool.snapshot(state.session.positionPubkey);
    if (!snapshot) return { session: state.session, report: null };

    const markets = await this.hedger.marketLookup();
    const account = await this.hedger.getAccountState();
    const tokens = await this.poolTokens(state.session, pool);
    const prices = priceTokensUsd(tokens, markets, snapshot.priceXInY);
    if (!prices) throw new Error("Could not price the pool tokens in USD");

    const lpValueUsd = snapshot.xUnits * prices.priceXUsd + snapshot.yUnits * prices.priceYUsd;
    const equityUsd = lpValueUsd + account.accountValueUsd;

    const legs = [...this.deltaTargets(tokens, snapshot)].map(([symbol, targetUnits]) => {
      const market = markets(symbol);
      const position = account.positions.get(symbol);
      const szi = position?.szi ?? 0;
      const px = market?.markPx ?? 0;
      return {
        symbol,
        targetShort: targetUnits,
        currentSzi: szi,
        driftUsd: Math.abs(szi + targetUnits) * px,
        rebalanced: false,
        hedgeFailed: false,
        liquidationPx: position?.liquidationPx ?? null,
        effectiveLeverage: effectiveLeverage(Math.abs(szi) * px, position?.marginUsedUsd ?? 0),
      };
    });

    return {
      session: state.session,
      report: {
        inRange: snapshot.inRange,
        lpValueUsd,
        hedgeAccountValueUsd: account.accountValueUsd,
        equityUsd,
        drawdownPct:
          state.session.startEquityUsd > 0
            ? ((state.session.startEquityUsd - equityUsd) / state.session.startEquityUsd) * 100
            : 0,
        legs,
        actions: [],
        exitReason: null,
        hedgeDegraded: false,
      },
    };
  }

  /** Exposed for the CLI's pool listing. */
  async fetchPool(address: string): Promise<PoolMetrics> {
    return this.api.fetchPair(address);
  }

  async marketLookup(): Promise<MarketLookup> {
    return this.hedger.marketLookup();
  }

  get hedgeAccount(): string {
    return this.hedger.address;
  }

  async accountState(): Promise<AccountState> {
    return this.hedger.getAccountState();
  }
}

/** Sleep in short slices so Ctrl-C is responsive. Returns false if interrupted. */
async function sleepInterruptible(totalMs: number, cancelled: () => boolean): Promise<boolean> {
  const slice = 500;
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (cancelled()) return false;
    await sleep(Math.min(slice, totalMs - elapsed));
    elapsed += slice;
  }
  return !cancelled();
}

function logSummary(plan: PositionPlan): void {
  logger.info(
    {
      pool: plan.pool.name,
      address: plan.pool.address,
      binStep: plan.pool.binStep,
      feeTvl24h: `${(plan.pool.feeTvlRatio24h * 100).toFixed(2)}%/day`,
      range: `${(plan.range.lowerPriceRatio * 100 - 100).toFixed(2)}% .. +${(
        plan.range.upsideDistance * 100
      ).toFixed(2)}%`,
      bins: `${plan.range.minBinId}..${plan.range.maxBinId}`,
      deposit: `${plan.deposit.xUnits.toFixed(4)} ${plan.tokens.x.symbol} + ${plan.deposit.yUnits.toFixed(4)} ${plan.tokens.y.symbol}`,
      hedge: plan.legs.map(
        (l) =>
          `short ${l.size.toFixed(4)} ${l.symbol} @ ${l.leverage}x ` +
          `($${l.collateralUsd.toFixed(0)} margin, liq $${l.liquidationPx.toFixed(4)})`,
      ),
      netApr: `${(plan.expectedReturn.netAprOnTotalCapital * 100).toFixed(1)}%`,
    },
    "position plan",
  );
  for (const warning of plan.warnings) logger.warn(warning);
}

function logTick(report: TickReport): void {
  logger.info(
    {
      inRange: report.inRange,
      lpUsd: report.lpValueUsd.toFixed(2),
      hedgeUsd: report.hedgeAccountValueUsd.toFixed(2),
      equityUsd: report.equityUsd.toFixed(2),
      drawdown: `${report.drawdownPct.toFixed(2)}%`,
      legs: report.legs.map(
        (l) =>
          `${l.symbol} szi=${l.currentSzi} target=${-l.targetShort.toFixed(4)} ` +
          `drift=$${l.driftUsd.toFixed(2)} lev=${l.effectiveLeverage.toFixed(2)}x`,
      ),
    },
    "tick",
  );
  for (const action of report.actions) logger.info(`  → ${action}`);
}
