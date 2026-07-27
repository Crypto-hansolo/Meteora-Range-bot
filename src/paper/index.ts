import { config } from "../config.js";
import { logger } from "../logger.js";
import { MeteoraApi } from "../meteora/api.js";
import { Engine } from "../strategy/engine.js";
import { PaperHedger, PaperPool } from "./venues.js";

/**
 * Build an `Engine` that runs the production decision loop against simulated
 * execution and live market data.
 *
 * Nothing about the strategy changes: the same `tick()` reads the same live
 * prices, calls the same `decideRebalance`, and honours the same exit
 * conditions. Only the fills and the LP position are simulated, and the state
 * file is separate so a paper run can never be mistaken for a live one.
 */
export async function createPaperEngine(options: {
  poolAddress?: string;
  /** Collateral to give the paper Hyperliquid account. */
  hedgeCollateralUsd?: number;
  takerFee?: number;
}): Promise<{ engine: Engine; hedger: PaperHedger }> {
  const poolAddress = options.poolAddress ?? config.selection.poolAddress;

  // The pool's real fee rate drives the simulated position's fee accrual. When
  // no address is given the pool is only chosen later by the scan, so leave it
  // undefined and let PaperPool read it from chain once it knows the pool.
  let feeRate: number | undefined;
  if (poolAddress) {
    try {
      const pool = await new MeteoraApi().fetchPair(poolAddress);
      feeRate = pool.baseFee;
    } catch (error) {
      logger.warn(
        { err: String(error) },
        "could not read the pool's fee rate from the API; will read it on-chain",
      );
    }
  }

  // Default the paper account to what the hedge could plausibly need: roughly
  // half the LP capital as notional, at a conservative leverage, with headroom.
  const collateral = options.hedgeCollateralUsd ?? config.capital.lpUsd;
  const hedger = new PaperHedger(collateral, options.takerFee);

  const engine = new Engine({
    hedger,
    openPool: (address) => PaperPool.load(address, feeRate),
    // No wallet is involved, so there is nothing to fund.
    checkBalances: async () => ({ ok: true, shortfalls: [] }),
    mode: "paper",
    statePath: paperStatePath(),
  });

  return { engine, hedger };
}

/** Paper sessions live beside the real state file, never inside it. */
export function paperStatePath(): string {
  return config.statePath.replace(/\.json$/, "") + ".paper.json";
}

export { PaperHedger, PaperPool } from "./venues.js";
