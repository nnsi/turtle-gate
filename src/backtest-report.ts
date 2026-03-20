/**
 * Backtest report types, stat helpers, and core sections (A-C).
 */

import type { ConfidenceBand } from "./signal.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type DayResult = {
  date: string;
  signalRange: number;
  longCandidates: string[];
  shortCandidates: string[];
  isTradeDay: boolean;
  band?: ConfidenceBand;
  threshold: number;
  thresholdHigh?: number;
  thresholdLow?: number;
  nextDayReturnCC: number;
  nextDayReturnOC: number;
  turnover: number;
  factorScores: number[];
};

export type ReportCtx = {
  results: DayResult[];
  pct: number;
  pctLow: number;
  ocAvailable: boolean;
  retLabel: string;
  getRet: (r: DayResult) => number;
  annualFactor: number;
};

export type Logger = (s: string) => void;

// ---------------------------------------------------------------------------
// Stat helpers
// ---------------------------------------------------------------------------
export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function std(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

export function maxDrawdown(cumReturns: number[]): number {
  let peak = 0;
  let mdd = 0;
  for (const cr of cumReturns) {
    if (cr > peak) peak = cr;
    const dd = cr - peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

export function tStat(arr: number[]): number {
  if (arr.length <= 1) return 0;
  return mean(arr) / (std(arr) / Math.sqrt(arr.length));
}

export function pctile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

export function pctOf(n: number, total: number): string {
  return total > 0 ? `${(n / total * 100).toFixed(1)}%` : "0.0%";
}

// ---------------------------------------------------------------------------
// A. Strategy performance — dual-band breakdown
// ---------------------------------------------------------------------------
export function reportStrategyPerformance(ctx: ReportCtx, log: Logger): void {
  const { results, pct, pctLow, retLabel, getRet, annualFactor } = ctx;

  log("═══════════════════════════════════════════════════════");
  log(`  A. Strategy Performance (Dual-Band P${pctLow}/P${pct}, ${retLabel}-based)`);
  log("═══════════════════════════════════════════════════════");
  log("");

  const highDays = results.filter((r) => r.band === "high");
  const medDays = results.filter((r) => r.band === "medium");
  const tradeDays = results.filter((r) => r.isTradeDay);

  log(`Total signal dates:  ${results.length}`);
  log(`High band (P${pct}+):   ${highDays.length} (${pctOf(highDays.length, results.length)})`);
  log(`Medium band (P${pctLow}-P${pct - 1}): ${medDays.length} (${pctOf(medDays.length, results.length)})`);
  log(`Combined trade days: ${tradeDays.length} (${pctOf(tradeDays.length, results.length)})`);
  log("");

  for (const { label, days } of [
    { label: `High (P${pct}+)`, days: highDays },
    { label: `Medium (P${pctLow}-P${pct - 1})`, days: medDays },
    { label: "Combined", days: tradeDays },
  ]) {
    const rets = days.map((r) => getRet(r));
    const avg = mean(rets);
    const t = tStat(rets);
    const winR = rets.length > 0 ? rets.filter((r) => r > 0).length / rets.length * 100 : 0;
    log(`  ${label.padEnd(22)} N=${String(days.length).padStart(4)}  avg=${avg.toFixed(1).padStart(6)} bps  t=${t.toFixed(2).padStart(5)}  win=${winR.toFixed(0)}%`);
  }
  log("");

  const avgTO = mean(results.map((r) => r.turnover));
  const costLevels = [0, 3, 5, 8, 10, 15];
  const stratReturns = results.map((r) => r.isTradeDay ? getRet(r) : 0);
  log(`Cost (1-way bps) |  AR(%)  | Risk(%) |  R/R  | MDD(%)  | BE(bps)   [${retLabel}]`);
  log("-----------------|---------|---------|-------|---------|--------");

  for (const cost of costLevels) {
    const netRets = results.map((r) => r.isTradeDay ? getRet(r) - r.turnover * cost : 0);
    const ar = mean(netRets) * annualFactor / 10000 * 100;
    const risk = std(netRets) * Math.sqrt(annualFactor) / 10000 * 100;
    const rr = risk > 0 ? ar / risk : 0;
    let cum = 0;
    const cumArr = netRets.map((r) => { cum += r / 10000; return cum; });
    const mdd = maxDrawdown(cumArr) * 100;
    const beStr = cost === 0 && avgTO > 0
      ? (mean(stratReturns) / avgTO).toFixed(1).padStart(6) : "     ";
    log(`       ${String(cost).padStart(2)}        | ${ar.toFixed(1).padStart(6)}  | ${risk.toFixed(1).padStart(6)}  | ${rr.toFixed(2).padStart(5)} | ${mdd.toFixed(1).padStart(6)}  | ${beStr}`);
  }
}

// ---------------------------------------------------------------------------
// CC reference (shown when OC is primary)
// ---------------------------------------------------------------------------
export function reportCCReference(ctx: ReportCtx, log: Logger): void {
  if (!ctx.ocAvailable) return;
  const { results, annualFactor } = ctx;
  log("");
  log("  [CC reference]");
  const ccRets = results.map((r) => r.isTradeDay ? r.nextDayReturnCC : 0);
  const m = mean(ccRets);
  const ar = m * annualFactor / 10000 * 100;
  const risk = std(ccRets) * Math.sqrt(annualFactor) / 10000 * 100;
  const rr = risk > 0 ? ar / risk : 0;
  let cum = 0;
  const cumArr = ccRets.map((r) => { cum += r / 10000; return cum; });
  const mdd = maxDrawdown(cumArr) * 100;
  log(`  CC Gross:  AR=${ar.toFixed(1)}%  Risk=${risk.toFixed(1)}%  R/R=${rr.toFixed(2)}  MDD=${mdd.toFixed(1)}%`);
  const ocMean = mean(results.map((r) => r.isTradeDay ? ctx.getRet(r) : 0));
  log(`  OC/CC ratio: ${(m !== 0 ? ocMean / m : 0).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// B. Daily rebalance (no filter)
// ---------------------------------------------------------------------------
export function reportDailyRebalance(ctx: ReportCtx, log: Logger): void {
  const { results, retLabel, getRet, annualFactor } = ctx;
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  B. Daily Rebalance (No Filter) - Reference");
  log("═══════════════════════════════════════════════════════");
  log("");
  const allRets = results.map((r) => getRet(r));
  const ar = mean(allRets) * annualFactor / 10000 * 100;
  const risk = std(allRets) * Math.sqrt(annualFactor) / 10000 * 100;
  const rr = risk > 0 ? ar / risk : 0;
  let cum = 0;
  const cumArr = allRets.map((r) => { cum += r / 10000; return cum; });
  const mdd = maxDrawdown(cumArr) * 100;
  log(`  [${retLabel}] AR: ${ar.toFixed(1)}%  Risk: ${risk.toFixed(1)}%  R/R: ${rr.toFixed(2)}  MDD: ${mdd.toFixed(1)}%  BE: ${(mean(allRets) / 2).toFixed(1)} bps`);
  log(`  Avg daily α: ${mean(allRets).toFixed(1)} bps  t-stat: ${tStat(allRets).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// C. Trade vs Non-trade
// ---------------------------------------------------------------------------
export function reportTradeVsNonTrade(ctx: ReportCtx, log: Logger): void {
  const { results, retLabel, getRet } = ctx;
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  C. Trade Day vs Non-Trade Day Returns");
  log("═══════════════════════════════════════════════════════");
  log("");
  const trRets = results.filter((r) => r.isTradeDay).map((r) => getRet(r));
  const ntRets = results.filter((r) => !r.isTradeDay).map((r) => getRet(r));
  log(`  [${retLabel}]`);
  log(`  Trade days:     N=${trRets.length}  avg=${mean(trRets).toFixed(1)} bps  t=${tStat(trRets).toFixed(2)}`);
  log(`  Non-trade days: N=${ntRets.length}  avg=${mean(ntRets).toFixed(1)} bps  t=${tStat(ntRets).toFixed(2)}`);
  log(`  Difference:     ${(mean(trRets) - mean(ntRets)).toFixed(1)} bps`);
}
