/**
 * Backtest analysis sections D-I: quintile, alpha decay, annual, OOS,
 * adverse selection.
 */

import type { SignalResult } from "./signal.js";
import {
  type DayResult,
  type ReportCtx,
  type Logger,
  mean,
  std,
  tStat,
  pctile,
  pctOf,
} from "./backtest-report.js";

// ---------------------------------------------------------------------------
// D. Quintile analysis
// ---------------------------------------------------------------------------
export function reportQuintile(ctx: ReportCtx, log: Logger): void {
  const { results, getRet } = ctx;
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  D. Signal Range Quintile Analysis");
  log("═══════════════════════════════════════════════════════");
  log("");
  printQuintile(results, getRet, log, "");
}

// ---------------------------------------------------------------------------
// E. Quintile by sub-period
// ---------------------------------------------------------------------------
export function reportSubPeriodQuintile(ctx: ReportCtx, log: Logger): void {
  const { results, getRet } = ctx;
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  E. Quintile Analysis by Sub-Period");
  log("═══════════════════════════════════════════════════════");

  const subPeriods = [
    { name: "2010-2012", start: "2010-01-01", end: "2012-12-31" },
    { name: "2013-2014", start: "2013-01-01", end: "2014-12-31" },
    { name: "2015-2017", start: "2015-01-01", end: "2017-12-31" },
    { name: "2018-2020", start: "2018-01-01", end: "2020-12-31" },
    { name: "2021-2023", start: "2021-01-01", end: "2023-12-31" },
    { name: "2024-2025", start: "2024-01-01", end: "2025-12-31" },
  ];

  for (const sp of subPeriods) {
    const spData = results.filter((r) => r.date >= sp.start && r.date <= sp.end);
    if (spData.length < 50) continue;
    log(`\n  --- ${sp.name} (N=${spData.length}) ---`);
    printQuintile(spData, getRet, log, "  ");
  }
}

function printQuintile(
  data: DayResult[], getRet: (r: DayResult) => number, log: Logger, indent: string,
): void {
  const sorted = [...data].sort((a, b) => a.signalRange - b.signalRange);
  const qs = Math.floor(sorted.length / 5);
  log(`${indent}Quintile | N   | Avg α(bps) | t-stat | Avg Range`);
  log(`${indent}---------|-----|------------|--------|----------`);
  const qMeans: number[] = [];
  for (let q = 0; q < 5; q++) {
    const s = q * qs;
    const e = q === 4 ? sorted.length : (q + 1) * qs;
    const slice = sorted.slice(s, e);
    const rets = slice.map((r) => getRet(r));
    const ranges = slice.map((r) => r.signalRange);
    qMeans.push(mean(rets));
    log(`${indent}  Q${q + 1}     | ${String(slice.length).padStart(3)} | ${mean(rets).toFixed(1).padStart(10)} | ${tStat(rets).toFixed(2).padStart(6)} | ${mean(ranges).toFixed(4)}`);
  }
  const mono = qMeans[4] > qMeans[3] && qMeans[3] > qMeans[1] && qMeans[4] > qMeans[0];
  log(`${indent}Monotonic (Q5 > Q1): ${qMeans[4].toFixed(1)} vs ${qMeans[0].toFixed(1)} → ${mono ? "YES" : "NO"}`);
}

// ---------------------------------------------------------------------------
// F. Alpha decay
// ---------------------------------------------------------------------------
export function reportAlphaDecay(
  ctx: ReportCtx,
  signals: SignalResult[],
  dates: string[],
  matrix: number[][],
  tickers: string[],
  getFuture: (dates: string[], matrix: number[][], tickers: string[], date: string, day: number) => Record<string, number> | null,
  log: Logger,
): void {
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  F. Alpha Decay (Day 1-10 CC Returns)");
  log("═══════════════════════════════════════════════════════");
  log("");
  log("Day | Avg CC(bps) | t-stat | Cum α(bps)");
  log("----|-------------|--------|----------");

  let cumAlpha = 0;
  for (let day = 1; day <= 10; day++) {
    const dayRets: number[] = [];
    for (const sig of signals) {
      const ret = getFuture(dates, matrix, tickers, sig.date, day);
      if (!ret) continue;
      const lr = sig.longCandidates.reduce((s, t) => s + (ret[t] ?? 0), 0) / sig.longCandidates.length;
      const sr = sig.shortCandidates.reduce((s, t) => s + (ret[t] ?? 0), 0) / sig.shortCandidates.length;
      dayRets.push((lr - sr) * 10000);
    }
    if (dayRets.length === 0) continue;
    const avg = mean(dayRets);
    cumAlpha += avg;
    log(` ${String(day).padStart(2)}  | ${avg.toFixed(1).padStart(11)} | ${tStat(dayRets).toFixed(2).padStart(6)} | ${cumAlpha.toFixed(1).padStart(9)}`);
  }
}

// ---------------------------------------------------------------------------
// G. Annual performance + OC/CC ratio
// ---------------------------------------------------------------------------
export function reportAnnual(ctx: ReportCtx, log: Logger): void {
  const { results, pct, pctLow, retLabel, getRet, ocAvailable, annualFactor } = ctx;
  log("");
  log("═══════════════════════════════════════════════════════");
  log(`  G. Annual Performance (Dual-Band P${pctLow}/P${pct}, Gross, ${retLabel})`);
  log("═══════════════════════════════════════════════════════");
  log("");

  const hdr = ocAvailable
    ? "Year | Trade Days | Avg α(bps) |  AR(%)  | Win Rate | OC/CC Ratio"
    : "Year | Trade Days | Avg α(bps) |  AR(%)  | Win Rate";
  const sep = ocAvailable
    ? "-----|------------|------------|---------|----------|------------"
    : "-----|------------|------------|---------|--------";
  log(hdr);
  log(sep);

  const years = [...new Set(results.map((r) => r.date.slice(0, 4)))].sort();
  for (const year of years) {
    const yr = results.filter((r) => r.date.startsWith(year));
    const trades = yr.filter((r) => r.isTradeDay);
    const trRets = trades.map((r) => getRet(r));
    const ar = mean(yr.map((r) => r.isTradeDay ? getRet(r) : 0)) * annualFactor / 10000 * 100;
    const winR = trRets.length > 0 ? trRets.filter((r) => r > 0).length / trRets.length * 100 : 0;

    let extra = "";
    if (ocAvailable) {
      const ocM = mean(trades.map((r) => r.nextDayReturnOC).filter((v) => !isNaN(v)));
      const ccM = mean(trades.map((r) => r.nextDayReturnCC));
      const ratio = ccM !== 0 ? ocM / ccM : NaN;
      extra = ` | ${isNaN(ratio) ? "   N/A" : ratio.toFixed(3).padStart(6)}`;
    }
    log(`${year} | ${String(trades.length).padStart(10)} | ${mean(trRets).toFixed(1).padStart(10)} | ${ar.toFixed(1).padStart(6)}  | ${winR.toFixed(0).padStart(5)}%  ${extra}`);
  }

  if (ocAvailable) {
    const allTr = results.filter((r) => r.isTradeDay);
    const ocM = mean(allTr.map((r) => r.nextDayReturnOC).filter((v) => !isNaN(v)));
    const ccM = mean(allTr.map((r) => r.nextDayReturnCC));
    const ratio = ccM !== 0 ? ocM / ccM : NaN;
    log("");
    log(`  Overall OC/CC ratio: ${isNaN(ratio) ? "N/A" : ratio.toFixed(3)}`);
  }
}

// ---------------------------------------------------------------------------
// H. OOS test
// ---------------------------------------------------------------------------
export function reportOOS(ctx: ReportCtx, log: Logger): void {
  const { results, pct, getRet, annualFactor } = ctx;
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  H. Out-of-Sample Test (2015-2019 → 2020-2025)");
  log("═══════════════════════════════════════════════════════");
  log("");

  const isRes = results.filter((r) => r.date < "2020-01-01");
  const oosRes = results.filter((r) => r.date >= "2020-01-01");
  const threshold = pctile(isRes.map((r) => r.signalRange), pct);

  const oosTrades = oosRes.filter((r) => r.signalRange >= threshold);
  const oosTradeRets = oosTrades.map((r) => getRet(r));
  const oosStratRets = oosRes.map((r) => r.signalRange >= threshold ? getRet(r) : 0);

  log(`  IS threshold (P${pct} from 2015-2019): ${threshold.toFixed(4)}`);
  log(`  OOS trade days: ${oosTrades.length} / ${oosRes.length} (${pctOf(oosTrades.length, oosRes.length)})`);
  log(`  OOS trade day avg α: ${mean(oosTradeRets).toFixed(1)} bps (t=${tStat(oosTradeRets).toFixed(2)})`);
  log(`  OOS strategy AR (gross): ${(mean(oosStratRets) * annualFactor / 10000 * 100).toFixed(1)}%`);
  log(`  OOS all-day AR (gross):  ${(mean(oosRes.map((r) => getRet(r))) * annualFactor / 10000 * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// I. Adverse selection verification (§15.1)
// ---------------------------------------------------------------------------
export function reportAdverseSelection(ctx: ReportCtx, log: Logger): void {
  const { results, pct, getRet } = ctx;
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  I. Adverse Selection Verification (§15.1)");
  log("═══════════════════════════════════════════════════════");
  log("");

  const allAbs = results.map((r) => Math.abs(getRet(r)));
  const highAbs = results.filter((r) => r.band === "high").map((r) => Math.abs(getRet(r)));
  const tradeAbs = results.filter((r) => r.isTradeDay).map((r) => Math.abs(getRet(r)));

  const allM = mean(allAbs);
  const highM = mean(highAbs);
  const tradeM = mean(tradeAbs);

  const ratioHigh = allM !== 0 ? highM / allM : NaN;
  const ratioTrade = allM !== 0 ? tradeM / allM : NaN;
  const tHigh = welchT(highAbs, allAbs);
  const tTrade = welchT(tradeAbs, allAbs);

  log("  Proxy: |return| as CS spread estimator");
  log("");
  log(`  All days mean |ret|:       ${allM.toFixed(2)} bps  (N=${allAbs.length})`);
  log(`  High band (P${pct}+) mean:   ${highM.toFixed(2)} bps  (N=${highAbs.length})`);
  log(`  Trade days mean:          ${tradeM.toFixed(2)} bps  (N=${tradeAbs.length})`);
  log("");
  log(`  High/All ratio: ${isNaN(ratioHigh) ? "N/A" : ratioHigh.toFixed(3)}  (t=${tHigh.toFixed(2)})`);
  log(`  Trade/All ratio: ${isNaN(ratioTrade) ? "N/A" : ratioTrade.toFixed(3)}  (t=${tTrade.toFixed(2)})`);
  log(`  Target: ~0.995 (no adverse selection)`);
}

function welchT(a: number[], b: number[]): number {
  if (a.length <= 1 || b.length <= 1) return 0;
  const va = std(a) ** 2;
  const vb = std(b) ** 2;
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se > 0 ? (mean(a) - mean(b)) / se : 0;
}
