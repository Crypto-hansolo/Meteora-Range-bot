#!/usr/bin/env node
import { logger } from "./logger.js";
import type { Engine as EngineType } from "./strategy/engine.js";
import type { PositionPlan } from "./strategy/planner.js";

const USAGE = `
Meteora delta-neutral LP bot

Usage: npm run <command> [-- <pool address>]

Commands:
  scan              Rank pools by the return this strategy can actually expect
  plan [pool]       Show the full plan (range, deposit, hedge, leverage) without trading
  run  [pool]       Open the position + hedge, then keep the hedge tracking the delta
  status            Show the live session
  close             Unwind the LP position and the hedge

The strategy in one line: provide liquidity in a high fee/TVL Meteora DLMM pool,
then short exactly the pool's token exposure on Hyperliquid so the position earns
fees without taking a directional bet.

Set DRY_RUN=false in .env to place real orders. It defaults to true.
`;

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const poolArg = rest.find((arg) => !arg.startsWith("-"));

  // Handled before touching config so `--help` works without a populated .env.
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE.trim());
    return;
  }

  const { assertTradingCredentials, config } = await import("./config.js");
  const { Engine } = await import("./strategy/engine.js");

  if (config.dryRun && command !== "scan" && command !== "plan") {
    logger.warn("DRY_RUN is enabled: no orders or transactions will be sent");
  }

  const engine: EngineType = new Engine();

  switch (command) {
    case "scan": {
      const { candidates, rejected } = await engine.scan();
      printScan(candidates, rejected, config.selection.scanLimit);
      return;
    }

    case "plan": {
      const plan = await engine.plan(poolArg);
      printPlan(plan, config.hedge.rebalanceThresholdPct);
      return;
    }

    case "run": {
      if (!config.dryRun) assertTradingCredentials();
      await engine.run(poolArg);
      return;
    }

    case "status": {
      const { session, report } = await engine.status();
      if (!session) {
        console.log("No open session.");
        return;
      }
      console.log(`Pool:      ${session.poolName} (${session.poolAddress})`);
      console.log(`Position:  ${session.positionPubkey}`);
      console.log(`Bins:      ${session.lowerBinId}..${session.upperBinId}`);
      console.log(`Opened:    ${new Date(session.startedAt).toISOString()}`);
      console.log(`HL wallet: ${engine.hedgeAccount}`);

      if (!report) {
        console.log("\nPosition not found on chain — run close to clear the state.");
        return;
      }

      console.log(`\nIn range:  ${report.inRange ? "yes" : "NO (earning no fees)"}`);
      console.log(`LP value:  $${report.lpValueUsd.toFixed(2)}`);
      console.log(`HL equity: $${report.hedgeAccountValueUsd.toFixed(2)}`);
      console.log(`Total:     $${report.equityUsd.toFixed(2)}`);
      console.log(
        `Drawdown:  ${report.drawdownPct.toFixed(2)}% (limit ${config.loop.maxDrawdownPct}%)`,
      );
      console.log("\nHedge legs:");
      for (const leg of report.legs) {
        console.log(
          `  ${leg.symbol.padEnd(10)} position ${leg.currentSzi.toFixed(4).padStart(12)}  ` +
            `target ${(-leg.targetShort).toFixed(4).padStart(12)}  ` +
            `drift $${leg.driftUsd.toFixed(2).padStart(9)}  ` +
            `lev ${leg.effectiveLeverage.toFixed(2)}x  ` +
            `liq ${leg.liquidationPx === null ? "n/a" : `$${leg.liquidationPx.toFixed(4)}`}`,
        );
      }
      return;
    }

    case "close": {
      if (!config.dryRun) assertTradingCredentials();
      await engine.close();
      return;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE.trim());
      process.exitCode = 1;
  }
}

type ScanOutput = Awaited<ReturnType<EngineType["scan"]>>;

function printScan(
  candidates: ScanOutput["candidates"],
  rejected: ScanOutput["rejected"],
  scanLimit: number,
): void {
  if (!candidates.length) {
    console.log(`No pool passed the filters. ${rejected.length} rejected.\n`);
    console.log("Most common reasons:");
    const counts = new Map<string, number>();
    for (const r of rejected) {
      const key = r.reason.replace(/\$[\d,.]+|[\d.]+%|\b\d+\b/g, "N");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [reason, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${String(count).padStart(4)}x  ${reason}`);
    }
    return;
  }

  const shown = candidates.slice(0, scanLimit);
  console.log(
    `Top ${shown.length} of ${candidates.length} eligible pools ` +
      `(${rejected.length} rejected), ranked by net APR on total capital:\n`,
  );

  const header =
    "  # Pool                  TVL      Fees24h  Fee/TVL  LP APR   Fund APR  Net APR  Hedge";
  console.log(header);
  console.log("  " + "-".repeat(header.length - 2));

  shown.forEach((candidate, index) => {
    const { pool, plan } = candidate;
    const r = plan.expectedReturn;
    const hedge = plan.legs
      .map((l) => `${l.size.toFixed(3)} ${l.symbol}@${l.leverage}x`)
      .join(" + ");
    console.log(
      `${String(index + 1).padStart(3)} ` +
        pool.name.slice(0, 20).padEnd(21) +
        usd(pool.tvlUsd).padStart(8) +
        usd(pool.fees24hUsd).padStart(9) +
        pct(pool.feeTvlRatio24h).padStart(9) +
        pct(r.lpFeeApr).padStart(9) +
        pct(r.fundingApr).padStart(10) +
        pct(r.netAprOnTotalCapital).padStart(9) +
        "  " +
        hedge,
    );
  });

  console.log(
    `\nFee/TVL is per day; APRs are annualised. "Net APR" is on LP capital plus hedge ` +
      `collateral,\nso it already accounts for the margin the hedge locks up and the funding it pays or earns.`,
  );
  console.log(`\nInspect one with:  npm run plan -- <pool address>`);
}

function printPlan(plan: PositionPlan, rebalanceThresholdPct: number): void {
  const { pool, tokens, range, composition, deposit, legs, expectedReturn: r } = plan;

  console.log(`Pool         ${pool.name}  (${pool.address})`);
  console.log(`Bin step     ${pool.binStep} bps   base fee ${(pool.baseFee * 100).toFixed(3)}%`);
  console.log(`TVL          $${usd(pool.tvlUsd)}    24h fees $${usd(pool.fees24hUsd)}`);
  console.log(`Fee/TVL      ${pct(pool.feeTvlRatio24h)} per day  →  ${pct(r.lpFeeApr)} APR`);

  console.log(`\n--- LP position ---`);
  console.log(
    `Range        -${(range.downsideDistance * 100).toFixed(2)}% .. ` +
      `+${(range.upsideDistance * 100).toFixed(2)}%   (${range.binCount} bins, ` +
      `${range.minBinId}..${range.maxBinId})`,
  );
  console.log(
    `Split        ${(composition.valueShareX * 100).toFixed(1)}% ${tokens.x.symbol} / ` +
      `${(composition.valueShareY * 100).toFixed(1)}% ${tokens.y.symbol}`,
  );
  console.log(
    `Deposit      ${deposit.xUnits.toFixed(6)} ${tokens.x.symbol} ` +
      `($${deposit.xUsd.toFixed(2)})  +  ${deposit.yUnits.toFixed(6)} ${tokens.y.symbol} ` +
      `($${deposit.yUsd.toFixed(2)})`,
  );

  console.log(`\n--- Hedge (Hyperliquid) ---`);
  for (const leg of legs) {
    console.log(`${leg.symbol}`);
    console.log(`  short      ${leg.size.toFixed(6)} ${leg.symbol} @ $${leg.price.toFixed(4)}`);
    console.log(`  notional   $${leg.notionalUsd.toFixed(2)}`);
    console.log(
      `  leverage   ${leg.leverage}x  (${leg.leverageBoundBy})   margin $${leg.collateralUsd.toFixed(2)}`,
    );
    console.log(
      `  liq price  $${leg.liquidationPx.toFixed(4)}  ` +
        `(+${(leg.liquidationBuffer * 100).toFixed(1)}% vs spot; range top is ` +
        `+${(range.upsideDistance * 100).toFixed(2)}%)`,
    );
    console.log(`  maint mgn  ${(leg.mmf * 100).toFixed(2)}%`);
  }

  console.log(`\n--- Capital & return ---`);
  console.log(`LP capital        $${r.lpCapitalUsd.toFixed(2)}`);
  console.log(`Hedge collateral  $${r.hedgeCollateralUsd.toFixed(2)}`);
  console.log(`Total deployed    $${r.totalCapitalUsd.toFixed(2)}`);
  console.log(`LP fee APR        ${pct(r.lpFeeApr)}  (on LP capital)`);
  console.log(`Funding APR       ${pct(r.fundingApr)}  (on LP capital; negative = short pays)`);
  console.log(`Net APR           ${pct(r.netAprOnTotalCapital)}  (on total deployed capital)`);

  if (plan.warnings.length) {
    console.log(`\n--- Warnings ---`);
    for (const warning of plan.warnings) console.log(`  ! ${warning}`);
  }

  console.log(
    `\nThe hedge is not set-and-forget: the LP position's token balance changes as price` +
      `\nmoves through the range, so the bot re-shorts whenever the drift exceeds ` +
      `${rebalanceThresholdPct}%.`,
  );
}

const usd = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(0)}k`
      : n.toFixed(0);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, "fatal");
  if (error instanceof Error && error.stack && process.env.LOG_LEVEL === "debug") {
    console.error(error.stack);
  }
  process.exit(1);
});
