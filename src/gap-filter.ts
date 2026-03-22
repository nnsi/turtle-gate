/**
 * Gap filter (F-5): Skip days where overnight gap already consumed the alpha.
 *
 * Analysis (gap-filter-analysis.py) shows:
 * - Top 10% gap days have OC alpha = -7.4bps (negative)
 * - Skipping them improves OC alpha from 16.3 to 25.0bps, t: 1.72 → 3.23
 * - Without this filter, P90 OC alpha is not statistically significant
 */

export type GapFilterResult = {
  strategyGapBps: number;
  thresholdBps: number;
  skip: boolean;
  longGaps: { ticker: string; gapBps: number }[];
  shortGaps: { ticker: string; gapBps: number }[];
};

type QuoteData = {
  open: number;
  previousClose: number;
  [key: string]: unknown;
};

type PostOpenResult = {
  ticker: string;
  signalDirection: string;
  [key: string]: unknown;
};

const DEFAULT_GAP_THRESHOLD_BPS = 75;

/**
 * Compute L/S strategy gap and decide whether to skip.
 *
 * Gap = mean(long open/prevClose) - mean(short open/prevClose)
 * If |gap| > threshold → skip (alpha likely consumed by gap)
 */
export function checkGapFilter(
  postOpenResults: PostOpenResult[],
  quotes: Record<string, QuoteData>,
  thresholdBps?: number,
): GapFilterResult {
  const threshold = thresholdBps ?? DEFAULT_GAP_THRESHOLD_BPS;

  const longs = postOpenResults.filter((r) => r.signalDirection === "long");
  const shorts = postOpenResults.filter((r) => r.signalDirection === "short");

  const computeGaps = (tickers: PostOpenResult[]) =>
    tickers
      .map((r) => {
        const q = quotes[r.ticker];
        if (!q || !q.open || !q.previousClose || q.previousClose <= 0) return null;
        const gapBps = (Math.log(q.open / q.previousClose)) * 10000;
        return { ticker: r.ticker, gapBps };
      })
      .filter((g): g is { ticker: string; gapBps: number } => g !== null);

  const longGaps = computeGaps(longs);
  const shortGaps = computeGaps(shorts);

  const avgLong = longGaps.length > 0
    ? longGaps.reduce((s, g) => s + g.gapBps, 0) / longGaps.length : 0;
  const avgShort = shortGaps.length > 0
    ? shortGaps.reduce((s, g) => s + g.gapBps, 0) / shortGaps.length : 0;

  const strategyGapBps = avgLong - avgShort;

  return {
    strategyGapBps,
    thresholdBps: threshold,
    skip: Math.abs(strategyGapBps) > threshold,
    longGaps,
    shortGaps,
  };
}
