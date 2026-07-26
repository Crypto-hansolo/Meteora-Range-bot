import { liquidationPriceShort, maintenanceMarginFraction, type MarginTier } from "../math/deltaNeutral.js";

/**
 * A simulated Hyperliquid perp account.
 *
 * Models the parts that actually change the answer: taker fees on every fill,
 * slippage against the mark, isolated margin, funding accrual and liquidation.
 * It deliberately does not model the order book — an IOC that would not fill is
 * a fill-quality question, and pretending to answer it with synthetic depth
 * would be worse than leaving it explicit.
 */

export interface PaperBrokerConfig {
  /** Taker fee as a fraction. Hyperliquid's base tier is 0.045%. */
  takerFee: number;
  /** Slippage applied against the mark on every fill, as a fraction. */
  slippage: number;
  /** Starting collateral in USD. */
  startingCollateralUsd: number;
}

export interface PaperPosition {
  symbol: string;
  /** Signed size: negative for a short. */
  szi: number;
  /** Volume-weighted entry price. */
  entryPx: number;
  /** Isolated margin allocated to this position. */
  marginUsd: number;
  leverage: number;
  mmf: number;
}

export interface PaperFill {
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  feeUsd: number;
  slippageCostUsd: number;
}

export interface LiquidationEvent {
  symbol: string;
  price: number;
  lostMarginUsd: number;
  atMs: number;
}

export class PaperBroker {
  private readonly positions = new Map<string, PaperPosition>();
  private readonly leverageBySymbol = new Map<string, number>();
  private readonly tiersBySymbol = new Map<string, MarginTier[]>();

  /** Free collateral not committed as isolated margin. */
  freeCollateralUsd: number;

  /** Realised PnL from closed size, cumulative. */
  realizedPnlUsd = 0;
  /** Taker fees paid, cumulative. */
  feesPaidUsd = 0;
  /** Slippage cost, cumulative. */
  slippageCostUsd = 0;
  /** Funding received (positive) or paid (negative), cumulative. */
  fundingUsd = 0;

  readonly fills: PaperFill[] = [];
  readonly liquidations: LiquidationEvent[] = [];

  constructor(private readonly cfg: PaperBrokerConfig) {
    this.freeCollateralUsd = cfg.startingCollateralUsd;
  }

  registerMarket(symbol: string, tiers: MarginTier[]): void {
    this.tiersBySymbol.set(symbol, tiers);
  }

  setLeverage(symbol: string, leverage: number): void {
    this.leverageBySymbol.set(symbol, Math.max(1, Math.floor(leverage)));
  }

  getPosition(symbol: string): PaperPosition | undefined {
    return this.positions.get(symbol);
  }

  /** Signed size, 0 when flat. */
  sizeOf(symbol: string): number {
    return this.positions.get(symbol)?.szi ?? 0;
  }

  /**
   * Total account value: free collateral, plus each position's margin and
   * unrealised PnL.
   */
  accountValueUsd(marks: (symbol: string) => number): number {
    let total = this.freeCollateralUsd;
    for (const position of this.positions.values()) {
      total += position.marginUsd + this.unrealizedPnl(position, marks(position.symbol));
    }
    return total;
  }

  private unrealizedPnl(position: PaperPosition, mark: number): number {
    // Short (szi < 0) gains when price falls.
    return position.szi * (mark - position.entryPx);
  }

  /**
   * Trade `size` base units. Positive sells (opens/increases a short),
   * negative buys.
   *
   * Returns `null` when the trade is a no-op or cannot be funded.
   */
  trade(params: { symbol: string; size: number; markPx: number }): PaperFill | null {
    const { symbol, size, markPx } = params;
    if (size === 0 || markPx <= 0) return null;

    const isSell = size > 0;
    const absSize = Math.abs(size);
    // Slippage always works against us, on both sides.
    const fillPx = isSell ? markPx * (1 - this.cfg.slippage) : markPx * (1 + this.cfg.slippage);

    const notional = absSize * fillPx;
    const fee = notional * this.cfg.takerFee;
    const slip = absSize * markPx * this.cfg.slippage;

    const existing = this.positions.get(symbol);
    const currentSzi = existing?.szi ?? 0;
    // Selling makes szi more negative.
    const newSzi = currentSzi + (isSell ? -absSize : absSize);

    const leverage = this.leverageBySymbol.get(symbol) ?? 1;
    const tiers = this.tiersBySymbol.get(symbol) ?? [{ lowerBound: "0", maxLeverage: 20 }];

    if (existing && Math.sign(newSzi) !== Math.sign(currentSzi) && newSzi !== 0) {
      // A flip would mean closing and reopening on the other side. The strategy
      // never does this (reductions are reduce-only), so treat it as a bug
      // rather than silently simulating something the live path cannot do.
      throw new Error(
        `PaperBroker: trade would flip ${symbol} from ${currentSzi} to ${newSzi}; ` +
          `the hedge should only ever reduce toward zero`,
      );
    }

    const reducing = existing !== undefined && Math.abs(newSzi) < Math.abs(currentSzi);

    if (reducing) {
      const closedSize = Math.abs(currentSzi) - Math.abs(newSzi);

      // PnL on the closed portion: sign(position) * size * (exit - entry).
      // A short (sign -1) gains when the exit price is below entry.
      const pnl = Math.sign(currentSzi) * closedSize * (fillPx - existing.entryPx);
      this.realizedPnlUsd += pnl;
      this.freeCollateralUsd += pnl;

      // Release margin proportionally to the size closed.
      const releaseRatio = closedSize / Math.abs(currentSzi);
      const released = existing.marginUsd * releaseRatio;
      existing.marginUsd -= released;
      this.freeCollateralUsd += released;

      existing.szi = newSzi;
      if (newSzi === 0) {
        this.freeCollateralUsd += existing.marginUsd;
        this.positions.delete(symbol);
      }
    } else {
      // Opening or increasing: post margin for the added notional.
      const addedNotional = absSize * fillPx;
      const requiredMargin = addedNotional / leverage;
      if (requiredMargin > this.freeCollateralUsd + 1e-9) {
        return null;
      }
      this.freeCollateralUsd -= requiredMargin;

      if (existing) {
        const totalSize = Math.abs(currentSzi) + absSize;
        existing.entryPx =
          (existing.entryPx * Math.abs(currentSzi) + fillPx * absSize) / totalSize;
        existing.szi = newSzi;
        existing.marginUsd += requiredMargin;
        existing.mmf = maintenanceMarginFraction(tiers, Math.abs(newSzi) * fillPx);
      } else {
        this.positions.set(symbol, {
          symbol,
          szi: newSzi,
          entryPx: fillPx,
          marginUsd: requiredMargin,
          leverage,
          mmf: maintenanceMarginFraction(tiers, absSize * fillPx),
        });
      }
    }

    // Fees come out of free collateral, as they do on Hyperliquid.
    this.freeCollateralUsd -= fee;
    this.feesPaidUsd += fee;
    this.slippageCostUsd += slip;

    const fill: PaperFill = {
      symbol,
      side: isSell ? "sell" : "buy",
      size: absSize,
      price: fillPx,
      feeUsd: fee,
      slippageCostUsd: slip,
    };
    this.fills.push(fill);
    return fill;
  }

  /**
   * Apply one funding period.
   *
   * Hyperliquid charges funding on notional. A positive rate means longs pay
   * shorts, so a short (`szi < 0`) receives it.
   */
  applyFunding(symbol: string, rate: number, markPx: number): number {
    const position = this.positions.get(symbol);
    if (!position || position.szi === 0) return 0;

    const notional = Math.abs(position.szi) * markPx;
    const direction = position.szi < 0 ? 1 : -1;
    const payment = direction * rate * notional;

    this.freeCollateralUsd += payment;
    this.fundingUsd += payment;
    return payment;
  }

  /**
   * Liquidate any position whose isolated equity has fallen to the maintenance
   * requirement. Returns the symbols that were liquidated.
   */
  checkLiquidations(marks: (symbol: string) => number, atMs: number): string[] {
    const liquidated: string[] = [];

    for (const position of [...this.positions.values()]) {
      const mark = marks(position.symbol);
      if (!Number.isFinite(mark) || mark <= 0) continue;

      const equity = position.marginUsd + this.unrealizedPnl(position, mark);
      const maintenance = Math.abs(position.szi) * mark * position.mmf;

      if (equity <= maintenance) {
        // Isolated margin is forfeited; the rest of the account survives.
        this.realizedPnlUsd -= position.marginUsd;
        this.liquidations.push({
          symbol: position.symbol,
          price: mark,
          lostMarginUsd: position.marginUsd,
          atMs,
        });
        this.positions.delete(position.symbol);
        liquidated.push(position.symbol);
      }
    }

    return liquidated;
  }

  /** Projected liquidation price of an open short. */
  liquidationPx(symbol: string): number | null {
    const position = this.positions.get(symbol);
    if (!position || position.szi >= 0) return null;
    return liquidationPriceShort({
      size: Math.abs(position.szi),
      entryPx: position.entryPx,
      isolatedMarginUsd: position.marginUsd,
      mmf: position.mmf,
    });
  }

  /**
   * Flatten everything at the given marks, as an end-of-run settlement.
   *
   * `size` follows the sell-positive convention, so closing a short (`szi < 0`)
   * means passing the negative `szi` straight through to buy it back.
   */
  closeAll(marks: (symbol: string) => number): void {
    for (const position of [...this.positions.values()]) {
      this.trade({
        symbol: position.symbol,
        size: position.szi,
        markPx: marks(position.symbol),
      });
    }
  }
}
