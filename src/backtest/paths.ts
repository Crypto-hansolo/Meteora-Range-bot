import type { Candle } from "./data.js";

/**
 * Synthetic price paths for Monte Carlo runs.
 *
 * ## Why not plain geometric Brownian motion
 *
 * GBM would flatter this strategy badly. Delta-neutral LPing is short gamma and
 * short tails: it bleeds in proportion to *realised* variance and gets hurt most
 * by sudden gaps, which are exactly the two things GBM understates. So the
 * generator adds the two features that matter:
 *
 * - **Volatility clustering** (GARCH(1,1)): quiet stretches and violent
 *   stretches, instead of uniform noise. Rebalancing costs concentrate in the
 *   violent ones.
 * - **Fat tails** (Student-t innovations): occasional moves far larger than a
 *   normal distribution allows, which is where liquidations and blown ranges
 *   come from.
 *
 * It is still a model, not history. Real markets also trend, mean-revert and
 * correlate with funding, none of which is here. Treat the output as a spread of
 * plausible outcomes, not a forecast.
 */

/** Deterministic PRNG (mulberry32) so a run can be reproduced from its seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Student-t innovation, normalised to unit variance.
 *
 * `df` controls tail weight: 4 gives noticeably fatter tails than a normal
 * while keeping variance finite (which needs df > 2).
 */
function studentT(rng: () => number, df: number): number {
  // t = Z / sqrt(W/df) with W ~ chi-square(df), built from normals.
  let w = 0;
  for (let i = 0; i < df; i++) {
    const z = gaussian(rng);
    w += z * z;
  }
  const t = gaussian(rng) / Math.sqrt(w / df);
  // Var(t) = df/(df-2); divide it out so `annualVol` means what it says.
  return t / Math.sqrt(df / (df - 2));
}

export interface PathParams {
  seed: number;
  /** Bars to generate. */
  bars: number;
  /** Length of one bar in ms. */
  barMs: number;
  startPrice: number;
  /** Long-run annualised volatility, e.g. 0.8 for 80%. */
  annualVol: number;
  /** Annualised drift. 0 keeps the test about volatility, not direction. */
  annualDrift?: number;
  /** GARCH persistence. Higher means longer-lived calm and stormy stretches. */
  garchBeta?: number;
  /** GARCH reaction to the last shock. */
  garchAlpha?: number;
  /** Student-t degrees of freedom; lower is fatter-tailed. */
  tailDf?: number;
  /** Sub-steps per bar, used to build honest highs and lows. */
  subSteps?: number;
}

/**
 * Generate one candle series.
 *
 * Highs and lows come from actually walking sub-steps inside each bar rather
 * than being decorated on afterwards, so the intrabar range reflects the same
 * process as the closes. That matters because the backtest's intrabar mode
 * hedges against those highs and lows.
 */
export function generatePath(params: PathParams): Candle[] {
  const {
    seed,
    bars,
    barMs,
    startPrice,
    annualVol,
    annualDrift = 0,
    garchBeta = 0.9,
    garchAlpha = 0.08,
    tailDf = 4,
    subSteps = 4,
  } = params;

  const rng = makeRng(seed);
  const barsPerYear = (365 * 24 * 3_600_000) / barMs;
  const targetVar = annualVol ** 2 / barsPerYear;
  const driftPerBar = annualDrift / barsPerYear;

  // omega pins the long-run variance to the target: var = omega/(1-alpha-beta).
  const persistence = garchAlpha + garchBeta;
  if (persistence >= 1) throw new Error("generatePath: garchAlpha + garchBeta must be < 1");
  const omega = targetVar * (1 - persistence);

  let variance = targetVar;
  let lastShock = 0;
  let price = startPrice;

  const candles: Candle[] = [];

  for (let i = 0; i < bars; i++) {
    variance = omega + garchAlpha * lastShock ** 2 + garchBeta * variance;
    const sigma = Math.sqrt(variance);

    const open = price;
    let high = open;
    let low = open;
    let shock = 0;

    const subSigma = sigma / Math.sqrt(subSteps);
    for (let s = 0; s < subSteps; s++) {
      const step = subSigma * studentT(rng, tailDf) + driftPerBar / subSteps;
      shock += step;
      price *= Math.exp(step);
      high = Math.max(high, price);
      low = Math.min(low, price);
    }

    lastShock = shock;
    candles.push({ t: i * barMs, T: (i + 1) * barMs, open, high, low, close: price, volume: 0 });
  }

  return candles;
}

/** Realised annualised volatility of a path, to check it hit the target. */
export function realisedVol(candles: Candle[], barMs: number): number {
  if (candles.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    returns.push(Math.log(candles[i]!.close / candles[i - 1]!.close));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const barsPerYear = (365 * 24 * 3_600_000) / barMs;
  return Math.sqrt(variance * barsPerYear);
}
