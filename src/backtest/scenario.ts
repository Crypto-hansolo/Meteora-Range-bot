import type { Candle } from "./data.js";
import { generatePath } from "./paths.js";
import { runBacktest, type BacktestParams, type BacktestResult } from "./runner.js";

/**
 * "What if the position sits in range for N days and the price ends at X?"
 *
 * ## The question this answers
 *
 * A common and reasonable-sounding intuition goes: the LP earns fees daily; if
 * price rises the LP *also* books a price gain, which partly covers the short's
 * loss; so with enough fees the whole thing is comfortably positive.
 *
 * The first half is right and the second half is not, in a way that matters.
 * The hedge is sized to the LP's delta, so the LP's price gain and the short's
 * loss do not *partly* offset — they offset **almost exactly, by construction**,
 * in both directions. If the LP gain exceeded the short loss you were not delta
 * neutral, you were net long.
 *
 * What is left over after that cancellation is never favourable. The LP sells
 * into rallies at bin prices the market has already passed, and the hedge buys
 * that exposure back at the market price. That gap, paid on every crossing, is
 * loss-versus-rebalancing.
 *
 * So the return is: **fees, minus the rebalancing cost, minus execution.** The
 * direction of the price move drops out. This module makes that visible by
 * running the same fee assumption over three deterministic endings plus a noisy
 * one, so the cancellation and the cost can be read off side by side.
 */

export interface ScenarioParams {
  /** Fee yield quoted the way pools quote it, e.g. 50 for "50% APR". */
  feeAprPct: number;
  /** Days the position is assumed to stay in range. */
  days: number;
  capitalUsd: number;
  startPrice: number;
  /** Annualised volatility for the noisy variant. */
  annualVol: number;
  /** Everything else the backtest needs. */
  strategy: Omit<BacktestParams, "candles" | "funding" | "feeTvlRatio24h" | "lpCapitalUsd">;
  /** Hourly funding credited to the short. */
  fundingHourly: number;
}

export interface ScenarioOutcome {
  label: string;
  endPricePct: number;
  result: BacktestResult;
  /** LP price PnL plus hedge PnL — the part that should cancel. */
  cancellationUsd: number;
}

export interface ScenarioReport {
  params: ScenarioParams;
  feePerDayPct: number;
  /** Deterministic drifts: no noise, so only the drift moves the price. */
  clean: ScenarioOutcome[];
  /** Same endings, but with realistic volatility on the way there. */
  noisy: ScenarioOutcome[];
  /** What the LP would be worth having simply held the deposit. */
  holdComparison: { endPricePct: number; lpUsd: number; holdUsd: number }[];
}

const HOUR = 3_600_000;

/**
 * A price path that drifts smoothly to `endMultiple` with optional noise.
 *
 * The clean variant has literally no volatility, which isolates the
 * cancellation: any residual there is pure discretisation, not market noise.
 */
function driftPath(params: {
  bars: number;
  startPrice: number;
  endMultiple: number;
  annualVol: number;
  seed: number;
}): Candle[] {
  const { bars, startPrice, endMultiple, annualVol, seed } = params;

  if (annualVol <= 0) {
    const step = Math.log(endMultiple) / bars;
    const candles: Candle[] = [];
    let price = startPrice;
    for (let i = 0; i < bars; i++) {
      const open = price;
      price = price * Math.exp(step);
      candles.push({
        t: i * HOUR,
        T: (i + 1) * HOUR,
        open,
        high: Math.max(open, price),
        low: Math.min(open, price),
        close: price,
        volume: 0,
      });
    }
    return candles;
  }

  // Noisy variant: generate a volatile path, then tilt it so it lands on the
  // same endpoint. Tilting keeps the realised volatility intact while making
  // the comparison against the clean run like-for-like.
  const raw = generatePath({ seed, bars, barMs: HOUR, startPrice, annualVol });
  const actualEnd = raw.at(-1)!.close / startPrice;
  const tiltPerBar = Math.log(endMultiple / actualEnd) / bars;

  let cumulative = 0;
  return raw.map((c, i) => {
    const openTilt = Math.exp(cumulative);
    cumulative += tiltPerBar;
    const closeTilt = Math.exp(cumulative);
    // Highs and lows sit inside the bar, so tilt them by the bar's midpoint.
    const midTilt = Math.exp(cumulative - tiltPerBar / 2);
    void i;
    return {
      ...c,
      open: c.open * openTilt,
      close: c.close * closeTilt,
      high: c.high * midTilt,
      low: c.low * midTilt,
    };
  });
}

export function runScenario(params: ScenarioParams): ScenarioReport {
  const bars = Math.round(params.days * 24);
  const feeTvlRatio24h = params.feeAprPct / 100 / 365;

  // End the run at the range edges, which is where the intuition is sharpest:
  // "price left the range upward, surely I keep some of that gain".
  const upside = params.strategy.rangeWidthPct / 100;
  const endings: { label: string; multiple: number }[] = [
    { label: `Range-Top (+${(upside * 100).toFixed(1)}%)`, multiple: 1 + upside },
    { label: "unverändert (0%)", multiple: 1 },
    { label: `Range-Boden (-${(upside * 100).toFixed(1)}%)`, multiple: 1 - upside },
  ];

  const build = (annualVol: number, seed: number): ScenarioOutcome[] =>
    endings.map((ending, i) => {
      const candles = driftPath({
        bars,
        startPrice: params.startPrice,
        endMultiple: ending.multiple,
        annualVol,
        seed: seed + i * 101,
      });

      const funding = candles.map((c) => ({ time: c.T, rate: params.fundingHourly }));

      const result = runBacktest({
        ...params.strategy,
        lpCapitalUsd: params.capitalUsd,
        feeTvlRatio24h,
        candles,
        funding,
      });

      return {
        label: ending.label,
        endPricePct: (ending.multiple - 1) * 100,
        result,
        cancellationUsd: result.lpPricePnlUsd + result.hedgePnlUsd,
      };
    });

  // How the LP compares with simply holding the deposit, unhedged.
  const holdComparison = endings.map((ending) => {
    const candles = driftPath({
      bars,
      startPrice: params.startPrice,
      endMultiple: ending.multiple,
      annualVol: 0,
      seed: 1,
    });
    const r = runBacktest({
      ...params.strategy,
      lpCapitalUsd: params.capitalUsd,
      feeTvlRatio24h: 0,
      candles,
      funding: [],
    });
    // Half the deposit rides the move when holding; the LP captures less.
    const holdUsd = params.capitalUsd * (1 + ((ending.multiple - 1) * 1) / 2);
    return {
      endPricePct: (ending.multiple - 1) * 100,
      lpUsd: params.capitalUsd + r.lpPricePnlUsd,
      holdUsd,
    };
  });

  return {
    params,
    feePerDayPct: (params.feeAprPct / 365),
    clean: build(0, 1),
    noisy: build(params.annualVol, 5000),
    holdComparison,
  };
}

export function formatScenarioReport(r: ScenarioReport): string {
  const lines: string[] = [];
  const push = (t = "") => lines.push(t);
  const usd = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

  push(
    `Szenario: ${r.params.days} Tage in Range, ${r.params.feeAprPct}% Fee-APR ` +
      `(${r.feePerDayPct.toFixed(3)}%/Tag), $${r.params.capitalUsd} LP-Kapital`,
  );
  push(
    `Range ±${r.params.strategy.rangeWidthPct}%, Vola ${(r.params.annualVol * 100).toFixed(0)}%`,
  );
  push("=".repeat(88));
  push();

  const table = (title: string, rows: ScenarioOutcome[], note: string) => {
    push(title);
    push("-".repeat(88));
    push(
      `  ${"Preis am Ende".padEnd(22)}${"LP Preis".padStart(11)}${"Short".padStart(11)}` +
        `${"= Summe".padStart(11)}${"Fees".padStart(11)}${"Kosten".padStart(11)}` +
        `${"Netto".padStart(11)}${"in Range".padStart(10)}`,
    );
    for (const o of rows) {
      const x = o.result;
      const costs = -(x.takerFeesUsd + x.slippageUsd + x.onChainCostUsd);
      push(
        `  ${o.label.padEnd(22)}` +
          usd(x.lpPricePnlUsd).padStart(11) +
          usd(x.hedgePnlUsd).padStart(11) +
          usd(o.cancellationUsd).padStart(11) +
          usd(x.feeIncomeUsd).padStart(11) +
          usd(costs).padStart(11) +
          usd(x.netPnlUsd).padStart(11) +
          `${x.timeInRangePct.toFixed(0)}%`.padStart(10),
      );
    }
    push();
    push(`  ${note}`);
    push();
  };

  table(
    "1. Glatter Preisverlauf, keine Schwankung unterwegs",
    r.clean,
    "Die Spalte '= Summe' ist der Punkt: LP-Kursgewinn und Short-Verlust heben sich\n" +
      "  auf — in BEIDE Richtungen. Was übrig bleibt, sind die Fees.",
  );

  table(
    `2. Gleiche Endpunkte, aber ${(r.params.annualVol * 100).toFixed(0)}% Vola unterwegs`,
    r.noisy,
    "Gleiche Anfangs- und Endpreise, gleiche Fees. Die Differenz zu Tabelle 1 ist\n" +
      "  der Preis dafür, den Hedge durch die Schwankungen nachzuführen.",
  );

  push("3. Was die LP-Position gegenüber schlichtem Halten macht (ohne Hedge, ohne Fees)");
  push("-".repeat(88));
  push(`  ${"Preis am Ende".padEnd(22)}${"LP-Wert".padStart(14)}${"Halten".padStart(14)}${"Differenz".padStart(14)}`);
  for (const h of r.holdComparison) {
    push(
      `  ${(h.endPricePct >= 0 ? "+" : "") + h.endPricePct.toFixed(1) + "%"}`.padEnd(24) +
        `$${h.lpUsd.toFixed(2)}`.padStart(14) +
        `$${h.holdUsd.toFixed(2)}`.padStart(14) +
        usd(h.lpUsd - h.holdUsd).padStart(14),
    );
  }
  push();
  push("  Die LP-Position steigt bei einer Rally weniger als das gehaltene Asset —");
  push("  sie verkauft auf dem Weg nach oben. Genau deshalb ist der nötige Short");
  push("  auch kleiner als die volle Position, und genau deshalb geht die Rechnung");
  push("  auf. Ein 'Kursgewinn obendrauf' entsteht dabei nicht.");
  push();

  const clean = r.clean[1]!;
  const noisy = r.noisy[1]!;
  const gammaCost = clean.result.netPnlUsd - noisy.result.netPnlUsd;
  const feeUsd = clean.result.feeIncomeUsd;

  // The premise "in range for N days" is not free: at this volatility the price
  // may well leave a narrow range long before then, and out of range the
  // position earns nothing while the hedge keeps getting whipsawed.
  const expectedMovePct =
    r.params.annualVol * Math.sqrt(r.params.days / 365) * 100;
  const worstInRange = Math.min(...r.noisy.map((o) => o.result.timeInRangePct));

  if (worstInRange < 90) {
    push("Achtung: die Annahme trägt nicht");
    push("=".repeat(88));
    push(
      `  Bei ${(r.params.annualVol * 100).toFixed(0)}% Vola beträgt die erwartete Bewegung in ` +
        `${r.params.days} Tagen rund ±${expectedMovePct.toFixed(1)}%.`,
    );
    push(
      `  Eine ±${r.params.strategy.rangeWidthPct}%-Range hält das nicht aus — die Position war ` +
        `in Tabelle 2 nur\n  ${worstInRange.toFixed(0)}% der Zeit in Range.`,
    );
    push();
    push("  Außerhalb der Range verdient sie keine Fees, während der Hedge weiter");
    push("  hin und her gerissen wird. Das ist der Grund für die Zahlen oben, nicht");
    push("  das Rebalancing an sich.");
    push();
    push(
      `  Für "${r.params.days} Tage in Range" brauchst du grob ±${(expectedMovePct * 1.5).toFixed(0)}% ` +
        `Range-Breite. Probier:`,
    );
    push(
      `    RANGE_WIDTH_PCT=${Math.ceil(expectedMovePct * 1.5)} MAX_BINS=400 npm run scenario -- ` +
        `--fee-apr=${r.params.feeAprPct} --days=${r.params.days} --vol=${r.params.annualVol}`,
    );
    push();
  }

  push("Fazit für diese Parameter");
  push("=".repeat(88));
  push(
    `  Fee-Einnahme in ${r.params.days} Tagen        ${usd(feeUsd)}  ` +
      `(${((feeUsd / r.params.capitalUsd) * 100).toFixed(2)}% auf LP-Kapital)`,
  );
  push(`  Kosten der Schwankung             ${usd(-gammaCost)}`);
  push(`  Netto bei unverändertem Preis     ${usd(noisy.result.netPnlUsd)}`);
  push();

  // The trap worth guarding against: comparing a pool's quoted APR directly
  // against a breakeven computed at a *different* range width. Both scale with
  // width, so only the ratio at the same width means anything.
  const days = Math.max(r.params.days, 1e-9);
  // Everything the fees had to cover: what was earned, minus what survived.
  const breakevenApr =
    ((feeUsd - noisy.result.netPnlUsd) / r.params.capitalUsd / days) * 365 * 100;

  push(`Ist dieser Pool tragfähig? (bei ±${r.params.strategy.rangeWidthPct}% Range)`);
  push("-".repeat(88));
  push(`  Fee-APR, den du bei dieser Breite verdienst   ${r.params.feeAprPct.toFixed(0)}%`);
  push(`  Fee-APR, den du bei dieser Breite brauchst    ${breakevenApr.toFixed(0)}%`);
  push(
    `  Verhältnis                                   ${(r.params.feeAprPct / Math.max(breakevenApr, 1e-9)).toFixed(2)}` +
      (r.params.feeAprPct >= breakevenApr ? "   tragfähig" : "   zu wenig"),
  );
  push();
  push("  Achtung, häufiger Denkfehler: den quotierten Pool-APR NICHT gegen eine");
  push("  Schwelle für eine andere Range-Breite halten. Verdiente und benötigte");
  push("  Fees skalieren beide grob mit 1/Breite, das Verhältnis bleibt deshalb");
  push("  fast gleich. Eine breitere Range senkt die Schwelle — und die Einnahme");
  push("  im selben Maß. Sie rettet keinen Pool, dessen Fee-Rate zu niedrig ist.");

  return lines.join("\n");
}
