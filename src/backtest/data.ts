import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Historical market data from Hyperliquid's public info endpoints.
 *
 * Both the price path and the funding rates are real: `candleSnapshot` gives
 * OHLCV and `fundingHistory` gives the hourly rates that were actually paid.
 * Nothing here is synthetic, which matters — the whole point of the backtest is
 * to measure what real volatility did to the hedge.
 */

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  /** Open time, ms. */
  t: number;
  /** Close time, ms. */
  T: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundingPoint {
  time: number;
  /** Hourly rate. Positive means longs pay shorts. */
  rate: number;
}

export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Hyperliquid caps a single candle request; page below this. */
const MAX_CANDLES_PER_REQUEST = 5000;

export class MarketDataSource {
  private readonly info: InfoClient;

  constructor() {
    this.info = new InfoClient({
      transport: new HttpTransport({ isTestnet: config.hyperliquid.testnet }),
    });
  }

  /**
   * Fetch candles across an arbitrary window, paging as needed.
   *
   * Pages advance by the last candle's close time. If a page returns nothing new
   * the loop stops rather than spinning — Hyperliquid does not serve unlimited
   * history and the available window varies by asset.
   */
  async fetchCandles(params: {
    coin: string;
    interval: CandleInterval;
    startTime: number;
    endTime: number;
  }): Promise<Candle[]> {
    const { coin, interval, startTime, endTime } = params;
    const step = INTERVAL_MS[interval];
    const out: Candle[] = [];

    let cursor = startTime;
    let guard = 0;

    while (cursor < endTime && guard++ < 200) {
      const pageEnd = Math.min(cursor + step * MAX_CANDLES_PER_REQUEST, endTime);

      const raw = await this.info.candleSnapshot({
        coin,
        interval,
        startTime: cursor,
        endTime: pageEnd,
      });

      if (!raw.length) break;

      for (const c of raw) {
        // Pages can overlap at the boundary.
        if (out.length && c.t <= out[out.length - 1]!.t) continue;
        out.push({
          t: c.t,
          T: c.T,
          open: Number(c.o),
          high: Number(c.h),
          low: Number(c.l),
          close: Number(c.c),
          volume: Number(c.v),
        });
      }

      const lastClose = raw[raw.length - 1]!.T;
      if (lastClose <= cursor) break;
      cursor = lastClose;
    }

    logger.info(
      { coin, interval, candles: out.length, from: iso(out[0]?.t), to: iso(out.at(-1)?.T) },
      "loaded candles",
    );

    if (!out.length) {
      throw new Error(
        `Hyperliquid returned no ${interval} candles for ${coin} in the requested window. ` +
          `Try a shorter lookback or a coarser interval.`,
      );
    }

    return out;
  }

  /**
   * Fetch the funding rates that were actually paid over the window.
   *
   * Hyperliquid settles funding hourly. Gaps are possible, so the runner
   * looks up the nearest preceding point rather than assuming a dense series.
   */
  async fetchFunding(params: {
    coin: string;
    startTime: number;
    endTime: number;
  }): Promise<FundingPoint[]> {
    const { coin, startTime, endTime } = params;
    const out: FundingPoint[] = [];

    let cursor = startTime;
    let guard = 0;

    while (cursor < endTime && guard++ < 200) {
      const raw = await this.info.fundingHistory({ coin, startTime: cursor, endTime });
      if (!raw.length) break;

      for (const point of raw) {
        if (out.length && point.time <= out[out.length - 1]!.time) continue;
        out.push({ time: point.time, rate: Number(point.fundingRate) });
      }

      const last = raw[raw.length - 1]!.time;
      if (last <= cursor) break;
      cursor = last + 1;
    }

    logger.info({ coin, points: out.length }, "loaded funding history");
    return out;
  }
}

/**
 * Step through a funding series in time order.
 *
 * Returns the total rate accrued since the previous call, so a backtest running
 * on 15-minute candles still applies each hourly settlement exactly once.
 */
export class FundingSchedule {
  private index = 0;

  constructor(private readonly points: FundingPoint[]) {}

  /** Sum of every funding settlement at or before `timeMs` and not yet consumed. */
  accrueUntil(timeMs: number): number {
    let total = 0;
    while (this.index < this.points.length && this.points[this.index]!.time <= timeMs) {
      total += this.points[this.index]!.rate;
      this.index++;
    }
    return total;
  }
}

const iso = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());
