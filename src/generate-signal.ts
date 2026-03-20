#!/usr/bin/env tsx
/**
 * Signal generation entry point.
 *
 * Usage:
 *   npx tsx src/generate-signal.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 *     [--percentile N] [--percentile-low N] [--output DIR] [--csv PATH]
 *
 * Fetches US/JP sector ETF data, generates PCA_SUB signals,
 * applies dual-band confidence filter (§8.3), runs LLM judgment
 * for medium-confidence signals (§8.5), and outputs trade decisions (§8.6).
 */

import { fetchAllData } from "./data.js";
import { generateSignals, applyDualBandFilter, type SignalResult } from "./signal.js";
import { correlationMatrix } from "./linalg.js";
import { DEFAULT_PARAMS, JP_SECTOR_NAMES, CFULL_START, CFULL_END } from "./config.js";
import { makeTradeDecision, formatTradeDecision, type TradeDecision } from "./trade-decision.js";
import { computeCfullDrift, formatDriftReport } from "./cfull-monitor.js";
import * as fs from "node:fs";
import * as path from "node:path";

type CliArgs = {
  start: string;
  end: string;
  percentile: number;
  percentileLow: number;
  outputDir: string;
  csv?: string;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let start = "";
  let end = "";
  let percentile = DEFAULT_PARAMS.confidencePercentile;
  let percentileLow = DEFAULT_PARAMS.confidencePercentileLow;
  let outputDir = "output";
  let csv: string | undefined;

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
      case "--percentile-low":
        percentileLow = Number(args[++i]);
        break;
      case "--output":
        outputDir = args[++i];
        break;
      case "--csv":
        csv = args[++i];
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

  return { start, end, percentile, percentileLow, outputDir, csv };
}

function formatSignalReport(
  signal: SignalResult,
  confidence: { isTradeDay: boolean; threshold: number; reason?: string; band?: string; thresholdHigh?: number; thresholdLow?: number },
  decision?: TradeDecision,
): string {
  const lines: string[] = [];
  lines.push(`=== ${signal.date} ===`);
  lines.push(`Signal Range: ${signal.signalRange.toFixed(4)}`);

  // Dual-band info
  if (confidence.band) {
    const bandLabel = confidence.band === "high" ? "HIGH (P90+)"
      : confidence.band === "medium" ? "MEDIUM (P80-P89)"
      : "LOW (<P80)";
    lines.push(`Confidence Band: ${bandLabel}`);
    lines.push(`Threshold High (P90): ${(confidence.thresholdHigh ?? confidence.threshold).toFixed(4)}`);
    lines.push(`Threshold Low (P80):  ${(confidence.thresholdLow ?? confidence.threshold).toFixed(4)}`);
  } else {
    lines.push(`Confidence Threshold: ${confidence.threshold.toFixed(4)}`);
  }

  lines.push(`Trade Day: ${confidence.isTradeDay ? "YES" : "NO"}`);
  if (confidence.reason) lines.push(`Reason: ${confidence.reason}`);

  // Trade decision (§8.6)
  if (decision) {
    lines.push("");
    for (const l of formatTradeDecision(decision)) lines.push(l);
  }

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
  const { start, end, percentile, percentileLow, outputDir, csv } = parseArgs();

  console.log(`Signal Generation (PCA_SUB)`);
  console.log(`  Period: ${start} to ${end}`);
  console.log(`  Params: L=${DEFAULT_PARAMS.L}, K=${DEFAULT_PARAMS.K}, λ=${DEFAULT_PARAMS.lambda}, q=${DEFAULT_PARAMS.q}`);
  console.log(`  Confidence Filter: P${percentileLow}/P${percentile} (dual-band)`);
  console.log(`  LLM Provider: ${process.env.LLM_PROVIDER ?? "mock"}`);
  console.log("");

  // 1. Fetch data (include Cfull estimation period if needed)
  const dataStart = start < CFULL_START ? start : CFULL_START;
  const { dates, tickers, matrix } = await fetchAllData(dataStart, end, csv);
  console.log(`Aligned data: ${dates.length} dates × ${tickers.length} tickers`);

  // 1b. Estimate Cfull from long-term data (§8.2.1)
  const cfullRows = matrix.filter((_, i) => dates[i] >= CFULL_START && dates[i] <= CFULL_END);
  if (cfullRows.length < 60) {
    console.warn(`Warning: Cfull estimation period has only ${cfullRows.length} rows (need ≥60). Using all available data.`);
  }
  const cfullData = cfullRows.length >= 60 ? cfullRows : matrix;
  const Cfull = correlationMatrix(cfullData);
  console.log(`Cfull estimated from ${cfullData.length} rows`);
  console.log("");

  // 1c. Cfull drift monitor (§8.2 Cfull更新ポリシー)
  const recentWindowSize = 250; // ~1 year of trading days
  const recentStart = Math.max(0, matrix.length - recentWindowSize);
  const recentReturns = matrix.slice(recentStart);
  if (recentReturns.length >= 60) {
    const driftReport = computeCfullDrift(recentReturns, Cfull, dates[dates.length - 1]);
    for (const line of formatDriftReport(driftReport)) console.log(line);
    console.log("");
  }

  // 2. Generate signals
  console.log("Generating signals...");
  const signals = generateSignals(dates, matrix, tickers, DEFAULT_PARAMS, Cfull);
  console.log(`Generated ${signals.length} signal dates`);

  // 3. Apply dual-band confidence filter (§8.3.3)
  const confidenceResults = applyDualBandFilter(signals, percentile, percentileLow);
  const highDays = confidenceResults.filter((c) => c.band === "high");
  const mediumDays = confidenceResults.filter((c) => c.band === "medium");
  const lowDays = confidenceResults.filter((c) => c.band === "low");
  const tradeDays = confidenceResults.filter((c) => c.isTradeDay);

  console.log(`Confidence bands (P${percentileLow}/P${percentile}):`);
  console.log(`  HIGH (P${percentile}+):    ${highDays.length} (${((highDays.length / confidenceResults.length) * 100).toFixed(1)}%)`);
  console.log(`  MEDIUM (P${percentileLow}-P${percentile}): ${mediumDays.length} (${((mediumDays.length / confidenceResults.length) * 100).toFixed(1)}%)`);
  console.log(`  LOW (<P${percentileLow}):      ${lowDays.length} (${((lowDays.length / confidenceResults.length) * 100).toFixed(1)}%)`);
  console.log("");

  // 4. Trade decisions for latest date only (§8.6)
  // For batch mode we only run LLM on the latest date to avoid excessive API calls
  const latestIdx = signals.length - 1;
  let latestDecision: TradeDecision | undefined;

  if (latestIdx >= 0 && confidenceResults[latestIdx].band === "medium") {
    console.log("Running LLM judgment for latest medium-confidence signal...");
    latestDecision = await makeTradeDecision(signals[latestIdx], confidenceResults[latestIdx]);
    console.log(`  LLM result: ${latestDecision.llmResult?.judgment ?? "N/A"} → size=${latestDecision.size}`);
    console.log("");
  } else if (latestIdx >= 0 && confidenceResults[latestIdx].band === "high") {
    latestDecision = await makeTradeDecision(signals[latestIdx], confidenceResults[latestIdx]);
  }

  // 5. Output results
  fs.mkdirSync(outputDir, { recursive: true });

  // Cfull drift for JSON
  const driftForJson = recentReturns.length >= 60
    ? computeCfullDrift(recentReturns, Cfull, dates[dates.length - 1])
    : null;

  // JSON output (machine-readable)
  const jsonOutput = {
    generatedAt: new Date().toISOString(),
    params: { ...DEFAULT_PARAMS, confidencePercentileLow: percentileLow },
    cfullDrift: driftForJson,
    confidencePercentile: percentile,
    confidencePercentileLow: percentileLow,
    totalDates: confidenceResults.length,
    tradeDays: tradeDays.length,
    highDays: highDays.length,
    mediumDays: mediumDays.length,
    lowDays: lowDays.length,
    passRate: tradeDays.length / confidenceResults.length,
    latestDecision: latestDecision ?? null,
    results: signals.map((s, i) => ({
      ...s,
      confidence: confidenceResults[i],
    })),
  };
  const jsonPath = path.join(outputDir, "signals.json");
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2));
  console.log(`JSON output: ${jsonPath}`);

  // Human-readable report for latest date
  if (latestIdx >= 0) {
    const report = formatSignalReport(signals[latestIdx], confidenceResults[latestIdx], latestDecision);
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
    const band = td.band ?? "?";
    return `${td.date}  Band=${band.toUpperCase().padEnd(6)}  Range=${td.signalRange.toFixed(4)}  Long=[${sr.longCandidates.join(",")}]  Short=[${sr.shortCandidates.join(",")}]`;
  });
  fs.writeFileSync(summaryPath, summaryLines.join("\n"));
  console.log(`Trade day summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
