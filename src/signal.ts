/**
 * PCA_SUB signal generation (section 8.2 of requirements).
 *
 * Steps:
 * 1. Standardize CC returns in rolling window (L=60)
 * 2. Compute combined correlation matrix Ct (28×28)
 * 3. Build prior subspace (global, country-spread, cyclical-defensive)
 * 4. Regularize: Creg = (1-λ)Ct + λC0
 * 5. Top-K eigenvectors → split US/JP blocks → factor scores → signal vector
 * 6. Top q → Long, Bottom q → Short
 */

import {
  US_TICKERS,
  JP_TICKERS,
  US_CYCLICAL,
  US_DEFENSIVE,
  JP_CYCLICAL,
  JP_DEFENSIVE,
  type SignalParams,
  DEFAULT_PARAMS,
} from "./config.js";
import {
  correlationMatrix,
  regularizeCorrelation,
  priorCorrelationFromSubspace,
  topKEigenvectors,
  orthonormalize,
} from "./linalg.js";

export interface SignalResult {
  date: string;
  signals: Record<string, number>;
  longCandidates: string[];
  shortCandidates: string[];
  signalRange: number;
  factorScores: number[];
}

export type ConfidenceBand = "high" | "medium" | "low";

export interface ConfidenceResult {
  date: string;
  signalRange: number;
  threshold: number;
  isTradeDay: boolean;
  reason?: string;
  /** Dual-band fields (set by applyDualBandFilter) */
  band?: ConfidenceBand;
  thresholdHigh?: number;
  thresholdLow?: number;
}

/**
 * Build the 3 prior subspace vectors (section 8.2.1).
 */
export function buildPriorSubspace(tickers: string[]): number[][] {
  const N = tickers.length;
  const nUS = US_TICKERS.length;

  // v1: Global factor – equal weight on all
  const v1 = new Array(N).fill(1 / Math.sqrt(N));

  // v2: Country spread – positive for US, negative for JP, orthogonalized to v1
  const v2raw = tickers.map((t) =>
    (US_TICKERS as readonly string[]).includes(t) ? 1 : -1,
  );

  // v3: Cyclical-Defensive – cyclical positive, defensive negative, rest 0
  const allCyclical = [...US_CYCLICAL, ...JP_CYCLICAL];
  const allDefensive = [...US_DEFENSIVE, ...JP_DEFENSIVE];
  const v3raw = tickers.map((t) => {
    if (allCyclical.includes(t)) return 1;
    if (allDefensive.includes(t)) return -1;
    return 0;
  });

  // Orthonormalize v1, v2, v3
  return orthonormalize([v1, v2raw, v3raw]);
}

/**
 * Standardize data within a window: z = (x - mean) / std for each column.
 *
 * Stats (mean, population std) are computed from the first T-1 rows only
 * (past data, Wt = {t-L, ..., t-1}). The last row (today) is standardized
 * using those stats but excluded from their computation to avoid look-ahead.
 */
function standardizeWindow(windowData: number[][]): number[][] {
  const T = windowData.length;
  const N = windowData[0].length;
  const pastT = T - 1; // number of past observations (exclude today)
  const means = new Array(N).fill(0);
  const stds = new Array(N).fill(0);

  // Compute means from past data only (first T-1 rows)
  for (let t = 0; t < pastT; t++) {
    for (let i = 0; i < N; i++) means[i] += windowData[t][i];
  }
  for (let i = 0; i < N; i++) means[i] /= pastT;

  // Population std from past data only (divide by L, not L-1)
  for (let t = 0; t < pastT; t++) {
    for (let i = 0; i < N; i++) stds[i] += (windowData[t][i] - means[i]) ** 2;
  }
  for (let i = 0; i < N; i++) stds[i] = Math.sqrt(stds[i] / pastT);

  // Standardize ALL rows (including today) using past-only stats
  return windowData.map((row) =>
    row.map((x, i) => (stds[i] > 1e-12 ? (x - means[i]) / stds[i] : 0)),
  );
}

/**
 * Generate signal for a single date given the rolling window data.
 *
 * @param windowData - (L+1) rows × N columns of CC returns. First L rows are
 *   past data (Wt), last row is "today". Stats are computed from past only.
 * @param tickers - ordered ticker list matching columns
 * @param params - PCA_SUB parameters
 * @param Cfull - full correlation matrix estimated from long-term data (§8.2.1)
 * @returns signal for each JP ticker
 */
export function generateSignalForDate(
  windowData: number[][],
  tickers: string[],
  params: SignalParams,
  Cfull: number[][],
): { signals: Record<string, number>; factorScores: number[] } {
  const N = tickers.length;
  const nUS = tickers.filter((t) => (US_TICKERS as readonly string[]).includes(t)).length;
  const nJP = N - nUS;

  // 1. Standardize: stats from first L rows (past), apply to all L+1 rows
  const stdData = standardizeWindow(windowData);

  // 2. Compute sample correlation matrix Ct from past data only (exclude today)
  const stdPast = stdData.slice(0, stdData.length - 1);
  const Ct = correlationMatrix(stdPast);

  // 3. Build prior subspace and C0 using Cfull (paper equations 10-12)
  const priorVecs = buildPriorSubspace(tickers);
  const C0 = priorCorrelationFromSubspace(priorVecs, Cfull);

  // 4. Regularize: Creg = (1-λ)Ct + λC0
  const Creg = regularizeCorrelation(Ct, C0, params.lambda);

  // 5. Top-K eigenvectors
  const { vectors } = topKEigenvectors(Creg, params.K);

  // 6. Split into US / JP blocks
  // vectors[k] is full N-dim eigenvector. US part = first nUS elements, JP part = rest.
  const usLoadings = vectors.map((v) => v.slice(0, nUS));
  const jpLoadings = vectors.map((v) => v.slice(nUS));

  // 7. Extract factor scores from today's US returns
  // Today's standardized US returns
  const todayStd = stdData[stdData.length - 1];
  const todayUS = todayStd.slice(0, nUS);

  // Factor score for each component k: f_k = sum_i(usLoading_k_i * todayUS_i)
  const factorScores = usLoadings.map((loading) =>
    loading.reduce((s, w, i) => s + w * todayUS[i], 0),
  );

  // 8. Reconstruct JP signal: signal_j = sum_k(f_k * jpLoading_k_j)
  const jpSignals = new Array(nJP).fill(0);
  for (let k = 0; k < params.K; k++) {
    for (let j = 0; j < nJP; j++) {
      jpSignals[j] += factorScores[k] * jpLoadings[k][j];
    }
  }

  // Map to JP tickers
  const jpTickers = tickers.slice(nUS);
  const signals: Record<string, number> = {};
  for (let j = 0; j < nJP; j++) {
    signals[jpTickers[j]] = jpSignals[j];
  }

  return { signals, factorScores };
}

/**
 * Determine long/short candidates from signals.
 */
export function selectCandidates(
  signals: Record<string, number>,
  q: number,
): { longCandidates: string[]; shortCandidates: string[] } {
  const entries = Object.entries(signals).sort((a, b) => b[1] - a[1]);
  const n = entries.length;
  const topN = Math.max(1, Math.round(n * q));
  const bottomN = Math.max(1, Math.round(n * q));

  const longCandidates = entries.slice(0, topN).map(([t]) => t);
  const shortCandidates = entries.slice(n - bottomN).map(([t]) => t);

  return { longCandidates, shortCandidates };
}

/**
 * Compute signal range: mean(long signals) - mean(short signals).
 */
export function computeSignalRange(
  signals: Record<string, number>,
  longCandidates: string[],
  shortCandidates: string[],
): number {
  const longMean =
    longCandidates.reduce((s, t) => s + signals[t], 0) / longCandidates.length;
  const shortMean =
    shortCandidates.reduce((s, t) => s + signals[t], 0) / shortCandidates.length;
  return longMean - shortMean;
}

/**
 * Run signal generation over the full return matrix.
 *
 * @param Cfull - full correlation matrix from long-term estimation period (§8.2.1).
 */
export function generateSignals(
  dates: string[],
  matrix: number[][],
  tickers: string[],
  params: SignalParams = DEFAULT_PARAMS,
  Cfull: number[][],
): SignalResult[] {
  const results: SignalResult[] = [];

  // Window: L past days + today = L+1 rows.
  // t indexes "today" in the matrix (0-based). Need t >= L so that
  // matrix[t-L .. t] has L+1 rows.
  for (let t = params.L; t < matrix.length; t++) {
    // L+1 rows: past L days [t-L, ..., t-1] + today [t]
    const windowData = matrix.slice(t - params.L, t + 1);

    const { signals, factorScores } = generateSignalForDate(
      windowData,
      tickers,
      params,
      Cfull,
    );

    const { longCandidates, shortCandidates } = selectCandidates(signals, params.q);
    const signalRange = computeSignalRange(signals, longCandidates, shortCandidates);

    results.push({
      date: dates[t],
      signals,
      longCandidates,
      shortCandidates,
      signalRange,
      factorScores,
    });
  }

  return results;
}

/**
 * Apply confidence filter (section 8.3) — single threshold version.
 * Expanding window: at each date, use all past signal ranges to compute percentile threshold.
 * Kept for backward compatibility with backtest.
 */
export function applyConfidenceFilter(
  signalResults: SignalResult[],
  percentile: number = DEFAULT_PARAMS.confidencePercentile,
): ConfidenceResult[] {
  const results: ConfidenceResult[] = [];
  const pastRanges: number[] = [];

  for (const sr of signalResults) {
    // Need at least some history to compute percentile
    if (pastRanges.length < 20) {
      results.push({
        date: sr.date,
        signalRange: sr.signalRange,
        threshold: Infinity,
        isTradeDay: false,
        reason: "Insufficient history for confidence filter",
      });
      pastRanges.push(sr.signalRange);
      continue;
    }

    // Compute percentile threshold from past data only (expanding window,
    // excluding today to avoid look-ahead bias per §8.3.4)
    const sorted = [...pastRanges].sort((a, b) => a - b);
    const idx = Math.floor((percentile / 100) * (sorted.length - 1));
    const threshold = sorted[idx];

    const isTradeDay = sr.signalRange >= threshold;

    results.push({
      date: sr.date,
      signalRange: sr.signalRange,
      threshold,
      isTradeDay,
      reason: isTradeDay ? undefined : `Signal range ${sr.signalRange.toFixed(4)} < threshold ${threshold.toFixed(4)}`,
    });

    // Push today's range AFTER threshold computation
    pastRanges.push(sr.signalRange);
  }

  return results;
}

/**
 * Apply dual-band confidence filter (section 8.3.3).
 * - P90+ → high confidence (auto-pass)
 * - P80–P89 → medium confidence (LLM review required)
 * - <P80 → low confidence (auto-skip)
 */
export function applyDualBandFilter(
  signalResults: SignalResult[],
  percentileHigh: number = DEFAULT_PARAMS.confidencePercentile,
  percentileLow: number = DEFAULT_PARAMS.confidencePercentileLow,
): ConfidenceResult[] {
  const results: ConfidenceResult[] = [];
  const pastRanges: number[] = [];

  for (const sr of signalResults) {
    if (pastRanges.length < 20) {
      results.push({
        date: sr.date,
        signalRange: sr.signalRange,
        threshold: Infinity,
        thresholdHigh: Infinity,
        thresholdLow: Infinity,
        isTradeDay: false,
        band: "low",
        reason: "Insufficient history for confidence filter",
      });
      pastRanges.push(sr.signalRange);
      continue;
    }

    const sorted = [...pastRanges].sort((a, b) => a - b);
    const idxHigh = Math.floor((percentileHigh / 100) * (sorted.length - 1));
    const idxLow = Math.floor((percentileLow / 100) * (sorted.length - 1));
    const thresholdHigh = sorted[idxHigh];
    const thresholdLow = sorted[idxLow];

    let band: ConfidenceBand;
    let reason: string | undefined;

    if (sr.signalRange >= thresholdHigh) {
      band = "high";
      reason = undefined;
    } else if (sr.signalRange >= thresholdLow) {
      band = "medium";
      reason = `Medium band: ${sr.signalRange.toFixed(4)} ∈ [P${percentileLow}=${thresholdLow.toFixed(4)}, P${percentileHigh}=${thresholdHigh.toFixed(4)})`;
    } else {
      band = "low";
      reason = `Signal range ${sr.signalRange.toFixed(4)} < P${percentileLow} threshold ${thresholdLow.toFixed(4)}`;
    }

    // isTradeDay = high or medium (medium still needs LLM approval)
    const isTradeDay = band !== "low";

    results.push({
      date: sr.date,
      signalRange: sr.signalRange,
      threshold: thresholdHigh,
      thresholdHigh,
      thresholdLow,
      isTradeDay,
      band,
      reason,
    });

    pastRanges.push(sr.signalRange);
  }

  return results;
}
