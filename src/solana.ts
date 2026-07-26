import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  type Signer,
  Transaction,
  TransactionExpiredBlockheightExceededError,
} from "@solana/web3.js";
import bs58 from "bs58";

import { config } from "./config.js";
import { logger } from "./logger.js";

export const connection = new Connection(config.solana.rpcUrl, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: config.solana.confirmTimeoutMs,
});

let cachedKeypair: Keypair | null = null;

/**
 * The signing wallet.
 *
 * Accepts a base58 secret key (Phantom-style) or a JSON byte array
 * (`solana-keygen` output).
 */
export function wallet(): Keypair {
  if (cachedKeypair) return cachedKeypair;

  const raw = config.solana.privateKey.trim();
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY is not set");

  let bytes: Uint8Array;
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as number[];
    bytes = Uint8Array.from(parsed);
  } else {
    bytes = bs58.decode(raw);
  }

  if (bytes.length !== 64) {
    throw new Error(`SOLANA_PRIVATE_KEY must decode to 64 bytes, got ${bytes.length}`);
  }

  cachedKeypair = Keypair.fromSecretKey(bytes);
  return cachedKeypair;
}

/**
 * Sign, send and confirm one transaction.
 *
 * A compute-unit price instruction is prepended unless the transaction already
 * carries one, so positions still land when the network is busy.
 */
export async function sendTransaction(
  tx: Transaction,
  signers: Signer[],
  label: string,
): Promise<string> {
  const payer = wallet();

  if (config.dryRun) {
    logger.info({ label, instructions: tx.instructions.length, dryRun: true }, "would send tx");
    return `dry-run:${label}`;
  }

  const hasComputePrice = tx.instructions.some(
    (ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId) &&
      // Discriminator 3 = SetComputeUnitPrice.
      ix.data[0] === 3,
  );
  if (!hasComputePrice && config.solana.priorityFeeMicroLamports > 0) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: config.solana.priorityFeeMicroLamports,
      }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;

  const allSigners = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
  tx.sign(...allSigners);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  logger.debug({ label, signature }, "transaction sent, confirming");

  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(
        `Transaction ${label} failed on chain: ${JSON.stringify(confirmation.value.err)}`,
      );
    }
  } catch (error) {
    if (error instanceof TransactionExpiredBlockheightExceededError) {
      throw new Error(
        `Transaction ${label} (${signature}) expired before confirmation. ` +
          `Check the signature on chain before retrying — it may still have landed.`,
      );
    }
    throw error;
  }

  logger.info({ label, signature }, "transaction confirmed");
  return signature;
}

/** Send a batch of transactions in order, stopping at the first failure. */
export async function sendTransactions(
  txs: Transaction[],
  signers: Signer[],
  label: string,
): Promise<string[]> {
  const signatures: string[] = [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    signatures.push(await sendTransaction(tx, signers, `${label}[${i + 1}/${txs.length}]`));
  }
  return signatures;
}
