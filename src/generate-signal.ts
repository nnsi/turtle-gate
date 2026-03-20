#!/usr/bin/env tsx
/** Signal generation entry point (§8.3/§8.5/§8.6/§19). */

import { fetchAllData } from "./data.js";
import { generateSignals, applyDualBandFilter } from "./signal.js";
import { correlationMatrix } from "./linalg.js";
import { DEFAULT_PARAMS, CFULL_START, CFULL_END } from "./config.js";
import { makeTradeDecision, type TradeDecision } from "./trade-decision.js";
import { computeCfullDrift, formatDriftReport } from "./cfull-monitor.js";
import { getPhaseConfig, type Phase } from "./gate.js";
import { formatSignalReport } from "./format-signal.js";
import { getDb, upsertSignal } from "./trade-history.js";
import * as fs from "node:fs";
import * as path from "node:path";

type CliArgs = {
  start: string; end: string;
  percentile: number; percentileLow: number;
  outputDir: string; csv?: string; phase: Phase;
  L?: number; K?: number; lambda?: number; q?: number;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let start = "", end = "";
  let percentile = DEFAULT_PARAMS.confidencePercentile;
  let percentileLow = DEFAULT_PARAMS.confidencePercentileLow;
  let outputDir = "output";
  let csv: string | undefined;
  let phase: Phase = (process.env.PHASE as Phase) ?? "normal";
  let L: number | undefined, K: number | undefined, lambda: number | undefined, q: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--start": start = args[++i]; break;
      case "--end": end = args[++i]; break;
      case "--percentile": percentile = Number(args[++i]); break;
      case "--percentile-low": percentileLow = Number(args[++i]); break;
      case "--output": outputDir = args[++i]; break;
      case "--csv": csv = args[++i]; break;
      case "--phase": phase = args[++i] as Phase; break;
      case "--L": L = Number(args[++i]); break;
      case "--K": K = Number(args[++i]); break;
      case "--lambda": lambda = Number(args[++i]); break;
      case "--q": q = Number(args[++i]); break;
    }
  }
  if (!end) end = new Date().toISOString().slice(0, 10);
  if (!start) { const d = new Date(end); d.setFullYear(d.getFullYear() - 1); start = d.toISOString().slice(0, 10); }
  return { start, end, percentile, percentileLow, outputDir, csv, phase, L, K, lambda, q };
}

async function main() {
  const cliArgs = parseArgs();
  const { start, end, percentile: cliPercentile, percentileLow: cliPercentileLow, outputDir, csv, phase } = cliArgs;
  const params = {
    ...DEFAULT_PARAMS,
    ...(cliArgs.L != null && { L: cliArgs.L }),
    ...(cliArgs.K != null && { K: cliArgs.K }),
    ...(cliArgs.lambda != null && { lambda: cliArgs.lambda }),
    ...(cliArgs.q != null && { q: cliArgs.q }),
  };

  // §19.3 Phase-based config override
  const phaseConfig = getPhaseConfig(phase);
  const percentile = phaseConfig.minPercentile > cliPercentile ? phaseConfig.minPercentile : cliPercentile;
  const percentileLow = phaseConfig.allowMediumBand ? cliPercentileLow : percentile;

  console.log(`Signal Generation (PCA_SUB)`);
  console.log(`  Period: ${start} to ${end}`);
  console.log(`  Params: L=${params.L}, K=${params.K}, λ=${params.lambda}, q=${params.q}`);
  console.log(`  Confidence Filter: P${percentileLow}/P${percentile} (dual-band)`);
  console.log(`  Phase: ${phase} (LLM: ${phaseConfig.useLLM ? "ON" : "OFF"}, medium band: ${phaseConfig.allowMediumBand ? "ON" : "OFF"})`);
  console.log(`  LLM Provider: ${process.env.LLM_PROVIDER ?? "mock"}`);
  console.log("");

  // 1. Fetch data
  const dataStart = start < CFULL_START ? start : CFULL_START;
  const { dates, tickers, matrix } = await fetchAllData(dataStart, end, csv);
  console.log(`Aligned data: ${dates.length} dates × ${tickers.length} tickers`);

  // 1b. Estimate Cfull (§8.2.1)
  const cfullRows = matrix.filter((_, i) => dates[i] >= CFULL_START && dates[i] <= CFULL_END);
  if (cfullRows.length < 60) console.warn(`Cfull: only ${cfullRows.length} rows (need ≥60)`);
  const cfullSource = cfullRows.length >= 60 ? cfullRows : matrix;
  const Cfull = correlationMatrix(cfullSource);
  console.log(`Cfull estimated from ${cfullSource.length} rows\n`);

  // 2. Generate signals
  const recentReturns = matrix.slice(Math.max(0, matrix.length - 250));
  console.log("Generating signals...");
  const signals = generateSignals(dates, matrix, tickers, params, Cfull);
  console.log(`Generated ${signals.length} signal dates`);

  // 2b. Cfull drift monitor (§8.2.1) — after signals so dailyReturns are available
  const dailyReturns = signals.map((s) => ({ date: s.date, grossReturn: s.signalRange }));
  const driftReport = recentReturns.length >= 60
    ? computeCfullDrift(recentReturns, Cfull, dates[dates.length - 1], params.K, dailyReturns)
    : null;
  if (driftReport) {
    for (const line of formatDriftReport(driftReport)) console.log(line);
    console.log("");
  }

  // 3. Dual-band confidence filter (§8.3)
  const confidenceResults = applyDualBandFilter(signals, percentile, percentileLow);
  const highDays = confidenceResults.filter((c) => c.band === "high");
  const mediumDays = confidenceResults.filter((c) => c.band === "medium");
  const tradeDays = confidenceResults.filter((c) => c.isTradeDay);

  console.log(`Confidence bands (P${percentileLow}/P${percentile}):`);
  console.log(`  HIGH:   ${highDays.length} (${((highDays.length / confidenceResults.length) * 100).toFixed(1)}%)`);
  console.log(`  MEDIUM: ${mediumDays.length} (${((mediumDays.length / confidenceResults.length) * 100).toFixed(1)}%)`);
  console.log(`  LOW:    ${confidenceResults.length - highDays.length - mediumDays.length}\n`);

  // 4. Trade decision for latest date (§8.6)
  const latestIdx = signals.length - 1;
  let latestDecision: TradeDecision | undefined;

  if (latestIdx >= 0) {
    const band = confidenceResults[latestIdx].band;
    if (band === "medium" && phaseConfig.useLLM) {
      console.log("Running LLM judgment for latest medium-confidence signal...");
      latestDecision = await makeTradeDecision(signals[latestIdx], confidenceResults[latestIdx]);
      console.log(`  LLM: ${latestDecision.llmResult?.judgment ?? "N/A"} → size=${latestDecision.size}`);
      if (latestDecision.eventDominance) {
        console.log("  *** EVENT DOMINANCE DETECTED — 当日全売買停止 (§11.3) ***");
      }
    } else if (band === "medium" && !phaseConfig.useLLM) {
      // Phase without LLM: medium band auto-pass (P80 all-pass mode)
      latestDecision = await makeTradeDecision(signals[latestIdx], {
        ...confidenceResults[latestIdx], band: "high", // treat as high for auto-pass
      });
    } else if (band === "high") {
      latestDecision = await makeTradeDecision(signals[latestIdx], confidenceResults[latestIdx]);
    }
    console.log("");
  }

  // 5. Output
  fs.mkdirSync(outputDir, { recursive: true });

  const jsonOutput = {
    generatedAt: new Date().toISOString(),
    phase,
    params: { ...params, confidencePercentileLow: percentileLow },
    cfullDrift: driftReport,
    confidencePercentile: percentile, confidencePercentileLow: percentileLow,
    totalDates: confidenceResults.length,
    tradeDays: tradeDays.length, highDays: highDays.length, mediumDays: mediumDays.length,
    lowDays: confidenceResults.length - highDays.length - mediumDays.length,
    passRate: tradeDays.length / confidenceResults.length,
    latestDecision: latestDecision ?? null,
    results: signals.map((s, i) => ({ ...s, confidence: confidenceResults[i] })),
  };
  const jsonPath = path.join(outputDir, "signals.json");
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2));
  console.log(`JSON output: ${jsonPath}`);

  if (latestIdx >= 0) {
    const report = formatSignalReport(signals[latestIdx], confidenceResults[latestIdx], latestDecision);
    const reportPath = path.join(outputDir, "latest-signal.txt");
    fs.writeFileSync(reportPath, report);
    console.log(`Latest signal report: ${reportPath}\n`);
    console.log(report);
  }

  const summaryPath = path.join(outputDir, "trade-days.txt");
  const summaryLines = tradeDays.map((td) => {
    const sr = signals.find((s) => s.date === td.date)!;
    return `${td.date}  Band=${(td.band ?? "?").toUpperCase().padEnd(6)}  Range=${td.signalRange.toFixed(4)}  Long=[${sr.longCandidates.join(",")}]  Short=[${sr.shortCandidates.join(",")}]`;
  });
  fs.writeFileSync(summaryPath, summaryLines.join("\n"));
  console.log(`Trade day summary: ${summaryPath}`);

  // 6. Persist to trade-history SQLite
  if (latestIdx >= 0) {
    const conf = confidenceResults[latestIdx];
    const db = getDb(path.join(outputDir, "trade-history.db"));
    upsertSignal(db, {
      date: signals[latestIdx].date,
      band: conf.band ?? "low",
      signalRange: signals[latestIdx].signalRange,
      thresholdHigh: conf.thresholdHigh ?? conf.threshold,
      thresholdLow: conf.thresholdLow ?? conf.threshold,
      llmJudgment: latestDecision?.llmResult?.judgment,
      llmEventDominance: latestDecision?.eventDominance,
      size: latestDecision?.size,
      sizeMultiplier: latestDecision?.sizeMultiplier,
      longCandidates: signals[latestIdx].longCandidates,
      shortCandidates: signals[latestIdx].shortCandidates,
      phase,
    });
    db.close();
    console.log(`Trade history updated: ${path.join(outputDir, "trade-history.db")}`);
  }
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
