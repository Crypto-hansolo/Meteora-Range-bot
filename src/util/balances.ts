import { PublicKey } from "@solana/web3.js";

import { connection, wallet } from "../solana.js";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
/** Leave enough SOL for rent and fees rather than depositing the whole balance. */
const SOL_RESERVE = 0.05;

/**
 * Spendable balance of `mint` in human units.
 *
 * Native SOL and wrapped SOL are pooled, because the DLMM SDK wraps SOL as
 * needed. A reserve is withheld from the native portion for rent and fees.
 */
export async function spendableBalance(mint: string, decimals: number): Promise<number> {
  const owner = wallet().publicKey;

  let total = 0;
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mint),
  });
  for (const { account } of accounts.value) {
    const info = account.data.parsed?.info as
      | { tokenAmount?: { uiAmount?: number | null } }
      | undefined;
    total += info?.tokenAmount?.uiAmount ?? 0;
  }

  if (mint === WRAPPED_SOL) {
    const lamports = await connection.getBalance(owner);
    total += Math.max(0, lamports / 10 ** decimals - SOL_RESERVE);
  }

  return total;
}

export interface BalanceCheck {
  ok: boolean
  shortfalls: { mint: string; symbol: string; required: number; available: number }[];
}

/**
 * Verify the wallet can fund a deposit before anything irreversible happens.
 *
 * The bot does not swap: it deposits what you already hold. Checking up front
 * turns "half-opened position, hedge already live" into a clean refusal.
 */
export async function checkBalances(
  requirements: { mint: string; symbol: string; decimals: number; required: number }[],
): Promise<BalanceCheck> {
  const shortfalls: BalanceCheck["shortfalls"] = [];

  for (const req of requirements) {
    if (req.required <= 0) continue;
    const available = await spendableBalance(req.mint, req.decimals);
    if (available < req.required) {
      shortfalls.push({
        mint: req.mint,
        symbol: req.symbol,
        required: req.required,
        available,
      });
    }
  }

  return { ok: shortfalls.length === 0, shortfalls };
}
