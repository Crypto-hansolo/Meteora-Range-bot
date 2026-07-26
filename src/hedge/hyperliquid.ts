import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { formatPrice, formatSize, SymbolConverter } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { MarginTier } from "../math/deltaNeutral.js";
import type { MarketSnapshot } from "../strategy/planner.js";

export interface LivePosition {
  symbol: string;
  /** Signed size: negative for a short. */
  szi: number;
  entryPx: number;
  positionValueUsd: number;
  unrealizedPnlUsd: number;
  marginUsedUsd: number;
  liquidationPx: number | null;
  leverage: { type: "isolated" | "cross"; value: number };
  maxLeverage: number;
}

export interface AccountState {
  accountValueUsd: number;
  withdrawableUsd: number;
  totalNotionalUsd: number;
  positions: Map<string, LivePosition>;
}

export interface FillResult {
  symbol: string;
  side: "buy" | "sell";
  requestedSize: number;
  filledSize: number;
  avgPx: number | null;
  /** Order id, when the remainder rested instead of filling. */
  restingOid?: number;
  dryRun: boolean;
}

/**
 * Hyperliquid hedging client.
 *
 * Orders are IOC limit orders priced through the book by `HEDGE_SLIPPAGE_BPS`
 * rather than true market orders, which keeps a bad fill bounded: an IOC that
 * cannot fill inside the band is simply cancelled and retried on the next loop
 * instead of eating the whole book.
 */
export class HyperliquidHedger {
  private readonly info: InfoClient;
  private readonly exchange: ExchangeClient | null;
  private readonly transport: HttpTransport;
  /** Address whose positions we read (the master account, not the agent). */
  private readonly accountAddress: `0x${string}`;
  private converter: SymbolConverter | null = null;
  private marketCache: { at: number; markets: Map<string, MarketSnapshot> } | null = null;

  constructor() {
    this.transport = new HttpTransport({ isTestnet: config.hyperliquid.testnet });
    this.info = new InfoClient({ transport: this.transport });

    if (config.hyperliquid.privateKey) {
      const key = config.hyperliquid.privateKey.startsWith("0x")
        ? (config.hyperliquid.privateKey as `0x${string}`)
        : (`0x${config.hyperliquid.privateKey}` as `0x${string}`);
      const wallet = privateKeyToAccount(key);
      this.exchange = new ExchangeClient({ transport: this.transport, wallet });
      this.accountAddress = (config.hyperliquid.accountAddress || wallet.address) as `0x${string}`;
    } else {
      this.exchange = null;
      this.accountAddress = (config.hyperliquid.accountAddress || `0x${"0".repeat(40)}`) as `0x${string}`;
    }
  }

  /** True when the hedger can actually place orders. */
  get canTrade(): boolean {
    return this.exchange !== null;
  }

  get address(): string {
    return this.accountAddress;
  }

  // ------------------------------------------------------------------ reads

  /**
   * Load every perp market with mark price, funding, OI and margin tiers.
   *
   * Cached for `ttlMs` because the scanner asks for it once per pool.
   */
  async loadMarkets(ttlMs = 30_000): Promise<Map<string, MarketSnapshot>> {
    if (this.marketCache && Date.now() - this.marketCache.at < ttlMs) {
      return this.marketCache.markets;
    }

    const [meta, ctxs] = await this.info.metaAndAssetCtxs();
    const tierById = new Map<number, MarginTier[]>();
    for (const [id, table] of meta.marginTables) {
      tierById.set(id, table.marginTiers);
    }

    const markets = new Map<string, MarketSnapshot>();
    meta.universe.forEach((asset, index) => {
      if (asset.isDelisted) return;
      const ctx = ctxs[index];
      if (!ctx) return;

      const markPx = Number(ctx.markPx);
      const tiers = tierById.get(asset.marginTableId);
      if (!Number.isFinite(markPx) || markPx <= 0) return;
      if (!tiers?.length) {
        // Without a tier table we cannot compute maintenance margin, and
        // guessing it would silently mis-size the hedge.
        logger.debug({ symbol: asset.name }, "skipping perp without a margin table");
        return;
      }

      markets.set(asset.name, {
        symbol: asset.name,
        markPx,
        maxLeverage: asset.maxLeverage,
        szDecimals: asset.szDecimals,
        // `openInterest` is quoted in base units.
        openInterestUsd: Number(ctx.openInterest) * markPx,
        fundingHourly: Number(ctx.funding),
        marginTiers: tiers,
      });
    });

    this.marketCache = { at: Date.now(), markets };
    return markets;
  }

  /** Lookup function for the planner. */
  async marketLookup(): Promise<(symbol: string) => MarketSnapshot | undefined> {
    const markets = await this.loadMarkets();
    return (symbol: string) => markets.get(symbol);
  }

  async getAccountState(): Promise<AccountState> {
    const state = await this.info.clearinghouseState({ user: this.accountAddress });

    const positions = new Map<string, LivePosition>();
    for (const entry of state.assetPositions) {
      const p = entry.position;
      const szi = Number(p.szi);
      if (szi === 0) continue;
      positions.set(p.coin, {
        symbol: p.coin,
        szi,
        entryPx: Number(p.entryPx),
        positionValueUsd: Number(p.positionValue),
        unrealizedPnlUsd: Number(p.unrealizedPnl),
        marginUsedUsd: Number(p.marginUsed),
        liquidationPx: p.liquidationPx === null ? null : Number(p.liquidationPx),
        leverage: { type: p.leverage.type, value: p.leverage.value },
        maxLeverage: p.maxLeverage,
      });
    }

    return {
      accountValueUsd: Number(state.marginSummary.accountValue),
      withdrawableUsd: Number(state.withdrawable),
      totalNotionalUsd: Number(state.marginSummary.totalNtlPos),
      positions,
    };
  }

  // ----------------------------------------------------------------- writes

  private async assetId(symbol: string): Promise<number> {
    this.converter ??= await SymbolConverter.create({ transport: this.transport });
    const id = this.converter.getAssetId(symbol);
    if (id === undefined) throw new Error(`Unknown Hyperliquid symbol: ${symbol}`);
    return id;
  }

  /**
   * Set margin mode and leverage for a symbol.
   *
   * On Hyperliquid the isolated margin allocated when a position opens is
   * `notional / leverage`, so setting leverage *before* opening is what actually
   * implements the collateral plan.
   */
  async setLeverage(symbol: string, leverage: number, isolated: boolean): Promise<void> {
    const intLeverage = Math.max(1, Math.floor(leverage));

    if (config.dryRun || !this.exchange) {
      logger.info(
        { symbol, leverage: intLeverage, isolated, dryRun: true },
        "would set leverage",
      );
      return;
    }

    await this.exchange.updateLeverage({
      asset: await this.assetId(symbol),
      isCross: !isolated,
      leverage: intLeverage,
    });
    logger.info({ symbol, leverage: intLeverage, isolated }, "leverage set");
  }

  /**
   * Add or remove isolated margin for an open position.
   * `usdDelta > 0` adds margin, `< 0` withdraws it.
   */
  async adjustIsolatedMargin(symbol: string, usdDelta: number): Promise<void> {
    const ntli = Math.trunc(usdDelta);
    if (ntli === 0) return;

    if (config.dryRun || !this.exchange) {
      logger.info({ symbol, usdDelta: ntli, dryRun: true }, "would adjust isolated margin");
      return;
    }

    await this.exchange.updateIsolatedMargin({
      asset: await this.assetId(symbol),
      isBuy: true, // side of the position being topped up; ignored for one-way mode
      ntli,
    });
    logger.info({ symbol, usdDelta: ntli }, "isolated margin adjusted");
  }

  /**
   * Trade `size` base units of `symbol`.
   *
   * `size > 0` sells (opens/increases a short), `size < 0` buys (reduces it).
   * Returns `null` when the size rounds away to nothing at the asset's lot size.
   */
  async trade(params: {
    symbol: string;
    /** Positive = sell, negative = buy. */
    size: number;
    reduceOnly?: boolean;
  }): Promise<FillResult | null> {
    const { symbol, size, reduceOnly = false } = params;
    const markets = await this.loadMarkets(5_000);
    const market = markets.get(symbol);
    if (!market) throw new Error(`Unknown Hyperliquid market: ${symbol}`);

    const isSell = size > 0;
    const absSize = Math.abs(size);

    let sizeStr: string;
    try {
      sizeStr = formatSize(absSize, market.szDecimals);
    } catch {
      logger.debug({ symbol, size }, "size below the asset lot size; skipping");
      return null;
    }
    if (Number(sizeStr) <= 0) {
      logger.debug({ symbol, size, sizeStr }, "size truncated to zero; skipping");
      return null;
    }

    // Cross the spread by the configured slippage so the IOC actually fills.
    const slip = config.hedge.slippageBps / 10_000;
    const rawPx = isSell ? market.markPx * (1 - slip) : market.markPx * (1 + slip);
    const pxStr = formatPrice(rawPx, market.szDecimals);

    if (config.dryRun || !this.exchange) {
      logger.info(
        {
          symbol,
          side: isSell ? "sell" : "buy",
          size: sizeStr,
          limitPx: pxStr,
          reduceOnly,
          dryRun: true,
        },
        "would submit IOC order",
      );
      return {
        symbol,
        side: isSell ? "sell" : "buy",
        requestedSize: Number(sizeStr),
        filledSize: Number(sizeStr),
        avgPx: market.markPx,
        dryRun: true,
      };
    }

    const response = await this.exchange.order({
      orders: [
        {
          a: await this.assetId(symbol),
          b: !isSell, // b = isBuy
          p: pxStr,
          s: sizeStr,
          r: reduceOnly,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });

    const status = response.response.data.statuses[0];
    const result: FillResult = {
      symbol,
      side: isSell ? "sell" : "buy",
      requestedSize: Number(sizeStr),
      filledSize: 0,
      avgPx: null,
      dryRun: false,
    };

    // A per-order rejection never reaches us: the SDK raises ApiRequestError
    // for error statuses, which is why this only handles the success shapes.
    if (status && typeof status === "object") {
      if ("filled" in status) {
        result.filledSize = Number(status.filled.totalSz);
        result.avgPx = Number(status.filled.avgPx);
      } else if ("resting" in status) {
        result.restingOid = status.resting.oid;
      }
    }

    logger.info(
      {
        symbol,
        side: result.side,
        requested: result.requestedSize,
        filled: result.filledSize,
        avgPx: result.avgPx,
      },
      "order submitted",
    );

    if (result.filledSize + 1e-12 < result.requestedSize) {
      logger.warn(
        { symbol, requested: result.requestedSize, filled: result.filledSize },
        "IOC order filled only partially; the residual delta is picked up next loop",
      );
    }

    return result;
  }

  /** Flatten a position with a reduce-only IOC order. */
  async closePosition(symbol: string): Promise<FillResult | null> {
    const state = await this.getAccountState();
    const position = state.positions.get(symbol);
    if (!position || position.szi === 0) {
      logger.info({ symbol }, "no open position to close");
      return null;
    }
    // szi < 0 for a short: buying it back means a negative `size`.
    return this.trade({ symbol, size: position.szi, reduceOnly: true });
  }
}
