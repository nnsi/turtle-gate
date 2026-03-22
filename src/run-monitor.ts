#!/usr/bin/env tsx
/**
 * Operational monitor CLI (sections 12, 13, 17.2, 19).
 *
 * Reads trade history from SQLite, runs computeMonitorReport() and
 * checkGates()/shouldAdvancePhase(), then prints results and saves
 * a JSON report.
 *
 * Usage: npx tsx src/run-monitor.ts [--db PATH] [--phase PHASE] [--output DIR]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getDb, getHistory, toMonitorHistory } from "./trade-history.js";
import {
  computeMonitorReport,
  type TradeHistory,
  type MonitorReport,
} from "./monitor.js";
import {
  checkGates,
  shouldAdvancePhase,
  formatGateStatus,
  type Phase,
  type GateHistory,
} from "./gate.js";
import { AVG_SPREAD_BPS } from "./config.js";

type Args = { dbPath: string; phase: Phase; outputDir: string };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let dbPath = "output/trade-history.db";
  let phase: Phase = "paper";
  let outputDir = "output";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") dbPath = args[++i];
    else if (args[i] === "--phase") phase = args[++i] as Phase;
    else if (args[i] === "--output") outputDir = args[++i];
  }
  return { dbPath, phase, outputDir };
}

/** Convert toMonitorHistory output to strict TradeHistory[] */
function toStrictHistory(
  raw: ReturnType<typeof toMonitorHistory>,
): TradeHistory[] {
  return raw.map((r) => ({
    ...r,
    llmJudgment: r.llmJudgment ?? undefined,
    quintileRank: r.quintileRank ?? undefined,
    counterfactualReturn: r.counterfactualReturn,
  }));
}

/** Compute 12-month average spread from trade history rows. */
function computeAvgSpread12m(
  rows: { date: string; spread_cost_bps: number | null }[],
): number {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const cutoffStr = cutoff.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const recent = rows.filter(
    (r) => r.date >= cutoffStr && r.spread_cost_bps != null,
  );
  if (recent.length === 0) return AVG_SPREAD_BPS;
  return (
    recent.reduce((s, r) => s + (r.spread_cost_bps ?? 0), 0) / recent.length
  );
}

/** Build GateHistory from trade history rows. */
function buildGateHistory(
  rows: { date: string; spread_cost_bps: number | null; bbo_spread_bps: number | null;
    gross_return: number | null; traded: number; anomaly: number }[],
  avgSpread12m: number,
): GateHistory {
  const entries = rows.map((r) => ({
    date: r.date,
    jpxAvg12mSpread: avgSpread12m,
    // G2: live BBO / 12-month avg JPX spread (§19.2)
    liveVsJpxRatio: (r.bbo_spread_bps ?? r.spread_cost_bps ?? avgSpread12m) / avgSpread12m,
    grossReturn: r.gross_return ?? 0,
    traded: r.traded === 1,
    // G4: only count as normal if check-market was actually run (bbo_spread_bps not null)
    systemNormal: r.anomaly !== 1 && r.bbo_spread_bps != null,
  }));

  // G2: Count consecutive calendar months where live/JPX ratio exceeds 1.5
  // Only use days with actual BBO measurement (bbo_spread_bps not null)
  const G2_RATIO_LIMIT = 1.5;
  const bboRows = rows.filter((r) => r.bbo_spread_bps != null);
  const bboEntries = bboRows.map((r) => ({
    date: r.date,
    ratio: (r.bbo_spread_bps!) / avgSpread12m,
  }));

  // Latest BBO ratio for daily G2 check
  const latestBboRatio = bboEntries.length > 0 ? bboEntries[bboEntries.length - 1].ratio : null;

  // Group BBO entries by calendar month (YYYY-MM), compute monthly avg
  const byMonth = new Map<string, number[]>();
  for (const e of bboEntries) {
    const ym = e.date.slice(0, 7); // YYYY-MM
    const arr = byMonth.get(ym) ?? [];
    arr.push(e.ratio);
    byMonth.set(ym, arr);
  }
  const monthKeys = [...byMonth.keys()].sort();

  // Count consecutive calendar months exceeding from most recent backwards
  // Gap months (no BBO data) break the consecutive count
  const currentYM = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 7);
  let consecutiveMonthsExceeding = 0;
  for (let i = monthKeys.length - 1; i >= 0; i--) {
    // Check adjacency: latest observation must be current or previous month
    // and each pair must be adjacent (no gap months)
    const nextYM = i === monthKeys.length - 1 ? currentYM : monthKeys[i + 1];
    const [y1, m1] = monthKeys[i].split("-").map(Number);
    const [y2, m2] = nextYM.split("-").map(Number);
    const monthDiff = (y2 - y1) * 12 + (m2 - m1);
    if (monthDiff > 1) break; // gap month → not consecutive

    const ratios = byMonth.get(monthKeys[i])!;
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    if (avg > G2_RATIO_LIMIT) consecutiveMonthsExceeding++;
    else break;
  }

  return { entries, consecutiveMonthsExceeding, latestBboRatio };
}

function printMonitorReport(r: MonitorReport): void {
  const p = r.passRate;
  const cr = r.cumulativeReturn;
  const rr = r.grossRR;
  const sm = r.spreadMonitor;
  const rrVal = Number.isNaN(rr.rolling3m) ? "N/A" : rr.rolling3m.toFixed(2);
  const lines: string[] = [
    `\n=== Monitor Report (${r.date || "N/A"}) ===`,
    `\n--- Band Pass Rate (直近${p.total}日) ---`,
    `  High: ${(p.high * 100).toFixed(1)}%  Medium: ${(p.medium * 100).toFixed(1)}%  Low: ${(p.low * 100).toFixed(1)}%`,
  ];
  if (r.llmQuality) {
    const lq = r.llmQuality;
    lines.push(`\n--- LLM Quality [${lq.meetsThreshold ? "OK" : "NG"}] ---`);
    lines.push(`  Pass: ${lq.passAlpha.toFixed(1)}  Exclude: ${lq.excludeAlpha.toFixed(1)}  Diff: ${lq.diff.toFixed(1)} bps`);
  }
  lines.push(
    `\n--- Cumulative Return ---`,
    `  Gross: ${(cr.gross * 100).toFixed(3)}%  Net: ${(cr.net * 100).toFixed(3)}%  ConsecNeg: ${cr.consecutiveNegativeDays}d`,
    `\n--- Gross R/R: ${rrVal} ---` + (rr.belowThreshold ? ` Below threshold ${rr.consecutiveMonthsBelow}mo` : ""),
    `\n--- Spread Monitor: 12M avg ${sm.avg12m.toFixed(2)} bps ---` +
      (sm.shouldUpgrade ? ` Suggest P${sm.suggestedPercentiles.high}/P${sm.suggestedPercentiles.low}` : ""),
  );
  if (r.quintileCheck) {
    const qc = r.quintileCheck;
    lines.push(`\n--- Quintile [${qc.q5AboveQ1 ? "OK" : "NG"}]: Q5=${qc.q5Alpha.toFixed(1)} Q1=${qc.q1Alpha.toFixed(1)} bps ---`);
  }
  if (r.alerts.length > 0) {
    lines.push("\n--- Alerts ---");
    for (const a of r.alerts) lines.push(`  ${a}`);
  }
  lines.push(`\nRecommendation: ${r.recommendation.toUpperCase()}`);
  for (const l of lines) console.log(l);
}

function main(): void {
  const { dbPath, phase, outputDir } = parseArgs();

  console.log("=== Turtle-Gate Monitor (sections 12, 17.2, 19) ===");
  console.log(`DB: ${dbPath}  Phase: ${phase}  Output: ${outputDir}`);

  // 1. Load trade history
  const db = getDb(dbPath);
  const rows = getHistory(db);
  db.close();
  console.log(`Trade history: ${rows.length} rows loaded`);

  if (rows.length === 0) {
    console.log("No trade history found. Nothing to report.");
    return;
  }

  // 2. Monitor report
  const monitorHistory = toStrictHistory(toMonitorHistory(rows));
  const avgSpread12m = computeAvgSpread12m(rows);
  const report = computeMonitorReport(monitorHistory, avgSpread12m);
  printMonitorReport(report);

  // 3. Gate check
  const gateHistory = buildGateHistory(rows, avgSpread12m);
  const gateStatus = checkGates(gateHistory);
  const traded = rows.filter((r) => r.traded === 1);
  const grossRR = report.grossRR.rolling3m;
  const phaseResult = shouldAdvancePhase(
    phase, gateStatus, traded.length,
    Number.isNaN(grossRR) ? 0 : grossRR,
  );

  console.log("");
  for (const line of formatGateStatus(gateStatus, phase)) console.log(line);
  console.log(`\nPhase advancement: ${phaseResult.reason}`);
  if (phaseResult.advance) {
    console.log(`  => Advance to ${phaseResult.nextPhase}`);
  }

  // 4. Save JSON report
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, "monitor-report.json");
  const output = {
    generatedAt: new Date().toISOString(),
    phase,
    tradeCount: rows.length,
    tradedCount: traded.length,
    monitorReport: report,
    gateStatus,
    phaseAdvancement: phaseResult,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nReport saved: ${outPath}`);

  // 5. Write override flag for auto-switch (§13.3)
  const overridePath = path.join(outputDir, "monitor-override.json");
  if (report.recommendation === "disable_llm") {
    const override = { action: "disable_llm", reason: "LLM品質基準未達 → P80全通過に切替", updatedAt: new Date().toISOString() };
    fs.writeFileSync(overridePath, JSON.stringify(override, null, 2));
    console.log(`\nLLM自動切替: ${overridePath} に disable_llm を書き込み`);
  } else if (report.recommendation === "degrade_to_p90") {
    const override = { action: "degrade_to_p90", reason: "スプレッド警告 → P90のみに切替", updatedAt: new Date().toISOString() };
    fs.writeFileSync(overridePath, JSON.stringify(override, null, 2));
    console.log(`\n自動切替: ${overridePath} に degrade_to_p90 を書き込み`);
  } else if (fs.existsSync(overridePath)) {
    fs.unlinkSync(overridePath);
    console.log(`\n自動切替解除: ${overridePath} を削除`);
  }

  // 6. Exit code 1 on halt
  if (report.recommendation === "halt") {
    console.error("\nHALT condition detected. Exiting with code 1.");
    process.exit(1);
  }
}

main();
