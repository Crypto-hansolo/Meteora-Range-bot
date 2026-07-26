import type { BacktestResult } from "./runner.js";

/**
 * Render a backtest as a PnL decomposition.
 *
 * The layout separates what was *measured* from what was *assumed*, because
 * that distinction decides how much the bottom line is worth: the price path,
 * funding and every rebalancing cost come from real market data, while fee
 * income is a single dial the reader chose.
 */
export function formatBacktestReport(r: BacktestResult): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  const row = (label: string, value: string, note = "") =>
    `  ${label.padEnd(34)}${value.padStart(14)}${note ? `   ${note}` : ""}`;

  push(`Backtest: ${r.symbol}`);
  push("=".repeat(66));
  push(
    `Period      ${date(r.startTime)} → ${date(r.endTime)}  (${r.days.toFixed(1)} days)`,
  );
  push(
    `Price       $${r.startPrice.toFixed(4)} → $${r.endPrice.toFixed(4)}  ` +
      `(${signed(r.priceChangePct)}%)`,
  );
  if (r.exitedEarly) push(`Ended early: ${r.exitReason}`);
  push();

  if (r.failedHedgeCount > 0) {
    push("!! RESULT NOT TRUSTWORTHY !!");
    push("-".repeat(66));
    push(
      `  The hedge could not be placed ${r.failedHedgeCount} times: the account ran out of`,
    );
    push("  collateral. The position was running directionally exposed during those");
    push(
      `  stretches — up to ${usd(r.maxUnhedgedDeltaUsd)} of unhedged delta — so the PnL below is`,
    );
    push("  a leveraged bet on price, not a delta-neutral strategy.");
    push();
    push("  Park more collateral on Hyperliquid, and move margin across as the run");
    push("  goes on. In a sustained trend the hedge loses on Hyperliquid while the");
    push("  matching gain accrues in the LP position on Solana, so the perp account");
    push("  drains even though the combined position is healthy.");
    push();
  }

  push("Capital");
  push("-".repeat(66));
  push(row("LP capital", usd(r.lpCapitalUsd)));
  push(row("Hedge collateral parked", usd(r.hedgeCollateralUsd)));
  push(row("Peak margin actually used", usd(r.peakMarginUsd)));
  push(row("Total deployed", usd(r.startCapitalUsd)));
  if (r.marginTransferCount > 0) {
    push(
      row(
        "Moved LP → perp margin",
        usd(r.marginTransferredUsd),
        `${r.marginTransferCount} transfers`,
      ),
    );
  }
  push();

  push("PnL decomposition");
  push("-".repeat(66));
  push(row("Fee income (assumed rate)", signedUsd(r.feeIncomeUsd), "← the one assumption"));
  push(row("LP price PnL", signedUsd(r.lpPricePnlUsd)));
  push(row("Hedge PnL", signedUsd(r.hedgePnlUsd)));
  push(row("Funding", signedUsd(r.fundingUsd), r.fundingUsd >= 0 ? "received" : "paid"));
  push(row("Taker fees", signedUsd(-r.takerFeesUsd)));
  push(row("Slippage", signedUsd(-r.slippageUsd)));
  push(row("On-chain costs", signedUsd(-r.onChainCostUsd)));
  push("  " + "-".repeat(48));
  push(row("Net PnL", signedUsd(r.netPnlUsd)));
  push(row("Return on total capital", `${signed(r.netReturnPct)}%`));
  push(row("Annualised", `${signed(r.apr * 100)}%`));
  push();

  push("The cost of staying delta neutral");
  push("-".repeat(66));
  push(
    row("Delta residual", signedUsd(r.deltaResidualUsd), "LP price PnL + hedge PnL"),
  );
  push(
    "  A perfect continuous hedge would leave this at zero. What is left is",
  );
  push("  loss-versus-rebalancing: the LP sells into dips and buys into rallies,");
  push("  and the hedge has to chase it. This is the number the fees must beat.");
  push();
  const totalCosts = -r.deltaResidualUsd + r.takerFeesUsd + r.slippageUsd + r.onChainCostUsd;
  push(row("Total cost of the hedge", usd(totalCosts), "residual + fees + slippage + gas"));
  push(
    row(
      "Fee income needed to break even",
      `${((totalCosts / r.lpCapitalUsd / Math.max(r.days, 1e-9)) * 100).toFixed(3)}%/day`,
      "on LP capital",
    ),
  );
  push();

  push("Activity");
  push("-".repeat(66));
  push(row("Rebalances", String(r.rebalanceCount)));
  push(
    row(
      "Hedge turnover",
      usd(r.hedgeTurnoverUsd),
      `${(r.hedgeTurnoverUsd / Math.max(r.lpCapitalUsd, 1)).toFixed(1)}x LP capital`,
    ),
  );
  push(row("Time in range", `${r.timeInRangePct.toFixed(1)}%`));
  push(row("Recenters", String(r.recenterCount)));
  push(row("Liquidations", String(r.liquidationCount), r.liquidationCount ? "!!" : ""));
  push(row("Max drawdown", `${r.maxDrawdownPct.toFixed(2)}%`));
  push(
    row("Max unhedged delta", usd(r.maxUnhedgedDeltaUsd), "peak gap between LP and hedge"),
  );
  push(
    row(
      "Failed hedge attempts",
      String(r.failedHedgeCount),
      r.failedHedgeCount ? "!! out of collateral" : "",
    ),
  );
  push();

  push("Sanity check on the fee assumption");
  push("-".repeat(66));
  push(row("Assumed fee income", usd(r.feeIncomeUsd)));
  push(
    row("Arbitrage flow alone would pay", usd(r.arbImpliedFeeUsd), "a hard floor"),
  );
  if (r.arbImpliedFeeUsd > r.feeIncomeUsd) {
    push("  The assumed rate is BELOW what the price path alone implies, so it is");
    push("  probably too pessimistic for this pool.");
  } else {
    const multiple = r.arbImpliedFeeUsd > 0 ? r.feeIncomeUsd / r.arbImpliedFeeUsd : Infinity;
    push(
      `  The assumption implies ${
        Number.isFinite(multiple) ? `${multiple.toFixed(1)}x` : "far more than"
      } the arbitrage-only income, i.e. it`,
    );
    push("  assumes that much two-way noise flow on top. Sanity-check that against");
    push("  the pool's real volume before believing the bottom line.");
  }

  return lines.join("\n");
}

/** Equity curve as CSV, for plotting elsewhere. */
export function equityCurveCsv(r: BacktestResult): string {
  const rows = ["time,price,lp_value_usd,hedge_value_usd,fee_income_usd,equity_usd,in_range"];
  for (const p of r.equityCurve) {
    rows.push(
      [
        new Date(p.time).toISOString(),
        p.price.toFixed(6),
        p.lpValueUsd.toFixed(4),
        p.hedgeValueUsd.toFixed(4),
        p.feeIncomeUsd.toFixed(4),
        p.equityUsd.toFixed(4),
        p.inRange ? "1" : "0",
      ].join(","),
    );
  }
  return rows.join("\n");
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const usd = (n: number) => `$${n.toFixed(2)}`;
const signedUsd = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
