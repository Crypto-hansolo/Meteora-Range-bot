import type { AccountState, FillResult } from "../hedge/hyperliquid.js";
import type { FetchPairsOptions, PoolMetrics } from "../meteora/api.js";
import type { OpenPositionResult, PositionSnapshot } from "../meteora/dlmm.js";
import type { MarketSnapshot } from "./planner.js";

/**
 * The two venues the engine talks to, as narrow interfaces.
 *
 * Extracting these lets paper trading run the *real* decision loop — the same
 * `tick()`, the same `decideRebalance`, the same exit conditions — against
 * simulated execution. A paper mode that reimplemented the loop would only
 * prove that the reimplementation works.
 */

/** The perp venue. Implemented by `HyperliquidHedger` and `PaperHedger`. */
export interface HedgeVenue {
  readonly canTrade: boolean;
  readonly address: string;
  marketLookup(): Promise<(symbol: string) => MarketSnapshot | undefined>;
  getAccountState(): Promise<AccountState>;
  setLeverage(symbol: string, leverage: number, isolated: boolean): Promise<void>;
  adjustIsolatedMargin(symbol: string, usdDelta: number): Promise<void>;
  trade(params: {
    symbol: string;
    size: number;
    reduceOnly?: boolean;
  }): Promise<FillResult | null>;
  closePosition(symbol: string): Promise<FillResult | null>;
}

/** One DLMM pool. Implemented by `DlmmPool` and `PaperPool`. */
export interface LpVenue {
  readonly mintX: string;
  readonly mintY: string;
  readonly decimalsX: number;
  readonly decimalsY: number;
  refresh(): Promise<void>;
  getActiveBin(): Promise<{ binId: number; priceXInY: number }>;
  openPosition(params: {
    minBinId: number;
    maxBinId: number;
    xUnits: number;
    yUnits: number;
  }): Promise<OpenPositionResult>;
  snapshot(positionPubkey: string): Promise<PositionSnapshot | null>;
  claimFees(positionPubkey: string): Promise<string[]>;
  closePosition(positionPubkey: string): Promise<string[]>;
}

/** Opens the pool handle for an address. Swapped out in paper mode. */
export type LpVenueFactory = (poolAddress: string) => Promise<LpVenue>;

/** Whether the wallet can fund a deposit. Skipped in paper mode. */
export type BalanceChecker = (
  requirements: { mint: string; symbol: string; decimals: number; required: number }[],
) => Promise<{
  ok: boolean;
  shortfalls: { mint: string; symbol: string; required: number; available: number }[];
}>;

/** Pool metrics provider. Implemented by `MeteoraApi`; stubbed in tests. */
export interface PoolSource {
  fetchPairs(options?: FetchPairsOptions): Promise<PoolMetrics[]>;
  fetchPair(address: string): Promise<PoolMetrics>;
}
