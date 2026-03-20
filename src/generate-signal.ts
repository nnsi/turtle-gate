#!/usr/bin/env tsx
/**
 * Signal generation entry point.
 *
 * Usage:
 *   npx tsx src/generate-signal.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--percentile N]
 *
 * Fetches US/JP sector ETF data, generates PCA_SUB signals,
 * applies confidence filter, and outputs results as JSON.
 */

import { fetchAllData } from "./data.js";
import { generateSignals, applyConfidenceFilter, type SignalResult } from "./signal.js";
import { DEFAULT_PARAMS, JP_SECTOR_NAMES } from "./config.js";
import * as fs from "node:fs";
import * as path from "node:path";

function parseArgs(): { start: string; end: string; percentile: number; outputDir: string } {
  const args = process.argv.slice(2);
  let start = "";
  let end = "";
  let percentile = DEFAULT_PARAMS.confidencePercentile;
  let outputDir = "output";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--start":
        start = args[++i];
        break;
      case "--end":
        end = args[++i];
        break;
      case "--percentile":
        percentile = Number(args[++i]);
        break;
      case "--output":
        outputDir = args[++i];
        break;
    }
  }

  // Default: fetch ~6 months of extra history for rolling window
  if (!end) {
    end = new Date().toISOString().slice(0, 10);
  }
  if (!start) {
    const d = new Date(end);
    d.setFullYear(d.getFullYear() - 1);
    start = d.toISOString().slice(0, 10);
  }

  return { start, end, percentile, outputDir };
}

function formatSignalReport(
  signal: SignalResult,
  confidence: { isTradeDay: boolean; threshold: number; reason?: string },
): string {
  const lines: string[] = [];
  lines.push(`=== ${signal.date} ===`);
  lines.push(`Signal Range: ${signal.signalRange.toFixed(4)}`);
  lines.push(`Confidence Threshold: ${confidence.threshold.toFixed(4)}`);
  lines.push(`Trade Day: ${confidence.isTradeDay ? "YES" : "NO"}`);
  if (confidence.reason) lines.push(`Reason: ${confidence.reason}`);
  lines.push("");

  lines.push("Factor Scores: " + signal.factorScores.map((f) => f.toFixed(4)).join(", "));
  lines.push("");

  lines.push("Long Candidates:");
  for (const t of signal.longCandidates) {
    const name = JP_SECTOR_NAMES[t] ?? t;
    lines.push(`  ${t} (${name}): ${signal.signals[t].toFixed(4)}`);
  }
  lines.push("");

  lines.push("Short Candidates:");
  for (const t of signal.shortCandidates) {
    const name = JP_SECTOR_NAMES[t] ?? t;
    lines.push(`  ${t} (${name}): ${signal.signals[t].toFixed(4)}`);
  }
  lines.push("");

  lines.push("All Signals:");
  const sorted = Object.entries(signal.signals).sort((a, b) => b[1] - a[1]);
  for (const [t, v] of sorted) {
    const name = JP_SECTOR_NAMES[t] ?? t;
    const tag = signal.longCandidates.includes(t)
      ? " [LONG]"
      : signal.shortCandidates.includes(t)
        ? " [SHORT]"
        : "";
    lines.push(`  ${t} (${name}): ${v.toFixed(4)}${tag}`);
  }

  return lines.join("\n");
}

async function main() {
  const { start, end, percentile, outputDir } = parseArgs();

  console.log(`Signal Generation (PCA_SUB)`);
  console.log(`  Period: ${start} to ${end}`);
  console.log(`  Params: L=${DEFAULT_PARAMS.L}, K=${DEFAULT_PARAMS.K}, λ=${DEFAULT_PARAMS.lambda}, q=${DEFAULT_PARAMS.q}`);
  console.log(`  Confidence Filter: P${percentile}`);
  console.log("");

  // 1. Fetch data
  const { dates, tickers, matrix } = await fetchAllData(start, end);
  console.log(`Aligned data: ${dates.length} dates × ${tickers.length} tickers`);
  console.log("");

  // 2. Generate signals
  console.log("Generating signals...");
  const signals = generateSignals(dates, matrix, tickers, DEFAULT_PARAMS);
  console.log(`Generated ${signals.length} signal dates`);

  // 3. Apply confidence filter
  const confidenceResults = applyConfidenceFilter(signals, percentile);
  const tradeDays = confidenceResults.filter((c) => c.isTradeDay);
  console.log(`Trade days (P${percentile}): ${tradeDays.length} / ${confidenceResults.length} (${((tradeDays.length / confidenceResults.length) * 100).toFixed(1)}%)`);
  console.log("");

  // 4. Output results
  fs.mkdirSync(outputDir, { recursive: true });

  // JSON output (machine-readable)
  const jsonOutput = {
    generatedAt: new Date().toISOString(),
    params: DEFAULT_PARAMS,
    confidencePercentile: percentile,
    totalDates: confidenceResults.length,
    tradeDays: tradeDays.length,
    passRate: tradeDays.length / confidenceResults.length,
    results: signals.map((s, i) => ({
      ...s,
      confidence: confidenceResults[i],
    })),
  };
  const jsonPath = path.join(outputDir, "signals.json");
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2));
  console.log(`JSON output: ${jsonPath}`);

  // Human-readable report for latest date
  const latestIdx = signals.length - 1;
  if (latestIdx >= 0) {
    const report = formatSignalReport(signals[latestIdx], confidenceResults[latestIdx]);
    const reportPath = path.join(outputDir, "latest-signal.txt");
    fs.writeFileSync(reportPath, report);
    console.log(`Latest signal report: ${reportPath}`);
    console.log("");
    console.log(report);
  }

  // Trade day summary
  const summaryPath = path.join(outputDir, "trade-days.txt");
  const summaryLines = tradeDays.map((td) => {
    const sr = signals.find((s) => s.date === td.date)!;
    return `${td.date}  Range=${td.signalRange.toFixed(4)}  Long=[${sr.longCandidates.join(",")}]  Short=[${sr.shortCandidates.join(",")}]`;
  });
  fs.writeFileSync(summaryPath, summaryLines.join("\n"));
  console.log(`Trade day summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
