import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Mint -> asset registry.
 *
 * ## Why this is an allowlist keyed by mint address
 *
 * The Meteora API's `name` field ("SOL-USDC") is attacker-controlled: anyone can
 * launch a token whose symbol reads `SOL` and seed a DLMM pool with it. If the
 * bot trusted that string it would happily deposit into the fake pool and open a
 * *real* SOL short against it — an unhedged directional bet with extra steps.
 *
 * So eligibility is decided by mint address only. Pool names are display-only.
 * Anything not listed here is skipped; extend the list with `TOKEN_MAP_JSON`
 * after verifying the mint yourself.
 */

export type TokenKind =
  /** Dollar-pegged: delta 0, needs no hedge. */
  | "stable"
  /** Has a Hyperliquid perp we can short 1:1. */
  | "hedgeable"
  /** Known token, but not safely hedgeable — pools using it are skipped. */
  | "unhedgeable";

export interface TokenInfo {
  mint: string;
  symbol: string;
  kind: TokenKind;
  /** Hyperliquid perp coin. Set when `kind === "hedgeable"`. */
  hlSymbol?: string;
  /** Why an asset is unhedgeable, surfaced in scan output. */
  note?: string;
}

type Entry = Omit<TokenInfo, "mint">;

const REGISTRY: Record<string, Entry> = {
  // ------------------------------------------------------------- stablecoins
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", kind: "stable" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", kind: "stable" },
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: { symbol: "USDS", kind: "stable" },
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": { symbol: "PYUSD", kind: "stable" },

  // ------------------------------------------------------- hedgeable majors
  So11111111111111111111111111111111111111112: {
    symbol: "SOL",
    kind: "hedgeable",
    hlSymbol: "SOL",
  },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": {
    symbol: "wETH",
    kind: "hedgeable",
    hlSymbol: "ETH",
  },
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": {
    symbol: "wBTC",
    kind: "hedgeable",
    hlSymbol: "BTC",
  },
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: {
    symbol: "cbBTC",
    kind: "hedgeable",
    hlSymbol: "BTC",
  },

  // ---------------------------------------------------- hedgeable Solana alts
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: {
    symbol: "JUP",
    kind: "hedgeable",
    hlSymbol: "JUP",
  },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: {
    symbol: "JTO",
    kind: "hedgeable",
    hlSymbol: "JTO",
  },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: {
    symbol: "WIF",
    kind: "hedgeable",
    hlSymbol: "WIF",
  },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: {
    symbol: "BONK",
    kind: "hedgeable",
    hlSymbol: "kBONK",
    note: "Hyperliquid quotes kBONK (1 contract = 1000 BONK); size conversion is automatic",
  },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: {
    symbol: "PYTH",
    kind: "hedgeable",
    hlSymbol: "PYTH",
  },
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": {
    symbol: "RAY",
    kind: "hedgeable",
    hlSymbol: "RAY",
  },
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": {
    symbol: "W",
    kind: "hedgeable",
    hlSymbol: "W",
  },
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": {
    symbol: "TRUMP",
    kind: "hedgeable",
    hlSymbol: "TRUMP",
  },
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump": {
    symbol: "FARTCOIN",
    kind: "hedgeable",
    hlSymbol: "FARTCOIN",
  },
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": {
    symbol: "POPCAT",
    kind: "hedgeable",
    hlSymbol: "POPCAT",
  },

  // --------------------------------------------------------- known, excluded
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: {
    symbol: "mSOL",
    kind: "unhedgeable",
    note: "liquid staking token: 1 mSOL > 1 SOL and the ratio drifts, so a 1:1 SOL short mis-hedges",
  },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: {
    symbol: "JitoSOL",
    kind: "unhedgeable",
    note: "liquid staking token: 1 JitoSOL > 1 SOL and the ratio drifts, so a 1:1 SOL short mis-hedges",
  },
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": {
    symbol: "JLP",
    kind: "unhedgeable",
    note: "index token tracking a basket; no single perp reproduces its exposure",
  },
};

/**
 * Overrides from `TOKEN_MAP_JSON`.
 *
 * Accepts `{"<mint>": "SYMBOL"}` for a hedgeable asset whose Hyperliquid coin
 * matches the symbol, or the full object form for anything else:
 * `{"<mint>": {"symbol": "FOO", "kind": "hedgeable", "hlSymbol": "FOO"}}`.
 */
function loadOverrides(): Record<string, Entry> {
  if (!config.tokenMapJson.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(config.tokenMapJson);
  } catch (error) {
    throw new Error(`TOKEN_MAP_JSON is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TOKEN_MAP_JSON must be a JSON object keyed by mint address");
  }

  const out: Record<string, Entry> = {};
  for (const [mint, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[mint] = { symbol: value, kind: "hedgeable", hlSymbol: value };
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const v = value as Record<string, unknown>;
      const symbol = typeof v.symbol === "string" ? v.symbol : undefined;
      const kind = v.kind;
      if (!symbol) throw new Error(`TOKEN_MAP_JSON entry for ${mint} is missing "symbol"`);
      if (kind !== "stable" && kind !== "hedgeable" && kind !== "unhedgeable") {
        throw new Error(
          `TOKEN_MAP_JSON entry for ${mint} has invalid "kind" (expected stable|hedgeable|unhedgeable)`,
        );
      }
      const entry: Entry = { symbol, kind };
      if (kind === "hedgeable") {
        entry.hlSymbol = typeof v.hlSymbol === "string" ? v.hlSymbol : symbol;
      }
      if (typeof v.note === "string") entry.note = v.note;
      out[mint] = entry;
      continue;
    }
    throw new Error(`TOKEN_MAP_JSON entry for ${mint} must be a string or an object`);
  }

  logger.info({ mints: Object.keys(out) }, "loaded token overrides from TOKEN_MAP_JSON");
  return out;
}

let overrides: Record<string, Entry> | null = null;

function registry(): Record<string, Entry> {
  overrides ??= loadOverrides();
  return { ...REGISTRY, ...overrides };
}

/** Look up a mint. Returns `undefined` for anything not on the allowlist. */
export function resolveToken(mint: string): TokenInfo | undefined {
  const entry = registry()[mint];
  return entry ? { mint, ...entry } : undefined;
}

/**
 * Hyperliquid quotes some memecoins in thousands (`kBONK`, `kPEPE`).
 * One contract then represents 1000 tokens, so sizes must be scaled.
 */
export function hlSizeMultiplier(hlSymbol: string): number {
  return /^k[A-Z]/.test(hlSymbol) ? 1000 : 1;
}

// ---------------------------------------------------------------------------
// Pool classification
// ---------------------------------------------------------------------------

export interface PoolTokens {
  x: TokenInfo;
  y: TokenInfo;
}

export type PoolEligibility =
  | { eligible: true; tokens: PoolTokens; hedgedSymbols: string[] }
  | { eligible: false; reason: string };

/**
 * Decide whether a pool can be run delta-neutral.
 *
 * Both mints must be on the allowlist, at least one side must carry delta
 * (a stable/stable pool has nothing to hedge and no meaningful fee capture for
 * this strategy), and every non-stable side must be hedgeable.
 */
export function classifyPool(mintX: string, mintY: string): PoolEligibility {
  const x = resolveToken(mintX);
  const y = resolveToken(mintY);

  if (!x) return { eligible: false, reason: `unknown mint ${mintX} (not on the allowlist)` };
  if (!y) return { eligible: false, reason: `unknown mint ${mintY} (not on the allowlist)` };

  for (const token of [x, y]) {
    if (token.kind === "unhedgeable") {
      return {
        eligible: false,
        reason: `${token.symbol} is not hedgeable: ${token.note ?? "no perp mapping"}`,
      };
    }
  }

  const hedged = [x, y].filter((t) => t.kind === "hedgeable");
  if (hedged.length === 0) {
    return { eligible: false, reason: "both sides are stablecoins; nothing to hedge" };
  }

  return {
    eligible: true,
    tokens: { x, y },
    hedgedSymbols: [...new Set(hedged.map((t) => t.hlSymbol!))],
  };
}

/** All allowlisted mints, for diagnostics. */
export function knownMints(): string[] {
  return Object.keys(registry());
}
