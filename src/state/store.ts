import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { logger } from "../logger.js";

const STATE_VERSION = 1;

const hedgeLegStateSchema = z.object({
  symbol: z.string(),
  targetLeverage: z.number(),
  plannedSize: z.number(),
  plannedCollateralUsd: z.number(),
  plannedLiquidationPx: z.number(),
});

const sessionSchema = z.object({
  startedAt: z.number(),
  poolAddress: z.string(),
  poolName: z.string(),
  positionPubkey: z.string(),
  lowerBinId: z.number(),
  upperBinId: z.number(),
  /** Combined LP + hedge equity when the session opened, for drawdown checks. */
  startEquityUsd: z.number(),
  lpCapitalUsd: z.number(),
  hedgeLegs: z.array(hedgeLegStateSchema),
  lastRebalanceAt: z.number().nullish(),
  lastClaimAt: z.number().nullish(),
  outOfRangeSince: z.number().nullish(),
});

const stateSchema = z.object({
  version: z.number(),
  session: sessionSchema.nullish(),
});

export type HedgeLegState = z.infer<typeof hedgeLegStateSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type BotState = z.infer<typeof stateSchema>;

const EMPTY: BotState = { version: STATE_VERSION, session: null };

/**
 * JSON-file state.
 *
 * Writes go to a temp file first and are then renamed, so a crash mid-write
 * cannot leave a truncated file that would strand an open position.
 */
export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BotState> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
      throw error;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `State file ${this.filePath} is not valid JSON (${String(error)}). ` +
          `Inspect it by hand — it may reference an open position.`,
      );
    }

    const parsed = stateSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `State file ${this.filePath} has an unexpected shape: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ")}`,
      );
    }

    if (parsed.data.version !== STATE_VERSION) {
      logger.warn(
        { found: parsed.data.version, expected: STATE_VERSION },
        "state file version mismatch; continuing with the stored data",
      );
    }

    return parsed.data;
  }

  async save(state: BotState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }

  async clearSession(): Promise<void> {
    const state = await this.load();
    state.session = null;
    await this.save(state);
  }
}
