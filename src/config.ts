import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  RPC_URL: z.string().url(),
  WS_URL: z.string().url().optional(),
  PAYER_SECRET_KEY: z.string().min(1, "Missing PAYER_SECRET_KEY"),
  TARGET_WALLETS: z.string().min(1, "Missing TARGET_WALLETS"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(8000),
  METEORA_DLMM_PROGRAM_ID: z.string().min(1, "Missing METEORA_DLMM_PROGRAM_ID"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((value) => value?.toLowerCase() === "true"),
  STATE_PATH: z.string().default("./data/state.json"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const config = {
  rpcUrl: parsed.data.RPC_URL,
  wsUrl: parsed.data.WS_URL,
  payerSecretKey: parsed.data.PAYER_SECRET_KEY,
  targetWallets: parsed.data.TARGET_WALLETS.split(",")
    .map((wallet) => wallet.trim())
    .filter(Boolean),
  pollIntervalMs: parsed.data.POLL_INTERVAL_MS,
  meteoraProgramId: parsed.data.METEORA_DLMM_PROGRAM_ID,
  dryRun: parsed.data.DRY_RUN ?? false,
  statePath: parsed.data.STATE_PATH,
};
