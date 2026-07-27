import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

/**
 * Meteora has moved `/pair/all_with_pagination` around before, and it 404s in
 * production as of this writing. `MeteoraApi` falls back to the plain
 * `/pair/all` listing when that happens, ranking and slicing client-side
 * instead of relying on the server's pagination and sort.
 *
 * These tests fake `fetch` itself rather than hitting the network, so they
 * pin the fallback's request shape and behaviour without depending on which
 * endpoint Meteora happens to be serving today.
 */

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let MeteoraApi: typeof import("../src/meteora/api.js").MeteoraApi;

function rawPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
    name: "SOL-USDC",
    mint_x: SOL,
    mint_y: USDC,
    bin_step: 20,
    base_fee_percentage: "0.2",
    liquidity: "300000",
    fees_24h: "3000",
    trade_volume_24h: "500000",
    current_price: "150",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

before(async () => {
  process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  process.env.LOG_LEVEL = "silent";
  ({ MeteoraApi } = await import("../src/meteora/api.js"));
});

describe("MeteoraApi falls back from /pair/all_with_pagination to /pair/all", () => {
  const originalFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchPairs: ranks and slices the unpaginated listing after a 404", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes("/pair/all_with_pagination")) return jsonResponse(404, "not found");
      if (url.endsWith("/pair/all")) {
        return jsonResponse(200, [
          rawPair({ address: "low", liquidity: "300000", fees_24h: "300" }), // ratio 0.001
          rawPair({ address: "high", liquidity: "300000", fees_24h: "9000" }), // ratio 0.03
          rawPair({ address: "mid", liquidity: "300000", fees_24h: "3000" }), // ratio 0.01
        ]);
      }
      throw new Error(`unexpected URL in test: ${url}`);
    }) as typeof fetch;

    const api = new MeteoraApi("https://dlmm-api.meteora.ag");
    const pools = await api.fetchPairs({ limit: 2 });

    assert.equal(calls[0].includes("all_with_pagination"), true, "tries pagination first");
    assert.ok(calls.some((u) => u.endsWith("/pair/all")), "falls back to /pair/all");
    assert.deepEqual(
      pools.map((p) => p.address),
      ["high", "mid"],
      "ranks by fee/TVL ratio desc and respects the limit",
    );
  });

  it("fetchPair: finds the address inside /pair/all after both single-pair and pagination 404", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/pair/all_with_pagination")) return jsonResponse(404, "not found");
      if (url.endsWith("/pair/all")) {
        return jsonResponse(200, [rawPair({ address: "target-pool" })]);
      }
      // /pair/:address
      return jsonResponse(404, "not found");
    }) as typeof fetch;

    const api = new MeteoraApi("https://dlmm-api.meteora.ag");
    const pool = await api.fetchPair("target-pool");
    assert.equal(pool.address, "target-pool");
  });

  it("fetchPair: throws a clear error when the address isn't in /pair/all either", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/pair/all")) return jsonResponse(200, [rawPair({ address: "someone-else" })]);
      return jsonResponse(404, "not found");
    }) as typeof fetch;

    const api = new MeteoraApi("https://dlmm-api.meteora.ag");
    await assert.rejects(() => api.fetchPair("missing-pool"), /missing-pool/);
  });

  it("does not fall back on non-404 errors", async () => {
    // 400 rather than a retryable status (500 etc.), so this stays fast: a
    // retryable status would make fetchJson's backoff burn several seconds.
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/pair/all_with_pagination")) return jsonResponse(400, "bad request");
      throw new Error(`unexpected URL in test: ${url}`);
    }) as typeof fetch;

    const api = new MeteoraApi("https://dlmm-api.meteora.ag");
    await assert.rejects(() => api.fetchPairs({ limit: 2 }), /400/);
  });
});
