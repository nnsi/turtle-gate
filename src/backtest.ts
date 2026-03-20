#!/usr/bin/env tsx
/**
 * Backtest script for PCA_SUB signal strategy.
 *
 * Evaluates:
 *  - Gross / net returns at multiple cost levels (req 15.1)
 *  - Confidence filter quintile analysis by sub-period (req 15.1, appendix D)
 *  - Day-by-day alpha decay (req 15.1, appendix C)
 *  - Breakeven spread calculation
 *  - Drawdown analysis
 *  - Sub-period stability
 *
 * Usage:
 *   npx tsx src/backtest.ts --csv data/closes.csv [--percentile 90]
 */

import { loadClosesFromCsv, loadOpensFromCsv, buildReturnMatrix, buildOCReturnMatrix } from "./data.js";
import {
  generateSignals,
  applyConfidenceFilter,
  type SignalResult,
  type ConfidenceResult,
} from "./signal.js";
import { correlationMatrix } from "./linalg.js";
import { DEFAULT_PARAMS, JP_SECTOR_NAMES, US_TICKERS, JP_TICKERS, CFULL_START, CFULL_END } from "./config.js";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let csv = "data/closes.csv";
  let opensCsv = "data/opens.csv";
  let percentile = DEFAULT_PARAMS.confidencePercentile;
  let output = "output/backtest";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--csv": csv = args[++i]; break;
      case "--opens": opensCsv = args[++i]; break;
      case "--percentile": percentile = Number(args[++i]); break;
      case "--output": output = args[++i]; break;
    }
  }
  return { csv, opensCsv, percentile, output };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get next-day CC (close-to-close) returns for tickers. */
function getNextDayReturns(
  dates: string[],
  matrix: number[][],
  tickers: string[],
  signalDate: string,
): Record<string, number> | null {
  const idx = dates.indexOf(signalDate);
  if (idx < 0 || idx + 1 >= dates.length) return null;

  const nextRow = matrix[idx + 1];
  const result: Record<string, number> = {};
  for (let i = 0; i < tickers.length; i++) {
    result[tickers[i]] = nextRow[i];
  }
  return result;
}

/** Get next-day OC (open-to-close) returns for JP tickers (paper eq. 2). */
function getNextDayOCReturns(
  ccDates: string[],
  ocDates: string[],
  ocMatrix: number[][],
  ocTickers: string[],
  signalDate: string,
): Record<string, number> | null {
  // Signal date is in CC dates. We need the next CC date's OC return.
  const idx = ccDates.indexOf(signalDate);
  if (idx < 0 || idx + 1 >= ccDates.length) return null;
  const nextDate = ccDates[idx + 1];

  // Find this date in OC matrix
  const ocIdx = ocDates.indexOf(nextDate);
  if (ocIdx < 0) return null;

  const row = ocMatrix[ocIdx];
  const result: Record<string, number> = {};
  for (let i = 0; i < ocTickers.length; i++) {
    result[ocTickers[i]] = row[i];
  }
  return result;
}

/** Get returns N days after signal date. */
function getFutureDayReturn(
  dates: string[],
  matrix: number[][],
  tickers: string[],
  signalDate: string,
  daysAhead: number,
): Record<string, number> | null {
  const idx = dates.indexOf(signalDate);
  if (idx < 0 || idx + daysAhead >= dates.length) return null;

  const row = matrix[idx + daysAhead];
  const result: Record<string, number> = {};
  for (let i = 0; i < tickers.length; i++) {
    result[tickers[i]] = row[i];
  }
  return result;
}

/** Compute long-short portfolio return for a single day. */
function portfolioReturn(
  dayReturns: Record<string, number>,
  longCandidates: string[],
  shortCandidates: string[],
): number {
  const longRet = longCandidates.reduce((s, t) => s + (dayReturns[t] ?? 0), 0) / longCandidates.length;
  const shortRet = shortCandidates.reduce((s, t) => s + (dayReturns[t] ?? 0), 0) / shortCandidates.length;
  return longRet - shortRet; // long - short
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function maxDrawdown(cumReturns: number[]): number {
  let peak = 0;
  let mdd = 0;
  for (const cr of cumReturns) {
    if (cr > peak) peak = cr;
    const dd = cr - peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

function tStat(arr: number[]): number {
  if (arr.length <= 1) return 0;
  return mean(arr) / (std(arr) / Math.sqrt(arr.length));
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Main backtest
// ---------------------------------------------------------------------------
async function main() {
  const { csv, opensCsv, percentile: pct, output } = parseArgs();

  console.log("=== PCA_SUB Backtest ===");
  console.log(`Data: ${csv}, Opens: ${opensCsv}`);
  console.log(`Params: L=${DEFAULT_PARAMS.L}, K=${DEFAULT_PARAMS.K}, λ=${DEFAULT_PARAMS.lambda}, q=${DEFAULT_PARAMS.q}`);
  console.log(`Confidence: P${pct}`);
  console.log("");

  // 1. Load data
  const prices = loadClosesFromCsv(csv);
  const allTickers = [...US_TICKERS, ...JP_TICKERS] as unknown as string[];
  const activeTickers = allTickers.filter((t) => prices.some((p) => p.ticker === t));

  // Compute returns manually
  const byTicker = new Map<string, { date: string; close: number }[]>();
  for (const p of prices) {
    const arr = byTicker.get(p.ticker) ?? [];
    arr.push({ date: p.date, close: p.close });
    byTicker.set(p.ticker, arr);
  }

  const returns: { date: string; ticker: string; ret: number }[] = [];
  for (const [ticker, arr] of byTicker) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < arr.length; i++) {
      returns.push({ date: arr[i].date, ticker, ret: Math.log(arr[i].close / arr[i - 1].close) });
    }
  }

  const { dates, tickers, matrix } = buildReturnMatrix(returns, activeTickers);
  console.log(`Aligned: ${dates.length} dates × ${tickers.length} tickers`);

  // JP tickers only (for return calculation)
  const jpTickers = tickers.filter((t) => !(US_TICKERS as readonly string[]).includes(t));
  const jpIndices = jpTickers.map((t) => tickers.indexOf(t));

  // Load OC return data for JP tickers (paper eq. 2: r_oc = close/open - 1)
  let ocDates: string[] = [];
  let ocTickers: string[] = [];
  let ocMatrix: number[][] = [];
  let hasOC = false;

  if (fs.existsSync(opensCsv)) {
    const openPrices = loadOpensFromCsv(opensCsv);
    const closePrices = loadClosesFromCsv(csv);
    const ocResult = buildOCReturnMatrix(closePrices, openPrices, jpTickers);
    ocDates = ocResult.dates;
    ocTickers = ocResult.tickers;
    ocMatrix = ocResult.matrix;
    hasOC = ocDates.length > 0;
    console.log(`OC returns: ${ocDates.length} dates × ${ocTickers.length} JP tickers`);
  } else {
    console.log("WARNING: opens.csv not found, falling back to CC-only evaluation");
  }

  // Estimate Cfull from long-term data (§8.2.1)
  const cfullRows = matrix.filter((_, i) => dates[i] >= CFULL_START && dates[i] <= CFULL_END);
  const cfullData = cfullRows.length >= 60 ? cfullRows : matrix;
  const Cfull = correlationMatrix(cfullData);
  console.log(`Cfull estimated from ${cfullData.length} rows`);

  // 2. Generate signals
  console.log("Generating signals...");
  const signals = generateSignals(dates, matrix, tickers, DEFAULT_PARAMS, Cfull);
  console.log(`Signal dates: ${signals.length}`);

  // 3. Confidence filter
  const confidence = applyConfidenceFilter(signals, pct);

  // 4. Compute daily L/S returns for ALL signal dates
  interface DayResult {
    date: string;
    signal: SignalResult;
    confidence: ConfidenceResult;
    nextDayReturnCC: number;      // gross L/S CC return (bps)
    nextDayReturnOC: number;      // gross L/S OC return (bps), NaN if unavailable
    turnover: number;             // 2 if trade, 0 if not
  }

  const results: DayResult[] = [];

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const conf = confidence[i];

    // Next-day CC returns
    const nextRetCC = getNextDayReturns(dates, matrix, tickers, sig.date);
    if (!nextRetCC) continue;

    const retCC = portfolioReturn(nextRetCC, sig.longCandidates, sig.shortCandidates);

    // Next-day OC returns (paper eq. 2)
    let retOC = NaN;
    if (hasOC) {
      const nextRetOC = getNextDayOCReturns(dates, ocDates, ocMatrix, ocTickers, sig.date);
      if (nextRetOC) {
        retOC = portfolioReturn(nextRetOC, sig.longCandidates, sig.shortCandidates);
      }
    }

    results.push({
      date: sig.date,
      signal: sig,
      confidence: conf,
      nextDayReturnCC: retCC * 10000,  // convert to bps
      nextDayReturnOC: retOC * 10000,  // convert to bps (NaN if no open data)
      turnover: conf.isTradeDay ? 2 : 0,  // L+S = 200% when trading
    });
  }

  console.log(`Backtest days: ${results.length}`);
  console.log("");

  // =========================================================================
  // ANALYSIS
  // =========================================================================
  const out: string[] = [];
  const log = (s: string) => { console.log(s); out.push(s); };

  // Helper: primary return (OC if available, CC fallback)
  const ocAvailable = hasOC && results.some((r) => !isNaN(r.nextDayReturnOC));
  const retLabel = ocAvailable ? "OC" : "CC";
  const getRet = (r: DayResult) => ocAvailable && !isNaN(r.nextDayReturnOC) ? r.nextDayReturnOC : r.nextDayReturnCC;

  // --- A. Overall strategy performance ---
  log("═══════════════════════════════════════════════════════");
  log(`  A. Strategy Performance (Conv P${pct}, ${retLabel}-based)`);
  log("═══════════════════════════════════════════════════════");

  const tradeDays = results.filter((r) => r.confidence.isTradeDay);
  const nonTradeDays = results.filter((r) => !r.confidence.isTradeDay);

  // Strategy: earn L/S return on trade days, 0 on non-trade days
  const stratReturns = results.map((r) => r.confidence.isTradeDay ? getRet(r) : 0);
  const allDayReturns = results.map((r) => getRet(r));
  const tradeDayReturns = tradeDays.map((r) => getRet(r));

  const avgTO = mean(results.map((r) => r.turnover));
  const annualFactor = 250;

  log("");
  log(`Total signal dates:  ${results.length}`);
  log(`Trade days (P${pct}):  ${tradeDays.length} (${((tradeDays.length / results.length) * 100).toFixed(1)}%)`);
  log(`Avg daily turnover:  ${avgTO.toFixed(3)}`);
  log("");

  const costLevels = [0, 3, 5, 8, 10, 15]; // one-way bps
  log(`Cost (1-way bps) |  AR(%)  | Risk(%) |  R/R  | MDD(%)  | BE(bps)   [${retLabel}]`);
  log("-----------------|---------|---------|-------|---------|--------");

  for (const cost of costLevels) {
    // Net return = gross - turnover * cost
    const netReturns = results.map((r) =>
      r.confidence.isTradeDay ? getRet(r) - r.turnover * cost : 0
    );
    const dailyMean = mean(netReturns);
    const dailyStd = std(netReturns);
    const ar = dailyMean * annualFactor / 10000 * 100;
    const risk = dailyStd * Math.sqrt(annualFactor) / 10000 * 100;
    const rr = risk > 0 ? ar / risk : 0;

    // Cumulative for MDD
    let cum = 0;
    const cumArr = netReturns.map((r) => { cum += r / 10000; return cum; });
    const mdd = maxDrawdown(cumArr) * 100;

    if (cost === 0) {
      // Calculate breakeven spread
      const grossMean = mean(stratReturns);
      const be = avgTO > 0 ? grossMean / avgTO : Infinity;
      log(`       ${String(cost).padStart(2)}        | ${ar.toFixed(1).padStart(6)}  | ${risk.toFixed(1).padStart(6)}  | ${rr.toFixed(2).padStart(5)} | ${mdd.toFixed(1).padStart(6)}  | ${be.toFixed(1).padStart(6)}`);
    } else {
      log(`       ${String(cost).padStart(2)}        | ${ar.toFixed(1).padStart(6)}  | ${risk.toFixed(1).padStart(6)}  | ${rr.toFixed(2).padStart(5)} | ${mdd.toFixed(1).padStart(6)}  |`);
    }
  }

  // CC reference (if OC is primary)
  if (ocAvailable) {
    log("");
    log("  [CC reference]");
    const ccStratReturns = results.map((r) => r.confidence.isTradeDay ? r.nextDayReturnCC : 0);
    const ccMean = mean(ccStratReturns);
    const ccStd = std(ccStratReturns);
    const ccAR = ccMean * annualFactor / 10000 * 100;
    const ccRisk = ccStd * Math.sqrt(annualFactor) / 10000 * 100;
    const ccRR = ccRisk > 0 ? ccAR / ccRisk : 0;
    let ccCum = 0;
    const ccCumArr = ccStratReturns.map((r) => { ccCum += r / 10000; return ccCum; });
    const ccMDD = maxDrawdown(ccCumArr) * 100;
    log(`  CC Gross:  AR=${ccAR.toFixed(1)}%  Risk=${ccRisk.toFixed(1)}%  R/R=${ccRR.toFixed(2)}  MDD=${ccMDD.toFixed(1)}%`);
    const ocMean = mean(stratReturns);
    const ratio = ccMean !== 0 ? ocMean / ccMean : 0;
    log(`  OC/CC ratio: ${ratio.toFixed(3)}`);
  }

  // --- B. All-day strategy (no filter, daily rebalance) ---
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  B. Daily Rebalance (No Filter) - Reference");
  log("═══════════════════════════════════════════════════════");
  log("");

  const allDailyMean = mean(allDayReturns);
  const allDailyStd = std(allDayReturns);
  const allAR = allDailyMean * annualFactor / 10000 * 100;
  const allRisk = allDailyStd * Math.sqrt(annualFactor) / 10000 * 100;
  const allRR = allRisk > 0 ? allAR / allRisk : 0;
  const allBE = allDailyMean / 2; // TO=2 every day
  let allCum = 0;
  const allCumArr = allDayReturns.map((r) => { allCum += r / 10000; return allCum; });
  const allMDD = maxDrawdown(allCumArr) * 100;

  log(`  [${retLabel}] AR: ${allAR.toFixed(1)}%  Risk: ${allRisk.toFixed(1)}%  R/R: ${allRR.toFixed(2)}  MDD: ${allMDD.toFixed(1)}%  BE: ${allBE.toFixed(1)} bps`);
  log(`  Avg daily α: ${allDailyMean.toFixed(1)} bps  t-stat: ${tStat(allDayReturns).toFixed(2)}`);

  // --- C. Trade day vs Non-trade day ---
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  C. Trade Day vs Non-Trade Day Returns");
  log("═══════════════════════════════════════════════════════");
  log("");

  const nonTradeReturns = nonTradeDays.map((r) => getRet(r));
  log(`  [${retLabel}]`);
  log(`  Trade days:     N=${tradeDayReturns.length}  avg=${mean(tradeDayReturns).toFixed(1)} bps  t=${tStat(tradeDayReturns).toFixed(2)}`);
  log(`  Non-trade days: N=${nonTradeReturns.length}  avg=${mean(nonTradeReturns).toFixed(1)} bps  t=${tStat(nonTradeReturns).toFixed(2)}`);
  log(`  Difference:     ${(mean(tradeDayReturns) - mean(nonTradeReturns)).toFixed(1)} bps`);

  // --- D. Quintile analysis ---
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  D. Signal Range Quintile Analysis");
  log("═══════════════════════════════════════════════════════");
  log("");

  // Sort by signal range, divide into quintiles
  const sortedByRange = [...results].sort((a, b) => a.signal.signalRange - b.signal.signalRange);
  const qSize = Math.floor(sortedByRange.length / 5);

  log("Quintile | N   | Avg α(bps) | t-stat | Avg Range");
  log("---------|-----|------------|--------|----------");
  for (let q = 0; q < 5; q++) {
    const start = q * qSize;
    const end = q === 4 ? sortedByRange.length : (q + 1) * qSize;
    const slice = sortedByRange.slice(start, end);
    const rets = slice.map((r) => getRet(r));
    const ranges = slice.map((r) => r.signal.signalRange);
    log(`  Q${q + 1}     | ${String(slice.length).padStart(3)} | ${mean(rets).toFixed(1).padStart(10)} | ${tStat(rets).toFixed(2).padStart(6)} | ${mean(ranges).toFixed(4)}`);
  }

  // --- E. Quintile by sub-period ---
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  E. Quintile Analysis by Sub-Period");
  log("═══════════════════════════════════════════════════════");

  const subPeriods = [
    { name: "2015-2017", start: "2015-01-01", end: "2017-12-31" },
    { name: "2018-2020", start: "2018-01-01", end: "2020-12-31" },
    { name: "2021-2023", start: "2021-01-01", end: "2023-12-31" },
    { name: "2024-2025", start: "2024-01-01", end: "2025-12-31" },
  ];

  for (const sp of subPeriods) {
    const spResults = results.filter((r) => r.date >= sp.start && r.date <= sp.end);
    if (spResults.length < 50) continue;

    log(`\n  --- ${sp.name} (N=${spResults.length}) ---`);

    const sorted = [...spResults].sort((a, b) => a.signal.signalRange - b.signal.signalRange);
    const qs = Math.floor(sorted.length / 5);
    log("  Quintile | N   | Avg α(bps) | t-stat");
    log("  ---------|-----|------------|-------");
    for (let q = 0; q < 5; q++) {
      const start = q * qs;
      const end = q === 4 ? sorted.length : (q + 1) * qs;
      const slice = sorted.slice(start, end);
      const rets = slice.map((r) => getRet(r));
      log(`    Q${q + 1}     | ${String(slice.length).padStart(3)} | ${mean(rets).toFixed(1).padStart(10)} | ${tStat(rets).toFixed(2).padStart(6)}`);
    }

    // Monotonicity check
    const qMeans: number[] = [];
    for (let q = 0; q < 5; q++) {
      const start = q * qs;
      const end = q === 4 ? sorted.length : (q + 1) * qs;
      qMeans.push(mean(sorted.slice(start, end).map((r) => getRet(r))));
    }
    const isMonotonic = qMeans[4] > qMeans[3] && qMeans[3] > qMeans[1] && qMeans[4] > qMeans[0];
    log(`  Monotonic (Q5 > Q1): ${qMeans[4].toFixed(1)} vs ${qMeans[0].toFixed(1)} → ${isMonotonic ? "YES" : "NO"}`);
  }

  // --- F. Alpha decay analysis ---
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
      const ret = getFutureDayReturn(dates, matrix, tickers, sig.date, day);
      if (!ret) continue;
      dayRets.push(portfolioReturn(ret, sig.longCandidates, sig.shortCandidates) * 10000);
    }
    if (dayRets.length === 0) continue;
    const avg = mean(dayRets);
    cumAlpha += avg;
    log(` ${String(day).padStart(2)}  | ${avg.toFixed(1).padStart(11)} | ${tStat(dayRets).toFixed(2).padStart(6)} | ${cumAlpha.toFixed(1).padStart(9)}`);
  }

  // --- G. Annual breakdown ---
  log("");
  log("═══════════════════════════════════════════════════════");
  log(`  G. Annual Performance (Conv P${pct}, Gross, ${retLabel})`);
  log("═══════════════════════════════════════════════════════");
  log("");
  log("Year | Trade Days | Avg α(bps) |  AR(%)  | Win Rate");
  log("-----|------------|------------|---------|--------");

  const years = [...new Set(results.map((r) => r.date.slice(0, 4)))].sort();
  for (const year of years) {
    const yearResults = results.filter((r) => r.date.startsWith(year));
    const yearTrades = yearResults.filter((r) => r.confidence.isTradeDay);
    const yearTradeRets = yearTrades.map((r) => getRet(r));
    const yearStratRets = yearResults.map((r) => r.confidence.isTradeDay ? getRet(r) : 0);

    const yearAR = mean(yearStratRets) * annualFactor / 10000 * 100;
    const winRate = yearTradeRets.length > 0
      ? (yearTradeRets.filter((r) => r > 0).length / yearTradeRets.length * 100)
      : 0;

    log(`${year} | ${String(yearTrades.length).padStart(10)} | ${mean(yearTradeRets).toFixed(1).padStart(10)} | ${yearAR.toFixed(1).padStart(6)}  | ${winRate.toFixed(0).padStart(5)}%`);
  }

  // --- H. OOS test ---
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  H. Out-of-Sample Test (2015-2019 → 2020-2025)");
  log("═══════════════════════════════════════════════════════");
  log("");

  const isResults = results.filter((r) => r.date < "2020-01-01");
  const oosResults = results.filter((r) => r.date >= "2020-01-01");

  // Compute IS threshold
  const isRanges = isResults.map((r) => r.signal.signalRange);
  const isThreshold = percentile(isRanges, pct);

  // Apply IS threshold to OOS
  const oosTrades = oosResults.filter((r) => r.signal.signalRange >= isThreshold);
  const oosTradeRets = oosTrades.map((r) => getRet(r));
  const oosAllRets = oosResults.map((r) => getRet(r));
  const oosStratRets = oosResults.map((r) => r.signal.signalRange >= isThreshold ? getRet(r) : 0);

  const oosAvgTO = oosTrades.length * 2 / oosResults.length;
  const oosStratAR = mean(oosStratRets) * annualFactor / 10000 * 100;
  const oosAllAR = mean(oosAllRets) * annualFactor / 10000 * 100;

  log(`  IS threshold (P${pct} from 2015-2019): ${isThreshold.toFixed(4)}`);
  log(`  OOS trade days: ${oosTrades.length} / ${oosResults.length} (${(oosTrades.length / oosResults.length * 100).toFixed(1)}%)`);
  log(`  OOS trade day avg α: ${mean(oosTradeRets).toFixed(1)} bps (t=${tStat(oosTradeRets).toFixed(2)})`);
  log(`  OOS strategy AR (gross): ${oosStratAR.toFixed(1)}%`);
  log(`  OOS all-day AR (gross):  ${oosAllAR.toFixed(1)}%`);

  // Save report
  fs.mkdirSync(output, { recursive: true });
  const reportPath = `${output}/backtest-report.txt`;
  fs.writeFileSync(reportPath, out.join("\n"));
  log("");
  log(`Report saved: ${reportPath}`);

  // Save daily results as JSON
  const jsonPath = `${output}/backtest-daily.json`;
  const jsonData = results.map((r) => ({
    date: r.date,
    signalRange: r.signal.signalRange,
    isTradeDay: r.confidence.isTradeDay,
    threshold: r.confidence.threshold,
    grossReturnOCBps: getRet(r),
    grossReturnCCBps: r.nextDayReturnCC,
    longCandidates: r.signal.longCandidates,
    shortCandidates: r.signal.shortCandidates,
  }));
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  log(`Daily results: ${jsonPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
