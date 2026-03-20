#!/usr/bin/env tsx
/** Real-time market check CLI (§8.4, §8.7). */

import { JP_TICKERS, JP_SECTOR_NAMES } from "./config.js";
import { fetchAllQuotes } from "./realtime.js";
import { applyMechanicalFilter } from "./mechanical-filter.js";
import { checkPostOpen, checkTimeWindow, formatPostOpenResults } from "./post-open-check.js";
import { fetchMarketContext, formatMarketContextForConsole, detectOvernightMoves } from "./market-context.js";
import { getBroker } from "./broker.js";
import type { Level2Quote } from "./broker.js";
import type { TradeDecision } from "./trade-decision.js";
import * as fs from "node:fs";
import * as path from "node:path";

type Args = { signalFile: string; outputDir: string; checkTime?: string; level2: boolean };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let signalFile = "output/signals.json";
  let outputDir = "output";
  let checkTime: string | undefined;
  let level2 = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--signal-file") signalFile = args[++i];
    else if (args[i] === "--output") outputDir = args[++i];
    else if (args[i] === "--check-time") checkTime = args[++i];
    else if (args[i] === "--level2") level2 = true;
  }
  return { signalFile, outputDir, checkTime, level2 };
}

function fmtPrice(v: number): string {
  return v > 0 ? v.toFixed(0).padStart(8) : "---".padStart(8);
}

function fmtPct(price: number, prev: number): string {
  return (prev <= 0 || price <= 0) ? "---".padStart(7) : `${((price / prev - 1) * 100).toFixed(2)}%`.padStart(7);
}

async function main() {
  const { signalFile, outputDir, checkTime, level2: useLevel2 } = parseArgs();

  console.log("=== リアルタイム市場チェック (§8.4 + §8.7) ===");
  console.log(`時刻: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST`);

  // Time window warning (§8.7.1)
  const timeWarn = checkTimeWindow(checkTime);
  if (timeWarn) console.log(`⚠ ${timeWarn}`);
  console.log("");

  // 0. US market context (§8.1.1)
  console.log("米国主要指標取得中...");
  const usIndicators = await fetchMarketContext().catch(() => []);
  for (const line of formatMarketContextForConsole(usIndicators)) console.log(line);
  const alerts = detectOvernightMoves(usIndicators);
  if (alerts.length > 0) { console.log("  ⚠ Overnight alerts:"); for (const a of alerts) console.log(`    ${a}`); }
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
    const { price, open, previousClose: prev, dayHigh, dayLow, volume } = data.quote;
    console.log(`${ticker.padEnd(9)} ${name} ${fmtPrice(price)} ${fmtPrice(open)} ${fmtPrice(prev)} ${fmtPct(price, prev)} ${fmtPrice(dayHigh)} ${fmtPrice(dayLow)} ${String(volume).padStart(8)}`);
  }
  console.log("");

  // 2b. Level2 板情報 from broker (optional, --level2 flag)
  let level2Quotes: Map<string, Level2Quote> | undefined;
  if (useLevel2) {
    const broker = await getBroker();
    console.log(`Level2 板情報取得中 (broker: ${broker.name})...`);
    level2Quotes = await broker.getLevel2Quotes(JP_TICKERS);
    console.log(`Level2 取得成功: ${level2Quotes.size} / ${JP_TICKERS.length}`);
    console.log("");
  }

  // 3. Mechanical filter (§8.4)
  console.log("--- 一次機械フィルター (§8.4) ---");
  const filterResults = applyMechanicalFilter(JP_TICKERS, quotes, level2Quotes);
  for (const r of filterResults) {
    const nm = (JP_SECTOR_NAMES[r.ticker] ?? r.ticker).padEnd(12);
    const st = r.passed ? "✓ PASS" : "✗ SKIP";
    const src = r.spreadSource === "bid_ask" ? "実測" : r.spreadSource === "jpx_stressed" ? `JPX×${r.stressMultiplier.toFixed(1)}` : "JPX基準";
    console.log(`  ${st}  ${r.ticker} ${nm} spread=${r.estimatedSpreadBps.toFixed(1)}bps [${src}] (緊急:${r.emergencyThresholdBps.toFixed(1)}bps)  ${r.reasons.join("; ")}`);
  }
  const passCount = filterResults.filter((r) => r.passed).length;
  console.log(`\n  通過: ${passCount} / ${filterResults.length}`);

  // 4. Post-open check with signal integration (§8.7)
  let postOpenResults: ReturnType<typeof checkPostOpen> = [];
  let latestDecision: TradeDecision | null = null;
  if (fs.existsSync(signalFile)) {
    const signalData = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    const latest = signalData.results?.[signalData.results.length - 1];
    latestDecision = signalData.latestDecision ?? null;

    // Show trade decision info (§8.6)
    if (latestDecision) {
      const bandLabel = latestDecision.band === "high" ? "HIGH (auto-pass)"
        : latestDecision.band === "medium" ? `MEDIUM (LLM: ${latestDecision.llmResult?.judgment ?? "N/A"})`
        : "LOW (skip)";
      console.log(`\n--- 売買判定 (§8.6) ---`);
      console.log(`  Band: ${bandLabel}`);
      console.log(`  Size: ${latestDecision.size} (×${latestDecision.sizeMultiplier})`);
      if (latestDecision.skipReason) console.log(`  Skip: ${latestDecision.skipReason}`);
    }

    if (latest?.confidence?.isTradeDay) {
      console.log(`\n--- 寄り後価格確認 (§8.7) シグナル: ${latest.date} ---`);
      console.log(`Signal Range: ${latest.signalRange?.toFixed(4) ?? "N/A"}`);
      const band = latest.confidence?.band ?? "?";
      console.log(`Confidence Band: ${band.toUpperCase()}`);

      const longs: string[] = latest.longCandidates ?? [];
      const shorts: string[] = latest.shortCandidates ?? [];
      postOpenResults = checkPostOpen(longs, shorts, quotes);
      const lines = formatPostOpenResults(postOpenResults);
      for (const l of lines) console.log(l);

      const dirOk = postOpenResults.filter((r) => r.passed).length;
      console.log(`\n  方向維持: ${dirOk} / ${postOpenResults.length}`);

      // Combined: trade decision + mechanical filter + direction check (§8.6.1)
      const shouldTrade = !latestDecision || latestDecision.size !== "skip";
      console.log("\n--- 最終候補 (§8.6 + §8.4 + §8.7 通過) ---");
      if (!shouldTrade) {
        console.log("  ※ 売買判定により全銘柄見送り");
      } else {
        const sizeLabel = latestDecision?.size === "half" ? " [HALF]" : "";
        for (const poc of postOpenResults) {
          const mf = filterResults.find((r) => r.ticker === poc.ticker);
          const all = shouldTrade && (mf?.passed ?? false) && poc.passed;
          const dir = poc.signalDirection === "long" ? "LONG" : "SHORT";
          console.log(`  ${all ? "✓" : "✗"} ${poc.ticker} (${JP_SECTOR_NAMES[poc.ticker] ?? poc.ticker}) [${dir}]${all ? sizeLabel : ""}  filter:${mf?.passed ? "OK" : "NG"} dir:${poc.passed ? "OK" : "NG"}`);
        }
      }
    } else if (latest) {
      const band = latest.confidence?.band ?? "low";
      console.log(`\n--- シグナル (${latest.date}): ${band === "low" ? "低確信" : band} → 当日見送り ---`);
    }
  } else {
    console.log(`\n※ シグナルファイル未検出: ${signalFile}`);
  }

  // 5. Save results (includes BBO snapshot per §8.4.3)
  const now = new Date().toISOString();
  const output = {
    checkedAt: now,
    marketState: firstQuote?.quote.marketState ?? "UNKNOWN",
    broker: level2Quotes ? (await getBroker()).name : null,
    usIndicators,
    quotes: Object.fromEntries([...quotes.entries()].map(([k, v]) => [k, v.quote])),
    intradayBarCounts: Object.fromEntries([...quotes.entries()].map(([k, v]) => [k, v.bars.length])),
    level2: level2Quotes ? Object.fromEntries(level2Quotes) : null,
    filterResults,
    postOpenResults,
    tradeDecision: latestDecision,
    bboSnapshot: {
      capturedAt: now, targetTime: "09:10",
      spreads: filterResults.map((r) => ({
        ticker: r.ticker, spreadBps: r.estimatedSpreadBps,
        source: r.spreadSource, bid: r.rawBid, ask: r.rawAsk,
      })),
    },
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
