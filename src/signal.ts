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

export interface ConfidenceResult {
  date: string;
  signalRange: number;
  threshold: number;
  isTradeDay: boolean;
  reason?: string;
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
 */
function standardizeWindow(windowData: number[][]): number[][] {
  const T = windowData.length;
  const N = windowData[0].length;
  const means = new Array(N).fill(0);
  const stds = new Array(N).fill(0);

  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) means[i] += windowData[t][i];
  }
  for (let i = 0; i < N; i++) means[i] /= T;

  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) stds[i] += (windowData[t][i] - means[i]) ** 2;
  }
  for (let i = 0; i < N; i++) stds[i] = Math.sqrt(stds[i] / (T - 1));

  return windowData.map((row) =>
    row.map((x, i) => (stds[i] > 1e-12 ? (x - means[i]) / stds[i] : 0)),
  );
}

/**
 * Generate signal for a single date given the rolling window data.
 *
 * @param windowData - L rows × N columns of CC returns (most recent row is "today")
 * @param tickers - ordered ticker list matching columns
 * @param params - PCA_SUB parameters
 * @returns signal for each JP ticker
 */
export function generateSignalForDate(
  windowData: number[][],
  tickers: string[],
  params: SignalParams,
): { signals: Record<string, number>; factorScores: number[] } {
  const N = tickers.length;
  const nUS = tickers.filter((t) => (US_TICKERS as readonly string[]).includes(t)).length;
  const nJP = N - nUS;

  // 1. Standardize within window
  const stdData = standardizeWindow(windowData);

  // 2. Compute sample correlation matrix Ct
  const Ct = correlationMatrix(stdData);

  // 3. Build prior subspace and C0
  const priorVecs = buildPriorSubspace(tickers);
  const C0 = priorCorrelationFromSubspace(priorVecs);

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
 */
export function generateSignals(
  dates: string[],
  matrix: number[][],
  tickers: string[],
  params: SignalParams = DEFAULT_PARAMS,
): SignalResult[] {
  const results: SignalResult[] = [];

  for (let t = params.L; t < dates.length; t++) {
    const windowData = matrix.slice(t - params.L, t);

    const { signals, factorScores } = generateSignalForDate(
      windowData,
      tickers,
      params,
    );

    const { longCandidates, shortCandidates } = selectCandidates(signals, params.q);
    const signalRange = computeSignalRange(signals, longCandidates, shortCandidates);

    results.push({
      date: dates[t - 1],
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
 * Apply confidence filter (section 8.3).
 * Expanding window: at each date, use all past signal ranges to compute percentile threshold.
 */
export function applyConfidenceFilter(
  signalResults: SignalResult[],
  percentile: number = DEFAULT_PARAMS.confidencePercentile,
): ConfidenceResult[] {
  const results: ConfidenceResult[] = [];
  const pastRanges: number[] = [];

  for (const sr of signalResults) {
    pastRanges.push(sr.signalRange);

    // Need at least some history to compute percentile
    if (pastRanges.length < 20) {
      results.push({
        date: sr.date,
        signalRange: sr.signalRange,
        threshold: Infinity,
        isTradeDay: false,
        reason: "Insufficient history for confidence filter",
      });
      continue;
    }

    // Compute percentile threshold from all past data (expanding window)
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
  }

  return results;
}
