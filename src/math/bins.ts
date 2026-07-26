/**
 * DLMM bin geometry.
 *
 * Bins are geometrically spaced: bin `i` covers price `(1 + binStep/10000)^i`.
 * So a `±w%` range needs `ln(1+w) / ln(1 + binStep/1e4)` bins per side, and the
 * width actually achieved is `(1 + binStep/1e4)^n - 1`.
 */

export const BASIS_POINT_MAX = 10_000;

/** Price multiplier between two adjacent bins. */
export function binPriceRatio(binStep: number): number {
  if (binStep <= 0) throw new Error("binPriceRatio: binStep must be > 0");
  return 1 + binStep / BASIS_POINT_MAX;
}

/** Bins needed to span `widthPct` percent of price movement. */
export function binsForPriceWidth(binStep: number, widthPct: number): number {
  if (widthPct <= 0) throw new Error("binsForPriceWidth: widthPct must be > 0");
  const bins = Math.log(1 + widthPct / 100) / Math.log(binPriceRatio(binStep));
  return Math.max(1, Math.round(bins));
}

/** Price movement, as a fraction, spanned by `bins` bins. */
export function priceWidthForBins(binStep: number, bins: number): number {
  return binPriceRatio(binStep) ** bins - 1;
}

export interface RangePlan {
  minBinId: number;
  maxBinId: number;
  binCount: number;
  binsBelow: number;
  binsAbove: number;
  /** Lower bound as a multiple of spot, e.g. 0.951. */
  lowerPriceRatio: number;
  /** Upper bound as a multiple of spot, e.g. 1.051. */
  upperPriceRatio: number;
  /** Downside distance as a fraction of spot (positive number). */
  downsideDistance: number;
  /** Upside distance as a fraction of spot. Drives hedge leverage. */
  upsideDistance: number;
  /** Set when `maxBins` forced a narrower range than requested. */
  truncated: boolean;
}

/**
 * Plan a bin range centred on the active bin.
 *
 * The range is symmetric in bin count, which means it is symmetric in *log*
 * price — the upside distance is slightly larger than the downside one, exactly
 * as Meteora's own UI behaves.
 */
export function planRange(params: {
  activeBinId: number;
  binStep: number;
  widthPct: number;
  maxBins: number;
}): RangePlan {
  const { activeBinId, binStep, widthPct, maxBins } = params;
  if (maxBins < 1) throw new Error("planRange: maxBins must be >= 1");

  const wanted = binsForPriceWidth(binStep, widthPct);
  // Total bins = below + active + above, so each side gets (maxBins - 1) / 2.
  const perSideCap = Math.max(0, Math.floor((maxBins - 1) / 2));
  const perSide = Math.min(wanted, perSideCap);

  const minBinId = activeBinId - perSide;
  const maxBinId = activeBinId + perSide;

  const lowerPriceRatio = binPriceRatio(binStep) ** -perSide;
  const upperPriceRatio = binPriceRatio(binStep) ** perSide;

  return {
    minBinId,
    maxBinId,
    binCount: maxBinId - minBinId + 1,
    binsBelow: perSide,
    binsAbove: perSide,
    lowerPriceRatio,
    upperPriceRatio,
    downsideDistance: 1 - lowerPriceRatio,
    upsideDistance: upperPriceRatio - 1,
    truncated: perSide < wanted,
  };
}

/** True when `binId` lies inside `[minBinId, maxBinId]`. */
export function isInRange(binId: number, minBinId: number, maxBinId: number): boolean {
  return binId >= minBinId && binId <= maxBinId;
}
