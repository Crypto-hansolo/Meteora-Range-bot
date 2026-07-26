import { config } from "../config.js";
import type { PoolMetrics } from "./api.js";
import { planPosition, type MarketLookup, type PositionPlan } from "../strategy/planner.js";

export interface PoolCandidate {
  pool: PoolMetrics;
  plan: PositionPlan;
  /**
   * Ranking score: expected net APR on *total* deployed capital
   * (LP capital + hedge collateral), including perp funding.
   */
  score: number;
}

export interface RejectedPool {
  pool: PoolMetrics;
  reason: string;
}

export interface ScanResult {
  candidates: PoolCandidate[];
  rejected: RejectedPool[];
}

/**
 * Cheap filters that need no market data, applied before planning.
 *
 * Returns a rejection reason, or `null` when the pool passes.
 */
export function prefilter(pool: PoolMetrics): string | null {
  const s = config.selection;

  if (s.poolBlacklist.has(pool.address)) return "blacklisted pool address";
  if (pool.raw.is_blacklisted) return "flagged as blacklisted by the Meteora API";
  if (pool.raw.hide) return "hidden by the Meteora API";
  if (pool.tvlUsd < s.minTvlUsd) return `TVL $${fmt(pool.tvlUsd)} < $${fmt(s.minTvlUsd)}`;
  if (pool.tvlUsd > s.maxTvlUsd) return `TVL $${fmt(pool.tvlUsd)} > $${fmt(s.maxTvlUsd)}`;
  if (pool.volume24hUsd < s.minVolume24hUsd) {
    return `24h volume $${fmt(pool.volume24hUsd)} < $${fmt(s.minVolume24hUsd)}`;
  }
  if (pool.feeTvlRatio24h < s.minFeeTvlRatio24h) {
    return `fee/TVL ${pct(pool.feeTvlRatio24h)} < ${pct(s.minFeeTvlRatio24h)}`;
  }
  if (pool.binStep < s.minBinStep || pool.binStep > s.maxBinStep) {
    return `bin step ${pool.binStep} outside [${s.minBinStep}, ${s.maxBinStep}]`;
  }
  if (pool.fees24hUsd <= 0) return "no fees earned in the last 24h";

  return null;
}

/**
 * Rank pools by the return the *hedged* strategy can actually expect.
 *
 * A raw fee/TVL ranking is misleading here: a pool whose hedge demands 50% of
 * total capital as margin, or whose perp funding is deeply negative, can easily
 * lose to a pool with a lower headline ratio. So each survivor is fully planned
 * and scored on net APR over LP capital *plus* hedge collateral.
 */
export function rankPools(pools: PoolMetrics[], markets: MarketLookup): ScanResult {
  const candidates: PoolCandidate[] = [];
  const rejected: RejectedPool[] = [];

  for (const pool of pools) {
    const preReason = prefilter(pool);
    if (preReason) {
      rejected.push({ pool, reason: preReason });
      continue;
    }

    const result = planPosition({ pool, markets });
    if (!result.ok) {
      rejected.push({ pool, reason: result.reason });
      continue;
    }

    const { plan } = result;

    if (config.selection.tokenWhitelist.length) {
      const symbols = [plan.tokens.x.symbol, plan.tokens.y.symbol].map((s) => s.toUpperCase());
      if (!symbols.some((s) => config.selection.tokenWhitelist.includes(s))) {
        rejected.push({ pool, reason: `no whitelisted token in ${symbols.join("/")}` });
        continue;
      }
    }

    const quote = plan.tokens.y.symbol.toUpperCase();
    if (!config.selection.quoteWhitelist.includes(quote)) {
      rejected.push({ pool, reason: `quote asset ${quote} not in QUOTE_WHITELIST` });
      continue;
    }

    candidates.push({ pool, plan, score: plan.expectedReturn.netAprOnTotalCapital });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates, rejected };
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
