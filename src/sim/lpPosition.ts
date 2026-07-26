import { binPriceRatio } from "../math/bins.js";
import { binShares, type StrategyName } from "./distribution.js";

/**
 * A DLMM position simulated bin by bin.
 *
 * ## The model
 *
 * Liquidity Book pools are discrete: bins above the active one hold only the
 * base token X (waiting to be sold as price rises), bins below hold only the
 * quote Y, and the active bin holds a mix. All trades inside a bin execute at
 * that bin's fixed price.
 *
 * So a price move is a walk across bins. Moving up one bin converts that bin's
 * entire X inventory to Y at the bin price; moving down converts Y to X. That
 * walk *is* the arbitrage flow: it is the minimum volume required to move the
 * pool price, and it is where the position systematically sells into rallies
 * and buys into dips.
 *
 * ## What this measures, and what it does not
 *
 * The bin walk gives the **arbitrage volume** exactly — the adverse-selection
 * side of being an LP, better known as loss-versus-rebalancing. It does *not*
 * capture two-way noise trading, which is where most real fee income comes
 * from and which leaves no trace in the price path.
 *
 * That split is deliberate. The expensive thing to guess is what volatility
 * costs you, and that is computed here from the real price path. The
 * pool-specific thing is the fee rate, and that stays an explicit dial in the
 * backtest rather than being smuggled in as a modelling assumption.
 */

export interface Bin {
  binId: number;
  /** X held in this bin, in human units. */
  x: number;
  /** Y held in this bin, in human units. */
  y: number;
}

export interface SwapResult {
  /** Quote-denominated volume that flowed through the position. */
  volumeQuote: number;
  /** Fees earned in X (charged when traders sell X into the position). */
  feeX: number;
  /** Fees earned in Y (charged when traders buy X from the position). */
  feeY: number;
  /** Bins crossed by this move. */
  binsCrossed: number;
}

export interface LpPositionParams {
  strategy: StrategyName;
  binStep: number;
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  /** Total X deposited, human units. */
  xUnits: number;
  /** Total Y deposited, human units. */
  yUnits: number;
  /** Pool swap fee as a fraction, e.g. 0.002 for 0.2%. */
  feeRate: number;
  /**
   * Price of X in Y at bin id 0. DLMM prices are `(1 + binStep/1e4)^binId`
   * scaled by token decimals; this anchor lets the simulator work in the same
   * human-readable prices the rest of the bot uses.
   */
  priceAtBinZero: number;
}

export class SimulatedLpPosition {
  private readonly bins: Map<number, Bin> = new Map();
  private readonly ratio: number;

  readonly minBinId: number;
  readonly maxBinId: number;
  readonly feeRate: number;
  readonly priceAtBinZero: number;

  private currentBinId: number;

  /** Unclaimed fees, which are spot balances and carry delta like the rest. */
  feeX = 0;
  feeY = 0;

  /** Cumulative quote volume that has crossed the position. */
  totalVolumeQuote = 0;

  constructor(params: LpPositionParams) {
    this.ratio = binPriceRatio(params.binStep);
    this.minBinId = params.minBinId;
    this.maxBinId = params.maxBinId;
    this.feeRate = params.feeRate;
    this.priceAtBinZero = params.priceAtBinZero;
    this.currentBinId = params.activeBinId;

    const shares = binShares(
      params.strategy,
      params.activeBinId,
      params.minBinId,
      params.maxBinId,
    );

    for (const share of shares) {
      this.bins.set(share.binId, {
        binId: share.binId,
        x: (params.xUnits * share.xBps) / 10_000,
        y: (params.yUnits * share.yBps) / 10_000,
      });
    }
  }

  /** Price of a bin, in the same units as `priceAtBinZero`. */
  priceOfBin(binId: number): number {
    return this.priceAtBinZero * this.ratio ** binId;
  }

  /**
   * Bin id containing a given price. Bin `i` covers `[price(i), price(i+1))`.
   *
   * The epsilon absorbs floating-point error so a price sitting exactly on a
   * bin boundary does not fall into the bin below — which would otherwise show
   * up as a phantom bin crossing, complete with fake volume and fees. At about
   * 5e-7 of a bin width it is far below any real price granularity.
   */
  binIdOfPrice(price: number): number {
    const raw = Math.log(price / this.priceAtBinZero) / Math.log(this.ratio);
    return Math.floor(raw + 1e-9);
  }

  get activeBinId(): number {
    return this.currentBinId;
  }

  get inRange(): boolean {
    return this.currentBinId >= this.minBinId && this.currentBinId <= this.maxBinId;
  }

  /** Total X held, including unclaimed fees. */
  get xUnits(): number {
    let total = this.feeX;
    for (const bin of this.bins.values()) total += bin.x;
    return total;
  }

  /** Total Y held, including unclaimed fees. */
  get yUnits(): number {
    let total = this.feeY;
    for (const bin of this.bins.values()) total += bin.y;
    return total;
  }

  /** Position value in quote units at the given price. */
  valueInQuote(price: number): number {
    return this.xUnits * price + this.yUnits;
  }

  /** Snapshot of every bin, for inspection and tests. */
  snapshotBins(): Bin[] {
    return [...this.bins.values()].sort((a, b) => a.binId - b.binId);
  }

  claimFees(): { x: number; y: number } {
    const claimed = { x: this.feeX, y: this.feeY };
    this.feeX = 0;
    this.feeY = 0;
    return claimed;
  }

  /**
   * Walk the position to a new price, converting inventory bin by bin.
   *
   * Fees are charged on the token traders bring in, matching DLMM behaviour: a
   * rally means traders deliver Y to take X, so the fee accrues in Y.
   */
  moveToPrice(price: number): SwapResult {
    const targetBinId = this.binIdOfPrice(price);
    return this.moveToBin(targetBinId);
  }

  private moveToBin(targetBinId: number): SwapResult {
    const result: SwapResult = { volumeQuote: 0, feeX: 0, feeY: 0, binsCrossed: 0 };

    if (targetBinId === this.currentBinId) return result;

    if (targetBinId > this.currentBinId) {
      // Price rising: each crossed bin sells its X for Y at the bin price.
      for (let id = this.currentBinId; id < targetBinId; id++) {
        const bin = this.bins.get(id);
        result.binsCrossed++;
        if (!bin || bin.x <= 0) continue;

        const binPrice = this.priceOfBin(id);
        const soldX = bin.x;
        const grossY = soldX * binPrice;
        // Traders pay in Y, so the fee is taken in Y.
        const fee = grossY * this.feeRate;

        bin.x = 0;
        bin.y += grossY;
        this.feeY += fee;

        result.volumeQuote += grossY;
        result.feeY += fee;
      }
    } else {
      // Price falling: each crossed bin spends its Y buying X at the bin price.
      for (let id = this.currentBinId; id > targetBinId; id--) {
        const bin = this.bins.get(id);
        result.binsCrossed++;
        if (!bin || bin.y <= 0) continue;

        const binPrice = this.priceOfBin(id);
        const spentY = bin.y;
        const boughtX = spentY / binPrice;
        // Traders pay in X, so the fee is taken in X.
        const fee = boughtX * this.feeRate;

        bin.y = 0;
        bin.x += boughtX;
        this.feeX += fee;

        result.volumeQuote += spentY;
        result.feeX += fee;
      }
    }

    this.currentBinId = targetBinId;
    this.totalVolumeQuote += result.volumeQuote;
    return result;
  }

  /**
   * Withdraw up to `usdWanted` of liquidity, scaling every bin down pro rata.
   *
   * Models topping up the perp account from the LP side. That transfer is not
   * optional in practice: in a sustained trend the hedge loses money on
   * Hyperliquid while the matching gain accumulates in the LP position on
   * Solana, so margin has to be moved across or the hedge eventually cannot be
   * maintained.
   *
   * Returns the value actually withdrawn, which is capped by what is there.
   */
  withdrawValue(price: number, usdWanted: number): number {
    if (usdWanted <= 0 || price <= 0) return 0;

    const liquidityValue = this.liquidityValueInQuote(price);
    if (liquidityValue <= 0) return 0;

    const taken = Math.min(usdWanted, liquidityValue);
    const keepFraction = 1 - taken / liquidityValue;

    for (const bin of this.bins.values()) {
      bin.x *= keepFraction;
      bin.y *= keepFraction;
    }

    return taken;
  }

  /** Position value excluding unclaimed fees. */
  liquidityValueInQuote(price: number): number {
    let x = 0;
    let y = 0;
    for (const bin of this.bins.values()) {
      x += bin.x;
      y += bin.y;
    }
    return x * price + y;
  }

  /**
   * Credit fee income that the price path cannot show.
   *
   * Round-trip noise trading generates most real fee revenue while leaving the
   * price unchanged, so it has to be supplied rather than derived. Split half
   * and half between the two tokens, which is what balanced two-way flow gives.
   */
  accrueExternalFees(volumeQuote: number, price: number): void {
    if (volumeQuote <= 0 || price <= 0) return;
    const fee = volumeQuote * this.feeRate;
    this.feeY += fee / 2;
    this.feeX += fee / 2 / price;
    this.totalVolumeQuote += volumeQuote;
  }
}
