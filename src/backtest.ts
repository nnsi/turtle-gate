#!/usr/bin/env tsx
/**
 * Backtest script for PCA_SUB signal strategy.
 *
 * Evaluates dual-band confidence filter (§8.3.3), adverse selection (§15.1),
 * and annual OC/CC stability. Report generation delegated to backtest-report.ts.
 *
 * Usage:
 *   npx tsx src/backtest.ts --csv data/closes.csv [--percentile 90]
 *   npx tsx src/backtest.ts --csv data/closes.csv --basket --stocks-csv data/stocks.csv
 */

import { loadClosesFromCsv, loadOpensFromCsv, buildReturnMatrix, buildOCReturnMatrix } from "./data.js";
import { applyDualBandFilter } from "./signal.js";
import { DEFAULT_PARAMS, US_TICKERS, JP_TICKERS } from "./config.js";
import { createPcaSubProvider } from "./signal-pca-sub.js";
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
import {
  buildBasketReturnLookup, buildBasketOCReturnLookup,
  basketPortfolioReturn, type BasketReturnLookup,
  getReturnMap, getNextDayOCReturns, portfolioReturn,
} from "./backtest-basket.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let csv = "data/closes.csv";
  let opensCsv = "data/opens.csv";
  let percentile = DEFAULT_PARAMS.confidencePercentile;
  let percentileLow = DEFAULT_PARAMS.confidencePercentileLow;
  let output = "output/backtest";
  let start = "";
  let basket = false;
  let stocksCsv = "";
  let stocksOpensCsv = "";
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
      case "--basket": basket = true; break;
      case "--stocks-csv": stocksCsv = args[++i]; break;
      case "--stocks-opens": stocksOpensCsv = args[++i]; break;
    }
  }
  return { csv, opensCsv, percentile, percentileLow, output, start, exclude, basket, stocksCsv, stocksOpensCsv };
}

async function main() {
  const { csv, opensCsv, percentile: pct, percentileLow: pctLow, output, start, exclude, basket, stocksCsv, stocksOpensCsv } = parseArgs();

  const P = DEFAULT_PARAMS;
  console.log(`=== PCA_SUB Backtest === Data: ${csv}, Opens: ${opensCsv}`);
  if (basket) console.log(`Basket mode: ON (stocks: ${stocksCsv || "N/A"})`);
  if (start) console.log(`Start filter: ${start}`);
  if (exclude.length) console.log(`Excluded tickers: ${exclude.join(", ")}`);
  console.log(`Params: L=${P.L}, K=${P.K}, λ=${P.lambda}, q=${P.q}  Confidence: P${pctLow}/P${pct}\n`);

  if (basket && !stocksCsv) throw new Error("--basket requires --stocks-csv PATH");

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

  // Load basket stock data (when --basket is active)
  let basketLookup: BasketReturnLookup | null = null;
  let basketOCLookup: BasketReturnLookup | null = null;
  if (basket) {
    basketLookup = buildBasketReturnLookup(stocksCsv, start);
    if (stocksOpensCsv) {
      basketOCLookup = buildBasketOCReturnLookup(stocksCsv, stocksOpensCsv, start);
    }
  }

  // 2. Generate signals via provider (handles Cfull estimation internally)
  const provider = createPcaSubProvider();
  const { signals } = await provider.generate({ dates, matrix, tickers, params: DEFAULT_PARAMS });

  // 3. Dual-band confidence filter (§8.3.3)
  const confidence = applyDualBandFilter(signals, pct, pctLow);

  // 4. Build daily results
  const results: DayResult[] = [];
  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const conf = confidence[i];
    const nextRetCC = getReturnMap(dates, matrix, tickers, sig.date);
    if (!nextRetCC) continue;

    // Next trading date (for basket/OC return lookup)
    const sigIdx = dates.indexOf(sig.date);
    const nextDate = sigIdx >= 0 && sigIdx + 1 < dates.length ? dates[sigIdx + 1] : null;

    let retOC = NaN;
    if (basketOCLookup && nextDate) {
      // Basket OC: individual stock open-to-close returns
      retOC = basketPortfolioReturn(basketOCLookup, {}, nextDate, sig.longCandidates, sig.shortCandidates);
    } else if (hasOC) {
      const nextRetOC = getNextDayOCReturns(dates, ocDates, ocMatrix, ocTickers, sig.date);
      if (nextRetOC) retOC = portfolioReturn(nextRetOC, sig.longCandidates, sig.shortCandidates);
    }

    // CC return: use basket returns when --basket is active, else ETF returns
    const ccRet = basketLookup && nextDate
      ? basketPortfolioReturn(basketLookup, nextRetCC, nextDate, sig.longCandidates, sig.shortCandidates) * 10000
      : portfolioReturn(nextRetCC, sig.longCandidates, sig.shortCandidates) * 10000;

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
  const retLabel = basket ? (ocAvailable ? "Basket-OC" : "Basket-CC") : (ocAvailable ? "OC" : "CC");
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
