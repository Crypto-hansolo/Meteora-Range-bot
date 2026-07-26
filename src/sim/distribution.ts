import BN from "bn.js";

import { sdkFns, StrategyType } from "../meteora/sdk.js";

/**
 * Meteora's own liquidity-shape math, used by both the planner and the simulator.
 *
 * These are pure functions in the SDK — no RPC, no `Mint`, no `Clock` — so the
 * bot and the backtest can agree on exactly how a deposit spreads across bins
 * instead of each carrying its own approximation.
 *
 * Verified behaviour of `Spot` over bins 95..105 with active bin 100: each
 * ask-side bin receives an equal *token amount* (1818 bps of the X deposit) and
 * the active bin receives half that on each side. Note "uniform" means uniform
 * in token amount, not in quote value.
 */

export type StrategyName = "Spot" | "Curve" | "BidAsk";

const STRATEGY: Record<StrategyName, StrategyType> = {
  Spot: StrategyType.Spot,
  Curve: StrategyType.Curve,
  BidAsk: StrategyType.BidAsk,
};

export interface BinShare {
  binId: number;
  /** Share of the total X deposit, in basis points. */
  xBps: number;
  /** Share of the total Y deposit, in basis points. */
  yBps: number;
}

/**
 * Per-bin share of a deposit for the given shape.
 *
 * Bins above the active one only receive X, bins below only receive Y, and the
 * active bin receives both — which is exactly why the position's delta shrinks
 * as price climbs through the range.
 */
export function binShares(
  strategy: StrategyName,
  activeBinId: number,
  minBinId: number,
  maxBinId: number,
): BinShare[] {
  const binIds: number[] = [];
  for (let id = minBinId; id <= maxBinId; id++) binIds.push(id);

  const raw =
    strategy === "Spot"
      ? sdkFns.calculateSpotDistribution(activeBinId, binIds)
      : strategy === "BidAsk"
        ? sdkFns.calculateBidAskDistribution(activeBinId, binIds)
        : sdkFns.calculateNormalDistribution(activeBinId, binIds);

  return raw.map((entry) => ({
    binId: entry.binId,
    xBps: Number(entry.xAmountBpsOfTotal.toString()),
    yBps: Number(entry.yAmountBpsOfTotal.toString()),
  }));
}

/**
 * The Y deposit that balances a given X deposit for this shape and range.
 *
 * This is what Meteora's UI calls auto-fill. Using it instead of assuming a
 * 50/50 split matters: for a symmetric 24-bins-per-side Spot range the SDK
 * returns a value share of about 49.4% X, not 50%, because a bin range that is
 * symmetric in bin count is symmetric in *log* price and so reaches further up
 * than down.
 */
export function autoFillY(params: {
  strategy: StrategyName;
  activeBinId: number;
  binStep: number;
  minBinId: number;
  maxBinId: number;
  xRaw: BN;
  /** Current X reserve of the active bin; affects only that bin's split. */
  activeBinXRaw?: BN;
  /** Current Y reserve of the active bin. */
  activeBinYRaw?: BN;
}): BN {
  return sdkFns.autoFillYByStrategy(
    params.activeBinId,
    params.binStep,
    params.xRaw,
    params.activeBinXRaw ?? new BN(0),
    params.activeBinYRaw ?? new BN(0),
    params.minBinId,
    params.maxBinId,
    STRATEGY[params.strategy],
  );
}

/**
 * Value share held in X for a balanced deposit, as a fraction of total value.
 *
 * Derived from the SDK's own auto-fill rather than assumed, so the hedge is
 * sized against the ratio the pool will actually accept.
 *
 * ## On the price used here
 *
 * The SDK works in *price per lamport*, which for the active bin is exactly
 * `(1 + binStep/1e4) ^ activeBinId`. That is the price its auto-fill balances
 * against, so it is the price this calculation must use — feeding in a real
 * token price instead silently mixes two scales and inflates the X share.
 *
 * The result is still the correct human-scale share, because the decimals
 * factor cancels:
 *
 *     pricePerToken = pricePerLamport * 10^(decX - decY)
 *     xValue = (xRaw / 10^decX) * pricePerToken = xRaw * pricePerLamport / 10^decY
 *     yValue = yRaw / 10^decY
 *     share  = xRaw * pricePerLamport / (xRaw * pricePerLamport + yRaw)
 *
 * so the share depends only on bin geometry, never on decimals or spot price.
 */
export function balancedValueShareX(params: {
  strategy: StrategyName;
  activeBinId: number;
  binStep: number;
  minBinId: number;
  maxBinId: number;
}): number {
  // The share is scale-invariant, so any probe amount works. 1e12 keeps plenty
  // of integer precision for the SDK's BN math.
  const PROBE = new BN("1000000000000");
  const y = autoFillY({ ...params, xRaw: PROBE });

  const pricePerLamport = (1 + params.binStep / 10_000) ** params.activeBinId;
  const xValue = Number(PROBE.toString()) * pricePerLamport;
  const yValue = Number(y.toString());
  const total = xValue + yValue;
  if (!Number.isFinite(total) || total <= 0) return 0.5;
  return xValue / total;
}
