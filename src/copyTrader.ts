import {
  ParsedTransactionWithMeta,
  PublicKey,
  TransactionSignature,
} from "@solana/web3.js";
import { connection } from "./solana.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { StateStore, WalletState } from "./state/store.js";
import { defaultAdapter } from "./meteora/adapter.js";

export class CopyTrader {
  private readonly stateStore = new StateStore(config.statePath);
  private state: WalletState = {};

  async start(): Promise<void> {
    this.state = await this.stateStore.load();
    logger.info(
      {
        targets: config.targetWallets,
        pollIntervalMs: config.pollIntervalMs,
      },
      "Starting Meteora DLMM copy trader",
    );

    await this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (true) {
      try {
        await Promise.all(
          config.targetWallets.map((wallet) => this.syncWallet(wallet)),
        );
        await this.stateStore.save(this.state);
      } catch (error) {
        logger.error({ error }, "Poll loop error");
      }

      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }

  private async syncWallet(walletAddress: string): Promise<void> {
    const walletKey = new PublicKey(walletAddress);
    const lastSignature = this.state[walletAddress] ?? undefined;
    const signatures = await connection.getSignaturesForAddress(walletKey, {
      limit: 25,
      before: lastSignature,
    });

    const ordered = signatures.reverse();

    for (const signatureInfo of ordered) {
      const signature = signatureInfo.signature;
      const transaction = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction) {
        continue;
      }

      await this.handleTransaction(walletKey, signature, transaction);
      this.state[walletAddress] = signature;
    }
  }

  private async handleTransaction(
    walletKey: PublicKey,
    signature: TransactionSignature,
    transaction: ParsedTransactionWithMeta,
  ): Promise<void> {
    if (!transaction.meta) {
      return;
    }

    const involvedPrograms = transaction.transaction.message.instructions
      .filter((instruction) => "programId" in instruction)
      .map((instruction) => instruction.programId.toBase58());

    if (!involvedPrograms.includes(config.meteoraProgramId)) {
      return;
    }

    logger.info(
      { signature, wallet: walletKey.toBase58() },
      "Detected Meteora DLMM activity",
    );

    try {
      const actions = await defaultAdapter.decodeActions(transaction, walletKey);
      for (const action of actions) {
        await defaultAdapter.executeAction(action);
      }
    } catch (error) {
      logger.error({ error, signature }, "Failed to mirror transaction");
    }
  }
}
