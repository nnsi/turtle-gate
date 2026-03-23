#!/usr/bin/env tsx
/** Daily report generator (§17.1). Usage: npx tsx src/daily-report.ts [--output DIR] */

import * as fs from "node:fs";
import * as path from "node:path";

type BboSpread = {
  ticker: string;
  spreadBps: number;
  source: string;
  bid: number | null;
  ask: number | null;
};

type BboSnapshot = {
  capturedAt: string;
  targetTime: string;
  spreads: BboSpread[];
};

type DailyReport = {
  date: string;
  generatedAt: string;
  usMarketSummary: unknown | null;
  signalRange: number;
  band: string;
  thresholdHigh: number;
  thresholdLow: number;
  candidates: { long: string[]; short: string[] };
  llmResult: unknown | null;
  mechanicalFilter: unknown[];
  estimatedCostBps: number;
  execution: unknown | null;
  unwind: unknown | null;
  bboSnapshot: BboSnapshot | null;
};

function readJson(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/** Consolidate all output files into a single daily report (§17.1). */
export function generateDailyReport(outputDir: string): DailyReport {
  const signals = readJson(path.join(outputDir, "signals.json")) as Record<string, unknown> | null;
  const marketCheck = readJson(path.join(outputDir, "market-check.json")) as Record<string, unknown> | null;
  const execution = readJson(path.join(outputDir, "execution-results.json"));
  const unwind = readJson(path.join(outputDir, "unwind-results.json"));

  // Extract latest signal and decision from signals.json
  const results = (signals?.results ?? []) as Record<string, unknown>[];
  const latest = results[results.length - 1] as Record<string, unknown> | undefined;
  const decision = (signals?.latestDecision ?? null) as Record<string, unknown> | null;
  const confidence = (latest?.confidence ?? {}) as Record<string, unknown>;

  const date = (decision?.date ?? latest?.date ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })) as string;
  const band = (decision?.band ?? confidence?.band ?? "unknown") as string;
  const signalRange = (decision?.signalRange ?? latest?.signalRange ?? 0) as number;
  const thresholdHigh = (decision?.thresholdHigh ?? confidence?.thresholdHigh ?? 0) as number;
  const thresholdLow = (decision?.thresholdLow ?? confidence?.thresholdLow ?? 0) as number;

  const longCandidates = (decision?.longCandidates ?? latest?.longCandidates ?? []) as string[];
  const shortCandidates = (decision?.shortCandidates ?? latest?.shortCandidates ?? []) as string[];

  // LLM result: only present for medium band
  const llmResult = band === "medium" ? (decision?.llmResult ?? null) : null;

  // Mechanical filter from market-check
  const filterResults = (marketCheck?.filterResults ?? []) as unknown[];

  // BBO snapshot from market-check (§8.4.3)
  const bboSnapshot = (marketCheck?.bboSnapshot ?? null) as BboSnapshot | null;

  // Estimate average cost from filter spreads
  const spreads = filterResults
    .map((r) => (r as Record<string, unknown>).estimatedSpreadBps as number)
    .filter((v) => typeof v === "number" && v > 0);
  const estimatedCostBps = spreads.length > 0
    ? spreads.reduce((a, b) => a + b, 0) / spreads.length
    : 0;

  // US market summary from market-check
  const usMarketSummary = marketCheck?.usIndicators ?? null;

  return {
    date,
    generatedAt: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }),
    usMarketSummary,
    signalRange,
    band,
    thresholdHigh,
    thresholdLow,
    candidates: { long: longCandidates, short: shortCandidates },
    llmResult,
    mechanicalFilter: filterResults,
    estimatedCostBps,
    execution,
    unwind,
    bboSnapshot,
  };
}

/** Save report to output/daily-report-YYYY-MM-DD.json */
export function saveDailyReport(report: DailyReport, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = `daily-report-${report.date}.json`;
  const outPath = path.join(outputDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return outPath;
}

/** Format report for console/text output (§17.1). */
export function formatDailyReport(report: DailyReport): string {
  const lines: string[] = [];
  lines.push("=== 日次統合レポート (§17.1) ===");
  lines.push(`日付: ${report.date}`);
  lines.push(`生成時刻: ${report.generatedAt}`);
  lines.push("");

  // Band / signal
  const bandLabel = report.band === "high" ? "HIGH (高確信)"
    : report.band === "medium" ? "MEDIUM (中確信)"
    : report.band === "low" ? "LOW (低確信)"
    : report.band;
  lines.push(`確信度バンド: ${bandLabel}`);
  lines.push(`Signal Range: ${report.signalRange.toFixed(4)}`);
  lines.push(`閾値: P90=${report.thresholdHigh.toFixed(4)}, P80=${report.thresholdLow.toFixed(4)}`);
  lines.push("");

  // US market
  if (Array.isArray(report.usMarketSummary) && report.usMarketSummary.length > 0) {
    lines.push("--- 米国市場概況 ---");
    for (const ind of report.usMarketSummary) {
      const i = ind as Record<string, unknown>;
      const pct = typeof i.changePct === "number" ? (i.changePct * 100).toFixed(2) : "?";
      lines.push(`  ${i.label}: ${i.price} (${pct}%)`);

    }
    lines.push("");
  }

  // Candidates
  lines.push("--- 候補銘柄 ---");
  lines.push(`  LONG : ${report.candidates.long.join(", ") || "(なし)"}`);
  lines.push(`  SHORT: ${report.candidates.short.join(", ") || "(なし)"}`);
  lines.push("");

  // LLM (medium only)
  if (report.llmResult) {
    const llm = report.llmResult as Record<string, unknown>;
    lines.push("--- LLM判定 (中確信) ---");
    lines.push(`  判定: ${llm.judgment}`);
    lines.push(`  要約: ${llm.summary}`);
    lines.push("");
  }

  // Mechanical filter summary
  const passed = report.mechanicalFilter.filter((r) => (r as Record<string, unknown>).passed).length;
  lines.push(`--- 一次機械フィルター ---`);
  lines.push(`  通過: ${passed} / ${report.mechanicalFilter.length}`);
  lines.push(`  推定コスト: ${report.estimatedCostBps.toFixed(1)} bps (平均)`);
  lines.push("");

  // BBO snapshot
  if (report.bboSnapshot) {
    lines.push(`--- BBO スナップショット (${report.bboSnapshot.targetTime}) ---`);
    lines.push(`  取得時刻: ${report.bboSnapshot.capturedAt}`);
    for (const s of report.bboSnapshot.spreads) {
      lines.push(`  ${s.ticker}: ${s.spreadBps.toFixed(1)}bps [${s.source}]`);
    }
    lines.push("");
  }

  // Execution
  lines.push(`--- 発注結果 ---`);
  lines.push(report.execution ? `  ${JSON.stringify(report.execution)}` : "  (なし)");
  lines.push("");

  // Unwind
  lines.push(`--- 手仕舞い結果 ---`);
  lines.push(report.unwind ? `  ${JSON.stringify(report.unwind)}` : "  (なし)");

  return lines.join("\n");
}

// CLI entry point
if (process.argv[1]?.endsWith("daily-report.ts") || process.argv[1]?.endsWith("daily-report.js")) {
  const args = process.argv.slice(2);
  let outputDir = "output";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output") outputDir = args[++i];
  }

  const report = generateDailyReport(outputDir);
  const outPath = saveDailyReport(report, outputDir);
  console.log(formatDailyReport(report));
  console.log(`\n保存先: ${outPath}`);
}
