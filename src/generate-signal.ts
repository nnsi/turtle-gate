#!/usr/bin/env tsx
/** Signal generation entry point (§8.3/§8.5/§8.6/§19). */

import { fetchAllData } from "./data.js";
import { applyDualBandFilter } from "./signal.js";
import { DEFAULT_PARAMS, CFULL_START } from "./config.js";
import { makeTradeDecision, type TradeDecision } from "./trade-decision.js";
import { getPhaseConfig, type Phase } from "./gate.js";
import { formatSignalReport } from "./format-signal.js";
import { getDb, upsertSignal, saveRawMarketData, getHistory } from "./trade-history.js";
import { getSignalProvider } from "./signal-provider.js";
import type { DailyReturnRecord } from "./cfull-monitor.js";
import type { CfullDriftReport } from "./cfull-monitor.js";
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
  if (!end) end = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
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
  let phaseConfig = getPhaseConfig(phase);

  // §13.3: Read monitor-override.json for auto-switch
  const overridePath = path.join(outputDir, "monitor-override.json");
  if (fs.existsSync(overridePath)) {
    try {
      const override = JSON.parse(fs.readFileSync(overridePath, "utf-8"));
      if (override.action === "disable_llm") {
        console.log(`Monitor override: LLM無効化 (${override.reason})`);
        phaseConfig = { ...phaseConfig, useLLM: false };
      } else if (override.action === "degrade_to_p90") {
        console.log(`Monitor override: P90のみに縮退 (${override.reason})`);
        phaseConfig = { ...phaseConfig, useLLM: false, minPercentile: 90, allowMediumBand: false };
      }
    } catch { /* ignore malformed override */ }
  }

  const percentile = phaseConfig.minPercentile > cliPercentile ? phaseConfig.minPercentile : cliPercentile;
  const percentileLow = phaseConfig.allowMediumBand ? cliPercentileLow : percentile;

  // Resolve signal provider
  const provider = await getSignalProvider();

  console.log(`Signal Generation (${provider.name})`);
  console.log(`  Period: ${start} to ${end}`);
  console.log(`  Params: L=${params.L}, K=${params.K}, λ=${params.lambda}, q=${params.q}`);
  console.log(`  Confidence Filter: P${percentileLow}/P${percentile} (dual-band)`);
  console.log(`  Phase: ${phase} (LLM: ${phaseConfig.useLLM ? "ON" : "OFF"}, medium band: ${phaseConfig.allowMediumBand ? "ON" : "OFF"})`);
  console.log(`  Signal Provider: ${provider.name}`);
  console.log(`  LLM Provider: ${process.env.LLM_PROVIDER ?? "mock"}`);
  console.log("");

  // 1. Fetch data
  const dataStart = start < CFULL_START ? start : CFULL_START;
  const { dates, tickers, matrix, rawPrices } = await fetchAllData(dataStart, end, csv);
  console.log(`Aligned data: ${dates.length} dates × ${tickers.length} tickers`);

  // 1b. Read trade history for provider diagnostics (e.g., Cfull drift)
  const dbPath = path.join(outputDir, "trade-history.db");
  let historyReturns: DailyReturnRecord[] = [];
  {
    const histDb = getDb(dbPath);
    const histRows = getHistory(histDb);
    histDb.close();
    historyReturns = histRows
      .filter((r) => r.gross_return != null)
      .map((r) => ({
        date: r.date,
        grossReturn: r.gross_return!,
        quintileRank: r.quintile_rank ?? undefined,
      }));
  }

  // 2. Generate signals via provider
  const { signals, diagnostics } = await provider.generate({
    dates, matrix, tickers, params, historyReturns,
  });
  const driftReport = diagnostics.driftReport as CfullDriftReport | null | undefined;

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
      latestDecision = await makeTradeDecision(signals[latestIdx], confidenceResults[latestIdx], true);
    } else if (band === "high") {
      latestDecision = await makeTradeDecision(signals[latestIdx], confidenceResults[latestIdx]);
    }
    console.log("");
  }

  // 5. Output
  fs.mkdirSync(outputDir, { recursive: true });

  const jsonOutput = {
    generatedAt: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }),
    phase, provider: provider.name,
    params: { ...params, confidencePercentileLow: percentileLow },
    cfullDrift: driftReport ?? null,
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

    // Quintile rank (D.3): rank latest signalRange within PAST signal ranges only
    const pastRanges = signals.slice(0, latestIdx).map((s) => s.signalRange).sort((a, b) => a - b);
    const latestRange = signals[latestIdx].signalRange;
    let quintileRank = 3;
    if (pastRanges.length >= 5) {
      const pctile = pastRanges.filter((r) => r <= latestRange).length / pastRanges.length;
      quintileRank = Math.min(5, Math.floor(pctile * 5) + 1);
    }

    const db = getDb(path.join(outputDir, "trade-history.db"));
    upsertSignal(db, {
      date: signals[latestIdx].date,
      band: conf.band ?? "low",
      signalRange: signals[latestIdx].signalRange,
      thresholdHigh: conf.thresholdHigh ?? conf.threshold,
      thresholdLow: conf.thresholdLow ?? conf.threshold,
      llmJudgment: latestDecision?.llmResult?.judgment,
      llmEventDominance: latestDecision?.eventDominance,
      llmRawPrompt: latestDecision?.llmResult?.rawPrompt,
      llmRawResponse: latestDecision?.llmResult?.rawResponse,
      size: latestDecision?.size,
      sizeMultiplier: latestDecision?.sizeMultiplier,
      longCandidates: signals[latestIdx].longCandidates,
      shortCandidates: signals[latestIdx].shortCandidates,
      phase, quintileRank,
    });
    if (rawPrices.length > 0) {
      saveRawMarketData(db, rawPrices);
      console.log(`Raw market data saved: ${rawPrices.length} rows`);
    }

    db.close();
    console.log(`Trade history updated: ${path.join(outputDir, "trade-history.db")}`);
  }
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
