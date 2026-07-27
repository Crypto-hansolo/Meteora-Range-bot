import "dotenv/config";
import { z } from "zod";

/** `"true" | "1" | "yes"` -> true. Anything else (incl. unset) -> the given default. */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return def;
      return ["true", "1", "yes", "y"].includes(v.trim().toLowerCase());
    });

const csv = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

const envSchema = z.object({
  // ---------------------------------------------------------------- Solana
  RPC_URL: z.string().url(),
  SOLANA_PRIVATE_KEY: z.string().default(""),
  PRIORITY_FEE_MICRO_LAMPORTS: z.coerce.number().int().min(0).default(50_000),
  TX_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  // --------------------------------------------------------------- Meteora
  METEORA_API_URL: z.string().url().default("https://dlmm-api.meteora.ag"),

  // ----------------------------------------------------------- Hyperliquid
  HL_PRIVATE_KEY: z.string().default(""),
  /**
   * Master account address. Required only when HL_PRIVATE_KEY belongs to an
   * API/agent wallet, because reads must target the master account.
   */
  HL_ACCOUNT_ADDRESS: z.string().default(""),
  HL_TESTNET: boolish(false),

  // --------------------------------------------------------------- Capital
  /** USD notional deposited into the LP position. */
  LP_CAPITAL_USD: z.coerce.number().positive().default(1_000),
  /**
   * USD collateral moved into the isolated hedge. Leave empty to let the bot
   * derive it from the required leverage (recommended).
   */
  HEDGE_COLLATERAL_USD: z.coerce.number().positive().optional(),

  // -------------------------------------------------- Pool selection filter
  /** Skip scanning and use this pool address directly. */
  POOL_ADDRESS: z.string().default(""),
  MIN_TVL_USD: z.coerce.number().min(0).default(250_000),
  MAX_TVL_USD: z.coerce.number().min(0).default(500_000_000),
  MIN_VOLUME_24H_USD: z.coerce.number().min(0).default(200_000),
  /** Daily fees divided by TVL. 0.01 = pool pays out 1% of TVL per day. */
  MIN_FEE_TVL_RATIO_24H: z.coerce.number().min(0).default(0.01),
  MIN_BIN_STEP: z.coerce.number().int().min(1).default(1),
  MAX_BIN_STEP: z.coerce.number().int().min(1).default(200),
  /** Minimum Hyperliquid open interest (USD) for the hedged asset. */
  MIN_HL_OPEN_INTEREST_USD: z.coerce.number().min(0).default(2_000_000),
  POOL_BLACKLIST: csv(),
  /** If non-empty, only pools whose base asset symbol is listed are eligible. */
  TOKEN_WHITELIST: csv(),
  /** Quote assets we accept on the pool's Y side. */
  QUOTE_WHITELIST: csv(),
  /**
   * Only accept pools quoted in a stablecoin, so exactly one short is needed.
   *
   * A crypto/crypto pool such as JUP/SOL carries delta on both sides and needs
   * two perp positions, which means two margin buckets, two liquidation prices
   * and correlation between them. Requiring a stable quote keeps the hedge to a
   * single leg, which is what most operators want.
   */
  REQUIRE_STABLE_QUOTE: boolish(true),
  SCAN_LIMIT: z.coerce.number().int().positive().default(10),

  // ----------------------------------------------------------- LP range/fill
  /** Half-width of the LP range in percent around spot. 5 => roughly ±5%. */
  RANGE_WIDTH_PCT: z.coerce.number().positive().default(5),
  /** Hard cap on bins per position; 70 fits a single non-extended position. */
  MAX_BINS: z.coerce.number().int().min(1).max(1400).default(70),
  LP_STRATEGY: z.enum(["Spot", "Curve", "BidAsk"]).default("Spot"),
  LP_SLIPPAGE_PCT: z.coerce.number().min(0).default(1),

  // ------------------------------------------------------------------ Hedge
  /** Force a leverage instead of deriving it from the liquidation buffer. */
  HEDGE_TARGET_LEVERAGE: z.coerce.number().positive().optional(),
  /**
   * Liquidation price must sit this many times the upside range distance above
   * spot. 3 => for a +5% range top, liquidation must be at least +15%.
   */
  HEDGE_LIQ_BUFFER_MULT: z.coerce.number().positive().default(3),
  /** Absolute floor for the liquidation buffer, as a fraction of spot. */
  HEDGE_MIN_LIQ_BUFFER_PCT: z.coerce.number().positive().default(25),
  HEDGE_MAX_LEVERAGE: z.coerce.number().positive().default(10),
  /** Re-hedge once |delta drift| exceeds this share of the target notional. */
  HEDGE_REBALANCE_THRESHOLD_PCT: z.coerce.number().positive().default(5),
  /** Never send a re-hedge smaller than this notional. */
  HEDGE_MIN_REBALANCE_USD: z.coerce.number().min(0).default(25),
  /** Top up isolated margin when effective leverage exceeds this. */
  HEDGE_MARGIN_TOPUP_LEVERAGE: z.coerce.number().positive().optional(),
  /** Aggression of the IOC limit price used to emulate a market order. */
  HEDGE_SLIPPAGE_BPS: z.coerce.number().min(0).default(30),
  HEDGE_USE_ISOLATED_MARGIN: boolish(true),

  // ------------------------------------------------------------- Loop / risk
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  REBALANCE_COOLDOWN_MS: z.coerce.number().int().min(0).default(60_000),
  /** Exit everything after the price stayed outside the range this long. */
  EXIT_ON_OUT_OF_RANGE_MS: z.coerce.number().int().min(0).default(30 * 60_000),
  /** Exit everything if combined equity drops this far below the start value. */
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().default(15),
  CLAIM_FEES_INTERVAL_MS: z.coerce.number().int().min(0).default(60 * 60_000),

  // ---------------------------------------------------------------- Runtime
  DRY_RUN: boolish(true),
  STATE_PATH: z.string().default("./data/state.json"),
  /** Extra mint -> symbol overrides as JSON, e.g. {"So111...":"SOL"}. */
  TOKEN_MAP_JSON: z.string().default(""),
});

const DEFAULT_QUOTES = ["USDC", "USDT", "SOL"];

function buildConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  const e = parsed.data;

  return {
    solana: {
      rpcUrl: e.RPC_URL,
      privateKey: e.SOLANA_PRIVATE_KEY,
      priorityFeeMicroLamports: e.PRIORITY_FEE_MICRO_LAMPORTS,
      confirmTimeoutMs: e.TX_CONFIRM_TIMEOUT_MS,
    },
    meteora: {
      apiUrl: e.METEORA_API_URL.replace(/\/+$/, ""),
    },
    hyperliquid: {
      privateKey: e.HL_PRIVATE_KEY,
      accountAddress: e.HL_ACCOUNT_ADDRESS,
      testnet: e.HL_TESTNET,
    },
    capital: {
      lpUsd: e.LP_CAPITAL_USD,
      hedgeCollateralUsd: e.HEDGE_COLLATERAL_USD,
    },
    selection: {
      poolAddress: e.POOL_ADDRESS,
      minTvlUsd: e.MIN_TVL_USD,
      maxTvlUsd: e.MAX_TVL_USD,
      minVolume24hUsd: e.MIN_VOLUME_24H_USD,
      minFeeTvlRatio24h: e.MIN_FEE_TVL_RATIO_24H,
      minBinStep: e.MIN_BIN_STEP,
      maxBinStep: e.MAX_BIN_STEP,
      minHlOpenInterestUsd: e.MIN_HL_OPEN_INTEREST_USD,
      poolBlacklist: new Set(e.POOL_BLACKLIST),
      tokenWhitelist: e.TOKEN_WHITELIST.map((s) => s.toUpperCase()),
      quoteWhitelist: (e.QUOTE_WHITELIST.length ? e.QUOTE_WHITELIST : DEFAULT_QUOTES).map((s) =>
        s.toUpperCase(),
      ),
      requireStableQuote: e.REQUIRE_STABLE_QUOTE,
      scanLimit: e.SCAN_LIMIT,
    },
    lp: {
      rangeWidthPct: e.RANGE_WIDTH_PCT,
      maxBins: e.MAX_BINS,
      strategy: e.LP_STRATEGY,
      slippagePct: e.LP_SLIPPAGE_PCT,
    },
    hedge: {
      targetLeverage: e.HEDGE_TARGET_LEVERAGE,
      liqBufferMult: e.HEDGE_LIQ_BUFFER_MULT,
      minLiqBufferPct: e.HEDGE_MIN_LIQ_BUFFER_PCT,
      maxLeverage: e.HEDGE_MAX_LEVERAGE,
      rebalanceThresholdPct: e.HEDGE_REBALANCE_THRESHOLD_PCT,
      minRebalanceUsd: e.HEDGE_MIN_REBALANCE_USD,
      marginTopupLeverage: e.HEDGE_MARGIN_TOPUP_LEVERAGE,
      slippageBps: e.HEDGE_SLIPPAGE_BPS,
      isolated: e.HEDGE_USE_ISOLATED_MARGIN,
    },
    loop: {
      pollIntervalMs: e.POLL_INTERVAL_MS,
      rebalanceCooldownMs: e.REBALANCE_COOLDOWN_MS,
      exitOnOutOfRangeMs: e.EXIT_ON_OUT_OF_RANGE_MS,
      maxDrawdownPct: e.MAX_DRAWDOWN_PCT,
      claimFeesIntervalMs: e.CLAIM_FEES_INTERVAL_MS,
    },
    dryRun: e.DRY_RUN,
    statePath: e.STATE_PATH,
    tokenMapJson: e.TOKEN_MAP_JSON,
  };
}

export type Config = ReturnType<typeof buildConfig>;

export const config: Config = buildConfig();

/**
 * Re-read the environment into the existing `config` object.
 *
 * A test seam: config is parsed once at import time, so a test that wants to
 * exercise a different setting has no other way to change it without spawning a
 * subprocess. Mutating in place keeps every module's reference valid.
 */
export function rebuildForTest(): void {
  Object.assign(config, buildConfig());
}

/** Commands that place real orders need signing keys; `scan` does not. */
export function assertTradingCredentials(): void {
  const missing: string[] = [];
  if (!config.solana.privateKey) missing.push("SOLANA_PRIVATE_KEY");
  if (!config.hyperliquid.privateKey) missing.push("HL_PRIVATE_KEY");
  if (missing.length) {
    throw new Error(
      `Missing credentials for live trading: ${missing.join(", ")}. ` +
        `Set them in .env, or use the read-only commands (scan).`,
    );
  }
}
