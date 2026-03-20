/**
 * Real-time market data fetching for Japanese ETFs.
 * Uses Yahoo Finance v8 chart API with intraday intervals.
 * Implements data layer for §8.4 (mechanical filter) and §8.7 (post-open check).
 */

export type QuoteData = {
  ticker: string;
  price: number;
  open: number;
  previousClose: number;
  dayHigh: number;
  dayLow: number;
  bid: number | null;
  ask: number | null;
  volume: number;
  timestamp: number;
  marketState: "PRE" | "REGULAR" | "POST" | "CLOSED";
};

export type IntradayBar = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const UA = "Mozilla/5.0";
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Infer market state from currentTradingPeriod (v8 chart doesn't expose marketState). */
function inferMarketState(meta: Record<string, any>): QuoteData["marketState"] {
  const now = Math.floor(Date.now() / 1000);
  const regular = meta.currentTradingPeriod?.regular;
  if (!regular) return "CLOSED";
  if (now < regular.start) return "PRE";
  if (now <= regular.end) return "REGULAR";
  return "CLOSED";
}

/**
 * Fetch real-time quote + intraday 1-min bars for a single ticker.
 * Retries up to 3 times with backoff (same pattern as data.ts).
 */
export async function fetchRealtimeQuote(
  ticker: string,
): Promise<{ quote: QuoteData; bars: IntradayBar[] }> {
  const url = `${BASE}/${encodeURIComponent(ticker)}?interval=1m&range=1d`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": UA } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${ticker}`);

      const json = (await resp.json()) as Record<string, any>;
      const result = json.chart?.result?.[0];
      if (!result) throw new Error(`No chart data for ${ticker}`);

      const meta = result.meta ?? {};
      const quote: QuoteData = {
        ticker,
        price: meta.regularMarketPrice ?? 0,
        open: meta.regularMarketOpen ?? meta.previousClose ?? 0,
        previousClose: meta.previousClose ?? 0,
        dayHigh: meta.regularMarketDayHigh ?? 0,
        dayLow: meta.regularMarketDayLow ?? 0,
        bid: meta.bid ?? null,
        ask: meta.ask ?? null,
        volume: meta.regularMarketVolume ?? 0,
        timestamp: meta.regularMarketTime ?? 0,
        marketState: inferMarketState(meta),
      };

      const timestamps: number[] = result.timestamp ?? [];
      const q = result.indicators?.quote?.[0] ?? {};
      const bars: IntradayBar[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (q.close?.[i] != null) {
          bars.push({
            timestamp: timestamps[i],
            open: q.open?.[i] ?? 0,
            high: q.high?.[i] ?? 0,
            low: q.low?.[i] ?? 0,
            close: q.close[i],
            volume: q.volume?.[i] ?? 0,
          });
        }
      }
      return { quote, bars };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Failed to fetch realtime ${ticker}: ${msg}`);
}

/**
 * Fetch quotes for multiple tickers with rate limiting (300ms between requests).
 */
export async function fetchAllQuotes(
  tickers: readonly string[],
): Promise<Map<string, { quote: QuoteData; bars: IntradayBar[] }>> {
  const results = new Map<string, { quote: QuoteData; bars: IntradayBar[] }>();

  for (const ticker of tickers) {
    try {
      const data = await fetchRealtimeQuote(ticker);
      results.set(ticker, data);
    } catch (err) {
      console.warn(`  Warning: ${ticker} 取得失敗: ${err}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}

/**
 * Estimate one-way spread in bps from bid/ask (if available).
 * Returns null if bid/ask not in API response.
 * Note: Yahoo Finance v8 chart API rarely provides bid/ask for JP ETFs.
 */
export function estimateSpreadFromBidAsk(quote: QuoteData): number | null {
  if (quote.bid != null && quote.ask != null && quote.bid > 0 && quote.ask > 0) {
    const mid = (quote.bid + quote.ask) / 2;
    return ((quote.ask - quote.bid) / mid) * 10000 / 2;
  }
  return null;
}

/**
 * Detect stress conditions from intraday day range.
 * Returns a continuous multiplier (1.0 = normal, up to 3.0 = extreme).
 * Linear interpolation: dayRange 1.5%→1.0x, 3%→2.0x, 5%+→3.0x.
 */
export function detectStressMultiplier(quote: QuoteData): number {
  if (quote.previousClose <= 0 || quote.dayHigh <= 0 || quote.dayLow <= 0) return 1.0;
  const dayRange = (quote.dayHigh - quote.dayLow) / quote.previousClose;
  if (dayRange <= 0.015) return 1.0;
  if (dayRange >= 0.05) return 3.0;
  // Linear interpolation between 1.5% → 1.0x and 5.0% → 3.0x
  return 1.0 + ((dayRange - 0.015) / (0.05 - 0.015)) * 2.0;
}

/**
 * Detect recent price volatility from intraday bars (§8.7.2 板の安定性・急変動).
 * Checks if any consecutive bars show a price swing > threshold.
 * Returns the max absolute swing (%) among recent bars, or 0 if insufficient data.
 */
export function detectRecentVolatility(bars: IntradayBar[], tailMinutes = 10): number {
  if (bars.length < 2) return 0;
  const cutoff = bars[bars.length - 1].timestamp - tailMinutes * 60;
  const recent = bars.filter((b) => b.timestamp >= cutoff);
  if (recent.length < 2) return 0;

  let maxSwing = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].close;
    if (prev > 0) {
      const swing = Math.abs(recent[i].close / prev - 1);
      if (swing > maxSwing) maxSwing = swing;
    }
  }
  return maxSwing;
}
