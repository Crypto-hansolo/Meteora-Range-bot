import { config } from "../config.js";
import type { AccountState, FillResult, LivePosition } from "../hedge/hyperliquid.js";
import { HyperliquidHedger } from "../hedge/hyperliquid.js";
import { logger } from "../logger.js";
import { DlmmPool, type OpenPositionResult, type PositionSnapshot } from "../meteora/dlmm.js";
import { PaperBroker } from "../sim/broker.js";
import { SimulatedLpPosition } from "../sim/lpPosition.js";
import type { StrategyName } from "../sim/distribution.js";
import type { HedgeVenue, LpVenue } from "../strategy/venues.js";
import type { MarketSnapshot } from "../strategy/planner.js";

/**
 * Paper-trading venues: real market data, simulated execution.
 *
 * Prices, funding rates, margin tiers and the pool's active bin are all read
 * live. Only the fills are simulated. That combination is what makes paper
 * mode worth running — it exercises the production decision loop against the
 * market as it actually is, and the only thing standing in for reality is the
 * assumption that an IOC at mark ± slippage would have filled.
 */

// ---------------------------------------------------------------------------
// Perp side
// ---------------------------------------------------------------------------

export class PaperHedger implements HedgeVenue {
  private readonly broker: PaperBroker;
  private readonly live = new HyperliquidHedger();
  private markets: Map<string, MarketSnapshot> = new Map();
  private lastFundingAt = Date.now();

  readonly canTrade = true;
  readonly address = "paper";

  constructor(startingCollateralUsd: number, takerFee = 0.00045) {
    this.broker = new PaperBroker({
      takerFee,
      slippage: config.hedge.slippageBps / 10_000,
      startingCollateralUsd,
    });
  }

  async marketLookup(): Promise<(symbol: string) => MarketSnapshot | undefined> {
    this.markets = await this.live.loadMarkets();
    for (const [symbol, market] of this.markets) {
      this.broker.registerMarket(symbol, market.marginTiers);
    }
    return (symbol: string) => this.markets.get(symbol);
  }

  private mark(symbol: string): number {
    const px = this.markets.get(symbol)?.markPx;
    if (px === undefined) throw new Error(`PaperHedger: no mark price for ${symbol}`);
    return px;
  }

  /**
   * Accrue funding for the time since the last call, using each market's
   * current hourly rate. Real settlements are hourly; prorating keeps a
   * shorter poll interval from over- or under-charging.
   */
  private accrueFunding(): void {
    const now = Date.now();
    const hours = (now - this.lastFundingAt) / 3_600_000;
    this.lastFundingAt = now;
    if (hours <= 0) return;

    for (const [symbol, market] of this.markets) {
      if (this.broker.sizeOf(symbol) === 0) continue;
      this.broker.applyFunding(symbol, market.fundingHourly * hours, market.markPx);
    }
  }

  async getAccountState(): Promise<AccountState> {
    if (!this.markets.size) await this.marketLookup();
    this.accrueFunding();

    const marks = (symbol: string) => this.markets.get(symbol)?.markPx ?? 0;
    const liquidated = this.broker.checkLiquidations(marks, Date.now());
    for (const symbol of liquidated) {
      logger.error({ symbol }, "PAPER: position liquidated");
    }

    const positions = new Map<string, LivePosition>();
    for (const [symbol] of this.markets) {
      const p = this.broker.getPosition(symbol);
      if (!p || p.szi === 0) continue;
      const markPx = marks(symbol);
      positions.set(symbol, {
        symbol,
        szi: p.szi,
        entryPx: p.entryPx,
        positionValueUsd: Math.abs(p.szi) * markPx,
        unrealizedPnlUsd: p.szi * (markPx - p.entryPx),
        marginUsedUsd: p.marginUsd,
        liquidationPx: this.broker.liquidationPx(symbol),
        leverage: { type: "isolated", value: p.leverage },
        maxLeverage: this.markets.get(symbol)?.maxLeverage ?? p.leverage,
      });
    }

    const accountValue = this.broker.accountValueUsd(marks);
    return {
      accountValueUsd: accountValue,
      withdrawableUsd: this.broker.freeCollateralUsd,
      totalNotionalUsd: [...positions.values()].reduce((s, p) => s + p.positionValueUsd, 0),
      positions,
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.broker.setLeverage(symbol, leverage);
    logger.info({ symbol, leverage, paper: true }, "leverage set");
  }

  async adjustIsolatedMargin(symbol: string, usdDelta: number): Promise<void> {
    // Margin top-ups move cash between free collateral and the position; the
    // broker sizes margin from leverage, so record the intent and move on.
    logger.info({ symbol, usdDelta, paper: true }, "margin top-up (no-op in paper mode)");
  }

  async trade(params: { symbol: string; size: number }): Promise<FillResult | null> {
    if (!this.markets.size) await this.marketLookup();
    const markPx = this.mark(params.symbol);

    const fill = this.broker.trade({ symbol: params.symbol, size: params.size, markPx });
    if (!fill) {
      logger.warn(
        { symbol: params.symbol, size: params.size, paper: true },
        "trade rejected (insufficient paper collateral)",
      );
      return null;
    }

    logger.info(
      { symbol: fill.symbol, side: fill.side, size: fill.size, px: fill.price, paper: true },
      "paper fill",
    );

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

  /** Cost breakdown for the paper session summary. */
  stats(): {
    realizedPnlUsd: number;
    feesPaidUsd: number;
    slippageUsd: number;
    fundingUsd: number;
    fills: number;
    liquidations: number;
  } {
    return {
      realizedPnlUsd: this.broker.realizedPnlUsd,
      feesPaidUsd: this.broker.feesPaidUsd,
      slippageUsd: this.broker.slippageCostUsd,
      fundingUsd: this.broker.fundingUsd,
      fills: this.broker.fills.length,
      liquidations: this.broker.liquidations.length,
    };
  }
}

// ---------------------------------------------------------------------------
// LP side
// ---------------------------------------------------------------------------

/**
 * A simulated position in a real pool.
 *
 * Reads (active bin, mints, decimals, bin step) come from chain through the
 * real `DlmmPool`, so the position tracks the live market. Only the position
 * itself is simulated, which is also why this needs no wallet key.
 */
export class PaperPool implements LpVenue {
  private position: SimulatedLpPosition | null = null;
  private positionKey: string | null = null;
  private lastPrice = 0;

  private constructor(
    private readonly pool: DlmmPool,
    private readonly feeRate: number,
  ) {}

  /**
   * `feeRate` is optional: when omitted it is read from the pool itself, which
   * is what `npm run paper` without an explicit address needs — there is no
   * pool to look up beforehand, and defaulting silently would simulate the
   * wrong fee income.
   */
  static async load(poolAddress: string, feeRate?: number): Promise<PaperPool> {
    const pool = await DlmmPool.load(poolAddress);
    const rate = feeRate ?? pool.feeInfo().baseFeePct / 100;
    logger.info(
      { pool: poolAddress, feeRate: `${(rate * 100).toFixed(3)}%`, source: feeRate === undefined ? "on-chain" : "api" },
      "paper pool fee rate",
    );
    return new PaperPool(pool, rate);
  }

  get mintX(): string {
    return this.pool.mintX;
  }
  get mintY(): string {
    return this.pool.mintY;
  }
  get decimalsX(): number {
    return this.pool.decimalsX;
  }
  get decimalsY(): number {
    return this.pool.decimalsY;
  }

  async refresh(): Promise<void> {
    await this.pool.refresh();
  }

  async getActiveBin(): Promise<{ binId: number; priceXInY: number }> {
    const bin = await this.pool.getActiveBin();
    this.lastPrice = bin.priceXInY;
    return bin;
  }

  async openPosition(params: {
    minBinId: number;
    maxBinId: number;
    xUnits: number;
    yUnits: number;
  }): Promise<OpenPositionResult> {
    const active = await this.getActiveBin();

    this.position = new SimulatedLpPosition({
      strategy: config.lp.strategy as StrategyName,
      binStep: this.pool.binStep,
      minBinId: params.minBinId,
      maxBinId: params.maxBinId,
      activeBinId: active.binId,
      xUnits: params.xUnits,
      yUnits: params.yUnits,
      feeRate: this.feeRate,
      // Anchor so the simulator's bin ids line up with the pool's own.
      priceAtBinZero: active.priceXInY / (1 + this.pool.binStep / 10_000) ** active.binId,
    });
    this.positionKey = `paper-${Date.now()}`;

    logger.info(
      {
        bins: [params.minBinId, params.maxBinId],
        xUnits: params.xUnits,
        yUnits: params.yUnits,
        paper: true,
      },
      "paper LP position opened",
    );

    return {
      positionPubkey: this.positionKey,
      signature: "paper",
      lowerBinId: params.minBinId,
      upperBinId: params.maxBinId,
      activeBinId: active.binId,
    };
  }

  /**
   * Walk the simulated position to the pool's live price and report it in the
   * same shape the on-chain reader produces.
   */
  async snapshot(positionPubkey: string): Promise<PositionSnapshot | null> {
    if (!this.position || positionPubkey !== this.positionKey) return null;

    const active = await this.getActiveBin();
    this.position.moveToPrice(active.priceXInY);

    return {
      publicKey: positionPubkey,
      lowerBinId: this.position.minBinId,
      upperBinId: this.position.maxBinId,
      activeBinId: active.binId,
      inRange: this.position.inRange,
      xUnits: this.position.xUnits,
      yUnits: this.position.yUnits,
      unclaimedFeeXUnits: this.position.feeX,
      unclaimedFeeYUnits: this.position.feeY,
      priceXInY: active.priceXInY,
    };
  }

  async claimFees(): Promise<string[]> {
    if (!this.position) return [];
    const claimed = this.position.claimFees();
    if (claimed.x === 0 && claimed.y === 0) return [];
    logger.info({ ...claimed, paper: true }, "paper fees claimed");
    return ["paper-claim"];
  }

  async closePosition(): Promise<string[]> {
    if (!this.position) return [];
    logger.info(
      { valueUsd: this.position.valueInQuote(this.lastPrice).toFixed(2), paper: true },
      "paper LP position closed",
    );
    this.position = null;
    this.positionKey = null;
    return ["paper-close"];
  }

  /** Fees the simulated position has accrued from arbitrage flow so far. */
  accruedFeeValue(price: number): number {
    if (!this.position) return 0;
    return this.position.feeX * price + this.position.feeY;
  }
}
