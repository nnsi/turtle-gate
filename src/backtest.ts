#!/usr/bin/env tsx
/**
 * Backtest script for PCA_SUB signal strategy.
 *
 * Evaluates dual-band confidence filter (§8.3.3), adverse selection (§15.1),
 * and annual OC/CC stability. Report generation delegated to backtest-report.ts.
 *
 * Usage:
 *   npx tsx src/backtest.ts --csv data/closes.csv [--percentile 90]
 */

import { loadClosesFromCsv, loadOpensFromCsv, buildReturnMatrix, buildOCReturnMatrix } from "./data.js";
import { generateSignals, applyDualBandFilter } from "./signal.js";
import { correlationMatrix } from "./linalg.js";
import { DEFAULT_PARAMS, US_TICKERS, JP_TICKERS, CFULL_START, CFULL_END } from "./config.js";
import * as fs from "node:fs";
import {
  type DayResult,
  type ReportCtx,
  reportStrategyPerformance,
  reportCCReference,
  reportDailyRebalance,
  reportTradeVsNonTrade,
} from "./backtest-report.js";
import {
  reportQuintile,
  reportSubPeriodQuintile,
  reportAlphaDecay,
  reportAnnual,
  reportOOS,
  reportAdverseSelection,
} from "./backtest-analysis.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let csv = "data/closes.csv";
  let opensCsv = "data/opens.csv";
  let percentile = DEFAULT_PARAMS.confidencePercentile;
  let percentileLow = DEFAULT_PARAMS.confidencePercentileLow;
  let output = "output/backtest";
  let start = "";
  const exclude: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--csv": csv = args[++i]; break;
      case "--opens": opensCsv = args[++i]; break;
      case "--percentile": percentile = Number(args[++i]); break;
      case "--percentile-low": percentileLow = Number(args[++i]); break;
      case "--output": output = args[++i]; break;
      case "--start": start = args[++i]; break;
      case "--exclude": exclude.push(...args[++i].split(",")); break;
    }
  }
  return { csv, opensCsv, percentile, percentileLow, output, start, exclude };
}

/** Get ticker→return map for a date offset from signalDate. */
function getReturnMap(
  dates: string[], matrix: number[][], tickers: string[],
  signalDate: string, daysAhead: number = 1,
): Record<string, number> | null {
  const idx = dates.indexOf(signalDate);
  if (idx < 0 || idx + daysAhead >= dates.length) return null;
  const row = matrix[idx + daysAhead];
  const result: Record<string, number> = {};
  for (let i = 0; i < tickers.length; i++) result[tickers[i]] = row[i];
  return result;
}

function getNextDayOCReturns(
  ccDates: string[], ocDates: string[], ocMatrix: number[][],
  ocTickers: string[], signalDate: string,
): Record<string, number> | null {
  const idx = ccDates.indexOf(signalDate);
  if (idx < 0 || idx + 1 >= ccDates.length) return null;
  const ocIdx = ocDates.indexOf(ccDates[idx + 1]);
  if (ocIdx < 0) return null;
  const row = ocMatrix[ocIdx];
  const result: Record<string, number> = {};
  for (let i = 0; i < ocTickers.length; i++) result[ocTickers[i]] = row[i];
  return result;
}

function portfolioReturn(
  dayReturns: Record<string, number>, longs: string[], shorts: string[],
): number {
  const lr = longs.reduce((s, t) => s + (dayReturns[t] ?? 0), 0) / longs.length;
  const sr = shorts.reduce((s, t) => s + (dayReturns[t] ?? 0), 0) / shorts.length;
  return lr - sr;
}

async function main() {
  const { csv, opensCsv, percentile: pct, percentileLow: pctLow, output, start, exclude } = parseArgs();

  const P = DEFAULT_PARAMS;
  console.log(`=== PCA_SUB Backtest === Data: ${csv}, Opens: ${opensCsv}`);
  if (start) console.log(`Start filter: ${start}`);
  if (exclude.length) console.log(`Excluded tickers: ${exclude.join(", ")}`);
  console.log(`Params: L=${P.L}, K=${P.K}, λ=${P.lambda}, q=${P.q}  Confidence: P${pctLow}/P${pct}\n`);

  // 1. Load data
  let prices = loadClosesFromCsv(csv);
  if (start) prices = prices.filter((p) => p.date >= start);
  const allTickers = [...US_TICKERS, ...JP_TICKERS] as unknown as string[];
  const activeTickers = allTickers.filter((t) =>
    !exclude.includes(t) && prices.some((p) => p.ticker === t),
  );

  const byTicker = new Map<string, { date: string; close: number }[]>();
  for (const p of prices) {
    const arr = byTicker.get(p.ticker) ?? [];
    arr.push({ date: p.date, close: p.close });
    byTicker.set(p.ticker, arr);
  }
  const returns: { date: string; ticker: string; ret: number }[] = [];
  for (const [ticker, arr] of byTicker) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < arr.length; i++)
      returns.push({ date: arr[i].date, ticker, ret: Math.log(arr[i].close / arr[i - 1].close) });
  }

  const { dates, tickers, matrix } = buildReturnMatrix(returns, activeTickers);
  console.log(`Aligned: ${dates.length} dates × ${tickers.length} tickers`);

  const jpTickers = tickers.filter((t) => !(US_TICKERS as readonly string[]).includes(t));

  // Load OC returns
  let ocDates: string[] = [], ocTickers: string[] = [], ocMatrix: number[][] = [], hasOC = false;
  if (fs.existsSync(opensCsv)) {
    const oc = buildOCReturnMatrix(loadClosesFromCsv(csv), loadOpensFromCsv(opensCsv), jpTickers);
    ocDates = oc.dates; ocTickers = oc.tickers; ocMatrix = oc.matrix; hasOC = oc.dates.length > 0;
    console.log(`OC returns: ${oc.dates.length} dates × ${oc.tickers.length} JP tickers`);
  } else { console.log("WARNING: opens.csv not found, falling back to CC-only evaluation"); }

  // Cfull estimation (§8.2.1)
  const cfullRows = matrix.filter((_, i) => dates[i] >= CFULL_START && dates[i] <= CFULL_END);
  const Cfull = correlationMatrix(cfullRows.length >= 60 ? cfullRows : matrix);
  console.log(`Cfull estimated from ${(cfullRows.length >= 60 ? cfullRows : matrix).length} rows`);

  // 2. Generate signals
  console.log("Generating signals...");
  const signals = generateSignals(dates, matrix, tickers, DEFAULT_PARAMS, Cfull);
  console.log(`Signal dates: ${signals.length}`);

  // 3. Dual-band confidence filter (§8.3.3)
  const confidence = applyDualBandFilter(signals, pct, pctLow);

  // 4. Build daily results
  const results: DayResult[] = [];
  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const conf = confidence[i];
    const nextRetCC = getReturnMap(dates, matrix, tickers, sig.date);
    if (!nextRetCC) continue;

    let retOC = NaN;
    if (hasOC) {
      const nextRetOC = getNextDayOCReturns(dates, ocDates, ocMatrix, ocTickers, sig.date);
      if (nextRetOC) retOC = portfolioReturn(nextRetOC, sig.longCandidates, sig.shortCandidates);
    }

    const ccRet = portfolioReturn(nextRetCC, sig.longCandidates, sig.shortCandidates) * 10000;
    results.push({
      date: sig.date, signalRange: sig.signalRange,
      longCandidates: sig.longCandidates, shortCandidates: sig.shortCandidates,
      isTradeDay: conf.isTradeDay, band: conf.band,
      threshold: conf.threshold, thresholdHigh: conf.thresholdHigh, thresholdLow: conf.thresholdLow,
      nextDayReturnCC: ccRet, nextDayReturnOC: retOC * 10000,
      turnover: conf.isTradeDay ? 2 : 0, factorScores: sig.factorScores,
    });
  }

  console.log(`Backtest days: ${results.length}\n`);

  // 5. Report
  const out: string[] = [];
  const log = (s: string) => { console.log(s); out.push(s); };
  const ocAvailable = hasOC && results.some((r) => !isNaN(r.nextDayReturnOC));
  const retLabel = ocAvailable ? "OC" : "CC";
  const getRet = (r: DayResult) => ocAvailable && !isNaN(r.nextDayReturnOC) ? r.nextDayReturnOC : r.nextDayReturnCC;
  const ctx: ReportCtx = { results, pct, pctLow, ocAvailable, retLabel, getRet, annualFactor: 250 };

  reportStrategyPerformance(ctx, log);
  reportCCReference(ctx, log);
  reportDailyRebalance(ctx, log);
  reportTradeVsNonTrade(ctx, log);
  reportQuintile(ctx, log);
  reportSubPeriodQuintile(ctx, log);
  reportAlphaDecay(ctx, signals, dates, matrix, tickers, getReturnMap, log);
  reportAnnual(ctx, log);
  reportOOS(ctx, log);
  reportAdverseSelection(ctx, log);

  // Save
  fs.mkdirSync(output, { recursive: true });
  const reportPath = `${output}/backtest-report.txt`;
  fs.writeFileSync(reportPath, out.join("\n"));
  log("");
  log(`Report saved: ${reportPath}`);

  const jsonPath = `${output}/backtest-daily.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(results.map((r) => ({
    date: r.date, signalRange: r.signalRange, isTradeDay: r.isTradeDay, band: r.band,
    threshold: r.threshold, thresholdHigh: r.thresholdHigh, thresholdLow: r.thresholdLow,
    grossReturnOCBps: getRet(r), grossReturnCCBps: r.nextDayReturnCC,
    longCandidates: r.longCandidates, shortCandidates: r.shortCandidates,
  })), null, 2));
  log(`Daily results: ${jsonPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
