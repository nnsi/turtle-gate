/**
 * PCA_SUB signal provider (§8.2).
 *
 * Wraps the core PCA_SUB algorithm (src/signal.ts) as a SignalProvider,
 * including Cfull estimation and drift monitoring.
 */

import type { SignalProvider, SignalContext, SignalProviderOutput } from "./signal-provider.js";
import { generateSignals } from "./signal.js";
import { correlationMatrix } from "./linalg.js";
import { CFULL_START, CFULL_END } from "./config.js";
import {
  computeCfullDrift, formatDriftReport,
  type CfullDriftReport, type DailyReturnRecord,
} from "./cfull-monitor.js";
import type { SignalResult } from "./signal.js";

/**
 * Estimate Cfull from the data matrix (§8.2.1: 2010-2014 period).
 *
 * Returns the full NxN correlation matrix with NaN for tickers that were
 * unavailable during the estimation period (e.g., XLC pre-2018).
 */
export function estimateCfull(
  dates: string[], matrix: number[][], tickers: string[],
): { Cfull: number[][]; cleanCols: number[]; cfullRowCount: number } {
  const cfullRows = matrix.filter((_, i) => dates[i] >= CFULL_START && dates[i] <= CFULL_END);
  const cfullSource = cfullRows.length >= 60 ? cfullRows : matrix;
  const N = tickers.length;

  const cfullValidCols: boolean[] = new Array(N).fill(true);
  for (const row of cfullSource) {
    for (let c = 0; c < N; c++) {
      if (isNaN(row[c])) cfullValidCols[c] = false;
    }
  }

  const cleanCols = cfullValidCols.map((v, i) => v ? i : -1).filter((i) => i >= 0);
  const cleanRows = cfullSource.map((row) => cleanCols.map((c) => row[c]));
  const cleanCorr = correlationMatrix(cleanRows);

  const Cfull: number[][] = Array.from({ length: N }, () => new Array(N).fill(NaN));
  for (let i = 0; i < cleanCols.length; i++) {
    for (let j = 0; j < cleanCols.length; j++) {
      Cfull[cleanCols[i]][cleanCols[j]] = cleanCorr[i][j];
    }
  }

  return { Cfull, cleanCols, cfullRowCount: cfullSource.length };
}

/**
 * Build daily return records for Cfull drift monitoring.
 *
 * Uses realized returns from trade history where available,
 * falls back to CC returns computed from signal candidates.
 */
function buildDailyReturns(
  signals: SignalResult[],
  historyReturns: DailyReturnRecord[] | undefined,
  tickers: string[],
  dates: string[],
  matrix: number[][],
): DailyReturnRecord[] {
  const histMap = new Map(historyReturns?.map((r) => [r.date, r]) ?? []);
  const result: DailyReturnRecord[] = [];

  for (const s of signals) {
    const hist = histMap.get(s.date);
    if (hist && hist.grossReturn !== 0) {
      result.push(hist);
      continue;
    }

    // Fallback: CC return on signal day
    const dIdx = dates.indexOf(s.date);
    if (dIdx < 0) continue;
    const computeAvg = (candidates: string[]) => {
      const rets = candidates.map((t) => {
        const idx = tickers.indexOf(t);
        return idx >= 0 ? matrix[dIdx][idx] : 0;
      });
      return rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    };
    result.push({
      date: s.date,
      grossReturn: computeAvg(s.longCandidates) - computeAvg(s.shortCandidates),
      quintileRank: hist?.quintileRank,
    });
  }

  return result;
}

/** Create a PCA_SUB signal provider */
export function createPcaSubProvider(): SignalProvider {
  return {
    name: "pca_sub",

    async generate(ctx: SignalContext): Promise<SignalProviderOutput> {
      const { dates, matrix, tickers, params, historyReturns } = ctx;

      // 1. Estimate Cfull
      const { Cfull, cleanCols, cfullRowCount } = estimateCfull(dates, matrix, tickers);
      console.log(`Cfull estimated from ${cfullRowCount} rows (${cleanCols.length}/${tickers.length} clean tickers)\n`);

      // 2. Generate signals
      console.log("Generating signals...");
      const signals = generateSignals(dates, matrix, tickers, params, Cfull);
      console.log(`Generated ${signals.length} signal dates`);

      // 3. Cfull drift monitoring
      const recentReturns = matrix.slice(Math.max(0, matrix.length - 250));
      const cleanRecentReturns = recentReturns.map((row) => cleanCols.map((c) => row[c]));
      const cleanCorr = cleanCols.map((i) => cleanCols.map((j) => Cfull[i][j]));
      const dailyReturns = buildDailyReturns(signals, historyReturns, tickers, dates, matrix);

      let driftReport: CfullDriftReport | null = null;
      if (cleanCols.length > 0 && cleanRecentReturns.length >= 60) {
        driftReport = computeCfullDrift(
          cleanRecentReturns, cleanCorr, dates[dates.length - 1], params.K, dailyReturns,
        );
        for (const line of formatDriftReport(driftReport)) console.log(line);
        console.log("");
      }

      return {
        signals,
        diagnostics: {
          cfullRowCount,
          cleanTickerCount: cleanCols.length,
          totalTickerCount: tickers.length,
          driftReport,
        },
      };
    },
  };
}
