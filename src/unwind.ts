#!/usr/bin/env tsx
/**
 * Position unwind CLI (§8.9 手仕舞い).
 *
 * Closes all open positions at end of day (14:50–15:00 JST).
 *
 * Usage:
 *   npx tsx src/unwind.ts [--output DIR] [--force]
 *
 * Env vars:
 *   BROKER_PROVIDER — "mock" (default, dry-run) | "kabu"
 */

import { getBroker } from "./broker.js";
import { UNWIND_START_TIME, UNWIND_END_TIME, JP_SECTOR_NAMES } from "./config.js";
import { getDb, upsertUnwind } from "./trade-history.js";
import * as fs from "node:fs";
import * as path from "node:path";

type Args = { outputDir: string; force: boolean };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let outputDir = "output";
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output") outputDir = args[++i];
    else if (args[i] === "--force") force = true;
  }
  return { outputDir, force };
}

/** Check if current time is in the unwind window (§8.9: 14:50–15:00 JST) */
function checkUnwindWindow(): { inWindow: boolean; warning?: string } {
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const minutes = jst.getHours() * 60 + jst.getMinutes();
  const [startH, startM] = UNWIND_START_TIME.split(":").map(Number);
  const [endH, endM] = UNWIND_END_TIME.split(":").map(Number);
  const windowStart = startH * 60 + startM;
  const windowEnd = endH * 60 + endM;

  if (minutes >= windowStart && minutes <= windowEnd) return { inWindow: true };
  const currentTime = `${String(jst.getHours()).padStart(2, "0")}:${String(jst.getMinutes()).padStart(2, "0")}`;
  return {
    inWindow: false,
    warning: `現在 ${currentTime} JST — 手仕舞い時刻帯は ${UNWIND_START_TIME}–${UNWIND_END_TIME} JST です`,
  };
}

/** Check signals.json for non-trade-day status (§8.9: flat on non-trade days) */
function checkNonTradeDay(outputDir: string): boolean {
  const signalFile = path.join(outputDir, "signals.json");
  if (!fs.existsSync(signalFile)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    const decision = data.latestDecision;
    return decision?.size === "skip";
  } catch {
    return false;
  }
}

async function main() {
  let { outputDir, force } = parseArgs();
  const broker = await getBroker();

  console.log(`=== 手仕舞い (§8.9) ===`);
  console.log(`Broker: ${broker.name}`);
  console.log(`時刻: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`);
  console.log("");

  // §8.9 非取引日フラットポジション保証
  if (checkNonTradeDay(outputDir)) {
    const positions = await broker.getPositions();
    if (positions.length > 0) {
      console.log("Warning: 非取引日にポジション残存。フラットポジション維持のため手仕舞い実行。");
      force = true;
    }
  }

  // Time window check
  const { inWindow, warning } = checkUnwindWindow();
  if (!inWindow) {
    console.log(`Warning: ${warning}`);
    if (!force) {
      console.log("時刻帯外のため中止します。--force で強制実行可能。");
      return;
    }
    console.log("--force 指定のため続行します。");
  }
  console.log("");

  // Get positions
  const positions = await broker.getPositions();
  if (positions.length === 0) {
    console.log("保有ポジションなし。");
    return;
  }

  console.log("--- 保有ポジション ---");
  for (const p of positions) {
    const name = JP_SECTOR_NAMES[p.ticker] ?? p.ticker;
    const pnl = p.unrealizedPnl >= 0 ? `+${p.unrealizedPnl}` : String(p.unrealizedPnl);
    console.log(
      `  ${p.side.toUpperCase().padEnd(5)} ${p.ticker} (${name})  ${p.quantity}株 @${p.averageEntryPrice} → ${p.currentPrice}  PnL: ¥${pnl}`,
    );
  }
  console.log("");

  // Close all
  console.log("--- 手仕舞い実行 ---");
  const results = await broker.closeAllPositions();

  // Save
  const output = {
    unwoundAt: new Date().toISOString(),
    broker: broker.name,
    positions,
    closeResults: results,
  };
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, "unwind-results.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n結果保存: ${outPath}`);

  const closed = results.filter((r) => r.status === "accepted").length;
  console.log(`手仕舞い結果: ${closed} / ${results.length} closed`);

  // Write to trade-history SQLite
  if (positions.length > 0) {
    const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const totalNotional = positions.reduce((s, p) => s + p.averageEntryPrice * p.quantity, 0);
    const grossReturn = totalNotional > 0 ? totalPnl / totalNotional : 0;
    const tradeDate = new Date().toISOString().slice(0, 10);
    const db = getDb(path.join(outputDir, "trade-history.db"));
    upsertUnwind(db, tradeDate, grossReturn);
    db.close();
    console.log(`SQLite更新: grossReturn=${(grossReturn * 100).toFixed(4)}% (${tradeDate})`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
