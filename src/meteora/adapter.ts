import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export type CopyAction =
  | {
      type: "openPosition";
      pool: PublicKey;
      lowerBinId: number;
      upperBinId: number;
      baseAmount: bigint;
      quoteAmount: bigint;
    }
  | {
      type: "increaseLiquidity";
      position: PublicKey;
      baseAmount: bigint;
      quoteAmount: bigint;
    }
  | { type: "decreaseLiquidity"; position: PublicKey; bps: number }
  | { type: "closePosition"; position: PublicKey };

export interface MeteoraAdapter {
  decodeActions(
    transaction: ParsedTransactionWithMeta,
    signer: PublicKey,
  ): Promise<CopyAction[]>;
  executeAction(action: CopyAction): Promise<string | null>;
}

export class SdkMeteoraAdapter implements MeteoraAdapter {
  private sdkPromise: Promise<any> | null = null;

  private async loadSdk() {
    if (!this.sdkPromise) {
      this.sdkPromise = import("@meteora-ag/dlmm").catch((error) => {
        logger.error({ error }, "Failed to load Meteora DLMM SDK");
        throw error;
      });
    }

    return this.sdkPromise;
  }

  async decodeActions(
    transaction: ParsedTransactionWithMeta,
    signer: PublicKey,
  ): Promise<CopyAction[]> {
    const sdk = await this.loadSdk();
    if (!sdk?.instructionParser) {
      throw new Error(
        "Meteora SDK missing instructionParser. Update adapter implementation.",
      );
    }

    const actions: CopyAction[] = [];
    const parsed = sdk.instructionParser.parseTransaction(transaction, signer);

    for (const action of parsed ?? []) {
      if (action.type === "openPosition") {
        actions.push({
          type: "openPosition",
          pool: new PublicKey(action.pool),
          lowerBinId: action.lowerBinId,
          upperBinId: action.upperBinId,
          baseAmount: BigInt(action.baseAmount),
          quoteAmount: BigInt(action.quoteAmount),
        });
      } else if (action.type === "increaseLiquidity") {
        actions.push({
          type: "increaseLiquidity",
          position: new PublicKey(action.position),
          baseAmount: BigInt(action.baseAmount),
          quoteAmount: BigInt(action.quoteAmount),
        });
      } else if (action.type === "decreaseLiquidity") {
        actions.push({
          type: "decreaseLiquidity",
          position: new PublicKey(action.position),
          bps: action.bps,
        });
      } else if (action.type === "closePosition") {
        actions.push({
          type: "closePosition",
          position: new PublicKey(action.position),
        });
      }
    }

    return actions;
  }

  async executeAction(action: CopyAction): Promise<string | null> {
    if (config.dryRun) {
      logger.info({ action }, "Dry-run enabled; skipping execution");
      return null;
    }

    const sdk = await this.loadSdk();
    if (!sdk?.copyTrading) {
      throw new Error("Meteora SDK missing copyTrading module.");
    }

    return sdk.copyTrading.execute(action);
  }
}

export const defaultAdapter = new SdkMeteoraAdapter();
