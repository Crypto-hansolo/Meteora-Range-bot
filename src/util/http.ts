import { logger } from "../logger.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  /** Base delay for exponential backoff. */
  retryDelayMs?: number;
  headers?: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET JSON with a timeout and exponential-backoff retries.
 *
 * Only network errors and transient status codes are retried; a 400 or 404 is
 * returned as an error immediately so misconfiguration surfaces fast.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { timeoutMs = 15_000, retries = 3, retryDelayMs = 500, headers } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = retryDelayMs * 2 ** (attempt - 1);
      logger.debug({ url, attempt, delay }, "retrying request");
      await sleep(delay);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json", ...headers },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const error = new HttpError(
          `GET ${url} failed with ${res.status} ${res.statusText}`,
          res.status,
          body.slice(0, 500),
        );
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return (await res.json()) as T;
    } catch (error) {
      lastError = error;
      const isAbort = error instanceof Error && error.name === "AbortError";
      const isHttp = error instanceof HttpError;
      // Non-retryable HTTP errors were already thrown above; anything else here
      // is a transport failure worth retrying.
      if (isHttp && !RETRYABLE_STATUS.has(error.status)) throw error;
      if (attempt >= retries) break;
      logger.debug({ url, err: isAbort ? "timeout" : String(error) }, "request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`GET ${url} failed: ${String(lastError)}`);
}
