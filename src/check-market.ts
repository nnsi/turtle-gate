#!/usr/bin/env tsx
/**
 * Real-time market check CLI (§8.4, §8.7).
 * Fetches current quotes for JP sector ETFs, applies mechanical filter,
 * and runs post-open direction checks against signal candidates.
 *
 * Usage:
 *   npx tsx src/check-market.ts [--signal-file PATH] [--output DIR] [--check-time HH:MM]
 */

import { JP_TICKERS, JP_SECTOR_NAMES } from "./config.js";
import { fetchAllQuotes } from "./realtime.js";
import { applyMechanicalFilter } from "./mechanical-filter.js";
import { checkPostOpen, checkTimeWindow, formatPostOpenResults } from "./post-open-check.js";
import * as fs from "node:fs";
import * as path from "node:path";

type Args = { signalFile: string; outputDir: string; checkTime?: string };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let signalFile = "output/signals.json";
  let outputDir = "output";
  let checkTime: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--signal-file") signalFile = args[++i];
    else if (args[i] === "--output") outputDir = args[++i];
    else if (args[i] === "--check-time") checkTime = args[++i];
  }
  return { signalFile, outputDir, checkTime };
}

function fmtPrice(v: number): string {
  return v > 0 ? v.toFixed(0).padStart(8) : "---".padStart(8);
}

function fmtPct(price: number, prev: number): string {
  if (prev <= 0 || price <= 0) return "---".padStart(7);
  return `${((price / prev - 1) * 100).toFixed(2)}%`.padStart(7);
}

async function main() {
  const { signalFile, outputDir, checkTime } = parseArgs();

  console.log("=== リアルタイム市場チェック (§8.4 + §8.7) ===");
  console.log(`時刻: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`);

  // Time window warning (§8.7.1)
  const timeWarn = checkTimeWindow(checkTime);
  if (timeWarn) console.log(`⚠ ${timeWarn}`);
  console.log("");

  // 1. Fetch quotes
  console.log("JP ETF リアルタイムデータ取得中...");
  const quotes = await fetchAllQuotes(JP_TICKERS);
  console.log(`取得成功: ${quotes.size} / ${JP_TICKERS.length}`);

  const firstQuote = quotes.values().next().value;
  if (firstQuote) {
    console.log(`市場状態: ${firstQuote.quote.marketState}`);
    if (firstQuote.quote.marketState === "CLOSED") {
      console.log("※ 市場は休場中です。直近営業日のデータを表示します。");
    }
  }
  console.log("");

  // 2. Display quotes
  console.log("--- 現在値一覧 ---");
  for (const ticker of JP_TICKERS) {
    const data = quotes.get(ticker);
    const name = (JP_SECTOR_NAMES[ticker] ?? "").padEnd(16);
    if (!data) { console.log(`${ticker.padEnd(9)} ${name}  --- 取得失敗 ---`); continue; }
    const q = data.quote;
    console.log(
      `${ticker.padEnd(9)} ${name} ${fmtPrice(q.price)} ${fmtPrice(q.open)} ${fmtPrice(q.previousClose)} ${fmtPct(q.price, q.previousClose)} ${fmtPrice(q.dayHigh)} ${fmtPrice(q.dayLow)} ${String(q.volume).padStart(8)}`,
    );
  }
  console.log("");

  // 3. Mechanical filter (§8.4)
  console.log("--- 一次機械フィルター (§8.4) ---");
  const filterResults = applyMechanicalFilter(JP_TICKERS, quotes);
  for (const r of filterResults) {
    const name = (JP_SECTOR_NAMES[r.ticker] ?? r.ticker).padEnd(12);
    const status = r.passed ? "✓ PASS" : "✗ SKIP";
    const src = r.spreadSource === "bid_ask" ? "実測" : r.spreadSource === "jpx_stressed" ? `JPX×${r.stressMultiplier.toFixed(1)}` : "JPX基準";
    console.log(
      `  ${status}  ${r.ticker} ${name} spread=${r.estimatedSpreadBps.toFixed(1)}bps [${src}] (緊急:${r.emergencyThresholdBps.toFixed(1)}bps)  ${r.reasons.join("; ")}`,
    );
  }
  const passCount = filterResults.filter((r) => r.passed).length;
  console.log(`\n  通過: ${passCount} / ${filterResults.length}`);

  // 4. Post-open check with signal integration (§8.7)
  let postOpenResults: ReturnType<typeof checkPostOpen> = [];
  if (fs.existsSync(signalFile)) {
    const signalData = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    const latest = signalData.results?.[signalData.results.length - 1];
    if (latest?.confidence?.isTradeDay) {
      console.log(`\n--- 寄り後価格確認 (§8.7) シグナル: ${latest.date} ---`);
      console.log(`Signal Range: ${latest.signalRange?.toFixed(4) ?? "N/A"}`);

      const longs: string[] = latest.longCandidates ?? [];
      const shorts: string[] = latest.shortCandidates ?? [];
      postOpenResults = checkPostOpen(longs, shorts, quotes);
      const lines = formatPostOpenResults(postOpenResults);
      for (const l of lines) console.log(l);

      const dirOk = postOpenResults.filter((r) => r.passed).length;
      console.log(`\n  方向維持: ${dirOk} / ${postOpenResults.length}`);

      // Combined: mechanical filter + direction check
      console.log("\n--- 最終候補 (§8.4 + §8.7 通過) ---");
      for (const poc of postOpenResults) {
        const mf = filterResults.find((r) => r.ticker === poc.ticker);
        const both = (mf?.passed ?? false) && poc.passed;
        const dir = poc.signalDirection === "long" ? "LONG" : "SHORT";
        console.log(`  ${both ? "✓" : "✗"} ${poc.ticker} (${JP_SECTOR_NAMES[poc.ticker] ?? poc.ticker}) [${dir}]  filter:${mf?.passed ? "OK" : "NG"} dir:${poc.passed ? "OK" : "NG"}`);
      }
    } else if (latest) {
      console.log(`\n--- シグナル (${latest.date}): 低確信 → 当日見送り ---`);
    }
  } else {
    console.log(`\n※ シグナルファイル未検出: ${signalFile}`);
  }

  // 5. Save results
  const output = {
    checkedAt: new Date().toISOString(),
    marketState: firstQuote?.quote.marketState ?? "UNKNOWN",
    quotes: Object.fromEntries([...quotes.entries()].map(([k, v]) => [k, v.quote])),
    intradayBarCounts: Object.fromEntries([...quotes.entries()].map(([k, v]) => [k, v.bars.length])),
    filterResults,
    postOpenResults,
    summary: { total: filterResults.length, passed: passCount },
  };
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, "market-check.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n結果保存: ${outPath}`);

  // Exit code: non-zero if data fetch failed significantly
  if (quotes.size < JP_TICKERS.length * 0.5) {
    console.error("ERROR: 過半数のデータ取得に失敗");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
