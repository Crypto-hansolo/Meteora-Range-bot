import { z } from "zod";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchJson, HttpError } from "../util/http.js";

/**
 * Client for Meteora's public DLMM pair API.
 *
 * The schema is deliberately permissive: every metric is optional and coerced,
 * and unknown keys pass through. The API adds and renames fields over time, and
 * a strict schema would take the bot down for a cosmetic change. Anything the
 * strategy truly needs is validated in `normalizePair`.
 */

/** Coerce "1234.5" | 1234.5 | null -> number | undefined. */
const num = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

const bucketed = z
  .object({
    min_30: num,
    hour_1: num,
    hour_2: num,
    hour_4: num,
    hour_12: num,
    hour_24: num,
  })
  .partial()
  .passthrough()
  .nullish();

const rawPairSchema = z
  .object({
    address: z.string(),
    name: z.string().nullish(),
    mint_x: z.string(),
    mint_y: z.string(),
    bin_step: z.coerce.number().int(),
    base_fee_percentage: num,
    max_fee_percentage: num,
    liquidity: num,
    fees_24h: num,
    today_fees: num,
    trade_volume_24h: num,
    current_price: num,
    apr: num,
    apy: num,
    farm_apr: num,
    farm_apy: num,
    hide: z.boolean().nullish(),
    is_blacklisted: z.boolean().nullish(),
    fees: bucketed,
    fee_tvl_ratio: bucketed,
    volume: bucketed,
    tags: z.array(z.string()).nullish(),
  })
  .passthrough();

export type RawPair = z.infer<typeof rawPairSchema>;

const paginatedSchema = z
  .object({
    pairs: z.array(z.unknown()),
    total: z.coerce.number().optional(),
  })
  .passthrough();

/** A pool with everything the strategy needs, in consistent units. */
export interface PoolMetrics {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  binStep: number;
  /** Pool base fee as a fraction, e.g. 0.002 for 0.2%. */
  baseFee: number;
  tvlUsd: number;
  fees24hUsd: number;
  volume24hUsd: number;
  /**
   * Daily fees divided by TVL, as a *fraction* (0.012 = 1.2% of TVL per day).
   *
   * Computed locally from `fees_24h / liquidity` rather than trusting the API's
   * `fee_tvl_ratio`, whose unit (fraction vs percent) has changed historically.
   */
  feeTvlRatio24h: number;
  /** Spot price of X quoted in Y, as reported by the API. */
  currentPrice: number;
  tags: string[];
  raw: RawPair;
}

export type SortKey = "feetvlratio" | "tvl" | "volume" | "lm";

export interface FetchPairsOptions {
  sortKey?: SortKey;
  orderBy?: "asc" | "desc";
  /** Total pairs to pull across pages. */
  limit?: number;
  pageSize?: number;
  /** Ask the API to omit pairs with unrecognised tokens. */
  includeUnknown?: boolean;
}

export class MeteoraApi {
  constructor(private readonly baseUrl: string = config.meteora.apiUrl) {}

  /**
   * Page through `/pair/all_with_pagination`.
   *
   * Server-side sorting is a hint only — we re-rank locally after computing our
   * own fee/TVL ratio, so a sort key the API silently ignores is harmless.
   *
   * The paginated endpoint has a history of moving around; if it 404s on the
   * very first page (before any data was collected) we fall back to the plain
   * `/pair/all` listing rather than failing every read-only command.
   */
  async fetchPairs(options: FetchPairsOptions = {}): Promise<PoolMetrics[]> {
    const {
      sortKey = "feetvlratio",
      orderBy = "desc",
      limit = 400,
      pageSize = 100,
      includeUnknown = false,
    } = options;

    try {
      return await this.fetchPairsPaginated({ sortKey, orderBy, limit, pageSize, includeUnknown });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        logger.warn(
          { baseUrl: this.baseUrl },
          "/pair/all_with_pagination returned 404; falling back to /pair/all",
        );
        return this.fetchPairsUnpaginated({ sortKey, orderBy, limit });
      }
      throw error;
    }
  }

  private async fetchPairsPaginated(options: {
    sortKey: SortKey;
    orderBy: "asc" | "desc";
    limit: number;
    pageSize: number;
    includeUnknown: boolean;
  }): Promise<PoolMetrics[]> {
    const { sortKey, orderBy, limit, pageSize, includeUnknown } = options;

    const out: PoolMetrics[] = [];
    let skipped = 0;

    for (let page = 0; out.length + skipped < limit; page++) {
      const url =
        `${this.baseUrl}/pair/all_with_pagination` +
        `?page=${page}&limit=${Math.min(pageSize, limit)}` +
        `&sort_key=${sortKey}&order_by=${orderBy}` +
        `&include_unknown=${includeUnknown}`;

      const body = await fetchJson<unknown>(url, { timeoutMs: 20_000 });
      const parsed = paginatedSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          `Unexpected response from ${url}: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        );
      }

      const rows = parsed.data.pairs;
      if (rows.length === 0) break;

      for (const row of rows) {
        const parsedPair = parsePair(row);
        if (parsedPair.ok) {
          out.push(parsedPair.pool);
        } else {
          skipped++;
          logger.debug({ reason: parsedPair.reason }, "skipping pair");
        }
      }

      if (rows.length < Math.min(pageSize, limit)) break;
    }

    if (skipped > 0) logger.debug({ skipped }, "pairs skipped during normalisation");
    return out;
  }

  /**
   * Fallback for when pagination is unavailable: `/pair/all` returns every
   * pair in one unsorted array, so we normalise, rank and slice client-side.
   */
  private async fetchPairsUnpaginated(options: {
    sortKey: SortKey;
    orderBy: "asc" | "desc";
    limit: number;
  }): Promise<PoolMetrics[]> {
    const { sortKey, orderBy, limit } = options;
    const url = `${this.baseUrl}/pair/all`;
    const body = await fetchJson<unknown>(url, { timeoutMs: 30_000 });

    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { pairs?: unknown })?.pairs)
        ? (body as { pairs: unknown[] }).pairs
        : undefined;
    if (!rows) {
      throw new Error(`Unexpected response from ${url}: expected an array of pairs`);
    }

    const pools: PoolMetrics[] = [];
    let skipped = 0;
    for (const row of rows) {
      const parsedPair = parsePair(row);
      if (parsedPair.ok) {
        pools.push(parsedPair.pool);
      } else {
        skipped++;
      }
    }
    if (skipped > 0) logger.debug({ skipped }, "pairs skipped during normalisation");

    const sortValue = (p: PoolMetrics): number => {
      switch (sortKey) {
        case "tvl":
          return p.tvlUsd;
        case "volume":
          return p.volume24hUsd;
        case "lm":
        case "feetvlratio":
        default:
          return p.feeTvlRatio24h;
      }
    };
    const sign = orderBy === "asc" ? 1 : -1;
    pools.sort((a, b) => sign * (sortValue(a) - sortValue(b)));

    return pools.slice(0, limit);
  }

  /** Fetch a single pair by pool address. */
  async fetchPair(address: string): Promise<PoolMetrics> {
    const url = `${this.baseUrl}/pair/${address}`;
    let body: unknown;
    try {
      body = await fetchJson<unknown>(url, { timeoutMs: 20_000 });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        logger.warn({ baseUrl: this.baseUrl }, "/pair/:address returned 404; falling back to /pair/all");
        return this.fetchPairFromAllListing(address);
      }
      throw error;
    }
    const parsed = parsePair(body);
    if (!parsed.ok) throw new Error(`Cannot evaluate pair ${address}: ${parsed.reason}`);
    return parsed.pool;
  }

  private async fetchPairFromAllListing(address: string): Promise<PoolMetrics> {
    const url = `${this.baseUrl}/pair/all`;
    const body = await fetchJson<unknown>(url, { timeoutMs: 30_000 });
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { pairs?: unknown })?.pairs)
        ? (body as { pairs: unknown[] }).pairs
        : undefined;
    if (!rows) throw new Error(`Unexpected response from ${url}: expected an array of pairs`);

    const row = rows.find(
      (r) => typeof r === "object" && r !== null && (r as { address?: unknown }).address === address,
    );
    if (!row) throw new Error(`Cannot evaluate pair ${address}: not found in /pair/all`);

    const parsed = parsePair(row);
    if (!parsed.ok) throw new Error(`Cannot evaluate pair ${address}: ${parsed.reason}`);
    return parsed.pool;
  }
}

export type ParsePairResult =
  | { ok: true; pool: PoolMetrics }
  | { ok: false; reason: string };

/**
 * Validate and normalise one API row.
 *
 * Validation lives inside this function rather than at the call site so no
 * caller can hand it unvalidated JSON and silently end up with strings where it
 * expects numbers.
 */
export function parsePair(row: unknown): ParsePairResult {
  const parsed = rawPairSchema.safeParse(row);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `unparseable pair: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join(", ")}`,
    };
  }

  const pool = normalizePair(parsed.data);
  if (!pool) return { ok: false, reason: "missing the metrics needed to evaluate it (no TVL)" };
  return { ok: true, pool };
}

/**
 * Turn a validated API row into `PoolMetrics`, or return `null` when it lacks
 * the fields the strategy cannot work without.
 */
function normalizePair(raw: RawPair): PoolMetrics | null {
  const tvlUsd = raw.liquidity;
  if (tvlUsd === undefined || tvlUsd <= 0) return null;

  // Prefer the explicit 24h field, fall back to the bucketed series.
  const fees24hUsd = raw.fees_24h ?? raw.fees?.hour_24 ?? 0;
  const volume24hUsd = raw.trade_volume_24h ?? raw.volume?.hour_24 ?? 0;

  return {
    address: raw.address,
    name: raw.name ?? `${raw.mint_x.slice(0, 4)}-${raw.mint_y.slice(0, 4)}`,
    mintX: raw.mint_x,
    mintY: raw.mint_y,
    binStep: raw.bin_step,
    // The API reports this as a percentage number (0.2 == 0.2%).
    baseFee: (raw.base_fee_percentage ?? 0) / 100,
    tvlUsd,
    fees24hUsd,
    volume24hUsd,
    feeTvlRatio24h: fees24hUsd / tvlUsd,
    currentPrice: raw.current_price ?? 0,
    tags: raw.tags ?? [],
    raw,
  };
}
