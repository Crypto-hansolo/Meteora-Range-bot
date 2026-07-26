import { createRequire } from "node:module";

import type * as DlmmNs from "@meteora-ag/dlmm";

/**
 * Interop shim for `@meteora-ag/dlmm`.
 *
 * Two packaging quirks need handling, and both are the SDK's, not ours:
 *
 * 1. **The ESM build is unusable under Node ESM.** `dist/index.mjs` does a
 *    directory import into `@coral-xyz/anchor/dist/cjs/utils/bytes`, which
 *    Node's ESM resolver rejects with `ERR_UNSUPPORTED_DIR_IMPORT`. So we load
 *    the CJS build explicitly through `createRequire` — CommonJS resolves
 *    directory imports fine — instead of letting the `import` condition pick
 *    the broken file.
 *
 * 2. **One `.d.ts` serves both builds.** The package declares
 *    `export { DLMM as default }` in a file TypeScript treats as CommonJS, so a
 *    plain default import types as the module namespace rather than the class.
 *    The real constructor sits one level deeper, hence the `["default"]` below.
 *
 * At runtime `module.exports` *is* the DLMM class, with every named export
 * attached to it as a property — which is what the cast describes.
 */

const require = createRequire(import.meta.url);

type SdkNamespace = typeof DlmmNs.default;

/** The `DLMM` class constructor. */
export type DlmmCtor = SdkNamespace["default"];
/** An initialised `DLMM` instance. */
export type Dlmm = InstanceType<DlmmCtor>;

const sdk = require("@meteora-ag/dlmm") as DlmmCtor & Omit<SdkNamespace, "default">;

export const DLMM: DlmmCtor = sdk;
export const StrategyType = sdk.StrategyType;
export type StrategyType = DlmmNs.StrategyType;

/**
 * Pure helper functions from the SDK.
 *
 * These need no connection, `Mint` or `Clock`, so the planner and the backtest
 * can both call Meteora's real liquidity math offline.
 */
export const sdkFns = {
  calculateSpotDistribution: sdk.calculateSpotDistribution,
  calculateBidAskDistribution: sdk.calculateBidAskDistribution,
  calculateNormalDistribution: sdk.calculateNormalDistribution,
  autoFillYByStrategy: sdk.autoFillYByStrategy,
  autoFillXByStrategy: sdk.autoFillXByStrategy,
  getPriceOfBinByBinId: sdk.getPriceOfBinByBinId,
} as const;
