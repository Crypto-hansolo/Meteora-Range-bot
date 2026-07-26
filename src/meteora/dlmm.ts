import type { LbPosition, StrategyType as StrategyTypeEnum } from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { connection, sendTransaction, sendTransactions, wallet } from "../solana.js";
import { DLMM, StrategyType, type Dlmm } from "./sdk.js";

/** Raw on-chain amount -> human units. */
export function toUi(raw: BN | string, decimals: number): number {
  const bn = typeof raw === "string" ? new BN(raw) : raw;
  // Split to stay inside double precision for large raw amounts.
  const divisor = new BN(10).pow(new BN(decimals));
  const whole = bn.div(divisor).toNumber();
  const remainder = bn.mod(divisor).toNumber() / 10 ** decimals;
  return whole + remainder;
}

/** Human units -> raw on-chain amount, truncated. */
export function toRaw(amount: number, decimals: number): BN {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`toRaw: invalid amount ${amount}`);
  }
  // Go through a fixed-point string so large values keep full precision.
  const [whole = "0", frac = ""] = amount.toFixed(decimals).split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return new BN(whole + padded);
}

/**
 * The delta-carrying content of a DLMM position.
 *
 * Unclaimed fees are included: they are spot token balances sitting in the
 * position and move with price exactly like the deposited liquidity does.
 */
export interface PositionSnapshot {
  publicKey: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  inRange: boolean;
  /** Token X held, including unclaimed X fees. */
  xUnits: number;
  /** Token Y held, including unclaimed Y fees. */
  yUnits: number;
  unclaimedFeeXUnits: number;
  unclaimedFeeYUnits: number;
  /** Pool spot price of X quoted in Y. */
  priceXInY: number;
}

export interface OpenPositionResult {
  positionPubkey: string;
  signature: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
}

const STRATEGY_MAP: Record<"Spot" | "Curve" | "BidAsk", StrategyTypeEnum> = {
  Spot: StrategyType.Spot,
  Curve: StrategyType.Curve,
  BidAsk: StrategyType.BidAsk,
};

/**
 * Thin wrapper over `@meteora-ag/dlmm` for one pool.
 *
 * Everything the strategy needs is expressed in human units here so the engine
 * never juggles BN and decimals.
 */
export class DlmmPool {
  private constructor(
    readonly address: PublicKey,
    private readonly dlmm: Dlmm,
  ) {}

  static async load(poolAddress: string): Promise<DlmmPool> {
    const pubkey = new PublicKey(poolAddress);
    const dlmm = await DLMM.create(connection, pubkey);
    return new DlmmPool(pubkey, dlmm);
  }

  get binStep(): number {
    return this.dlmm.lbPair.binStep;
  }

  get decimalsX(): number {
    return this.dlmm.tokenX.mint.decimals;
  }

  get decimalsY(): number {
    return this.dlmm.tokenY.mint.decimals;
  }

  get mintX(): string {
    return this.dlmm.tokenX.publicKey.toBase58();
  }

  get mintY(): string {
    return this.dlmm.tokenY.publicKey.toBase58();
  }

  async refresh(): Promise<void> {
    await this.dlmm.refetchStates();
  }

  /** Active bin id and its price (X quoted in Y, in human units). */
  async getActiveBin(): Promise<{ binId: number; priceXInY: number }> {
    const bin = await this.dlmm.getActiveBin();
    return { binId: bin.binId, priceXInY: Number(bin.pricePerToken) };
  }

  /**
   * Open a position over `[minBinId, maxBinId]`.
   *
   * The position address is a fresh keypair that must co-sign, so it is returned
   * for the caller to persist — losing it means losing the handle to the
   * position (though it can be recovered by scanning positions by owner).
   */
  async openPosition(params: {
    minBinId: number;
    maxBinId: number;
    xUnits: number;
    yUnits: number;
  }): Promise<OpenPositionResult> {
    const owner = wallet();
    const positionKeypair = Keypair.generate();
    const active = await this.getActiveBin();

    const totalXAmount = toRaw(params.xUnits, this.decimalsX);
    const totalYAmount = toRaw(params.yUnits, this.decimalsY);

    logger.info(
      {
        pool: this.address.toBase58(),
        position: positionKeypair.publicKey.toBase58(),
        bins: [params.minBinId, params.maxBinId],
        activeBinId: active.binId,
        xUnits: params.xUnits,
        yUnits: params.yUnits,
        strategy: config.lp.strategy,
      },
      "opening DLMM position",
    );

    const tx = await this.dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: owner.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId: params.minBinId,
        maxBinId: params.maxBinId,
        strategyType: STRATEGY_MAP[config.lp.strategy],
      },
      slippage: config.lp.slippagePct,
    });

    const signature = await sendTransaction(tx, [positionKeypair], "open-position");

    return {
      positionPubkey: positionKeypair.publicKey.toBase58(),
      signature,
      lowerBinId: params.minBinId,
      upperBinId: params.maxBinId,
      activeBinId: active.binId,
    };
  }

  /** Fetch every position this wallet owns in the pool. */
  async getOwnedPositions(): Promise<LbPosition[]> {
    const { userPositions } = await this.dlmm.getPositionsByUserAndLbPair(wallet().publicKey);
    return userPositions;
  }

  /** Read one position and convert it to human units. */
  async snapshot(positionPubkey: string): Promise<PositionSnapshot | null> {
    const target = new PublicKey(positionPubkey);
    const { activeBin, userPositions } = await this.dlmm.getPositionsByUserAndLbPair(
      wallet().publicKey,
    );

    const position = userPositions.find((p) => p.publicKey.equals(target));
    if (!position) return null;

    return this.toSnapshot(position, activeBin.binId, Number(activeBin.pricePerToken));
  }

  private toSnapshot(
    position: LbPosition,
    activeBinId: number,
    priceXInY: number,
  ): PositionSnapshot {
    const d = position.positionData;

    const feeXUnits = toUi(d.feeX, this.decimalsX);
    const feeYUnits = toUi(d.feeY, this.decimalsY);

    return {
      publicKey: position.publicKey.toBase58(),
      lowerBinId: d.lowerBinId,
      upperBinId: d.upperBinId,
      activeBinId,
      inRange: activeBinId >= d.lowerBinId && activeBinId <= d.upperBinId,
      xUnits: toUi(d.totalXAmount.split(".")[0] ?? "0", this.decimalsX) + feeXUnits,
      yUnits: toUi(d.totalYAmount.split(".")[0] ?? "0", this.decimalsY) + feeYUnits,
      unclaimedFeeXUnits: feeXUnits,
      unclaimedFeeYUnits: feeYUnits,
      priceXInY,
    };
  }

  /** Claim accrued swap fees without touching the liquidity. */
  async claimFees(positionPubkey: string): Promise<string[]> {
    const owner = wallet();
    const positions = await this.getOwnedPositions();
    const position = positions.find((p) => p.publicKey.toBase58() === positionPubkey);
    if (!position) throw new Error(`Position ${positionPubkey} not found`);

    if (position.positionData.feeX.isZero() && position.positionData.feeY.isZero()) {
      logger.debug({ position: positionPubkey }, "no fees to claim");
      return [];
    }

    const txs = await this.dlmm.claimSwapFee({ owner: owner.publicKey, position });
    return sendTransactions(txs, [], "claim-fees");
  }

  /**
   * Withdraw all liquidity, claim fees and close the position account.
   *
   * `shouldClaimAndClose` makes the SDK bundle the fee claim and the account
   * close, which also reclaims the position rent.
   */
  async closePosition(positionPubkey: string): Promise<string[]> {
    const owner = wallet();
    const positions = await this.getOwnedPositions();
    const position = positions.find((p) => p.publicKey.toBase58() === positionPubkey);
    if (!position) {
      logger.warn({ position: positionPubkey }, "position not found; already closed?");
      return [];
    }

    const txs = await this.dlmm.removeLiquidity({
      user: owner.publicKey,
      position: position.publicKey,
      fromBinId: position.positionData.lowerBinId,
      toBinId: position.positionData.upperBinId,
      bps: new BN(10_000), // 100%
      shouldClaimAndClose: true,
    });

    return sendTransactions(txs, [], "close-position");
  }

  /** Pool fee rates, for display. */
  feeInfo(): { baseFeePct: number; maxFeePct: number; dynamicFeePct: number } {
    const info = this.dlmm.getFeeInfo();
    return {
      baseFeePct: info.baseFeeRatePercentage.toNumber(),
      maxFeePct: info.maxFeeRatePercentage.toNumber(),
      dynamicFeePct: this.dlmm.getDynamicFee().toNumber(),
    };
  }
}
