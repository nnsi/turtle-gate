/**
 * Market data fetching via Yahoo Finance API (direct HTTP).
 */
import { US_TICKERS, JP_TICKERS } from "./config.js";

export interface PriceRow {
  date: string;       // YYYY-MM-DD
  ticker: string;
  close: number;
}

export interface ReturnRow {
  date: string;
  ticker: string;
  ret: number;        // close-to-close log return
}

/**
 * Fetch daily close prices for a single ticker via Yahoo Finance chart API.
 * Retries up to 3 times on failure.
 */
async function fetchTickerPrices(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<PriceRow[]> {
  const period1 = Math.floor(new Date(startDate).getTime() / 1000);
  const period2 = Math.floor(new Date(endDate).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${ticker}`);
      }
      const json = await resp.json() as any;
      const result = json.chart?.result?.[0];
      if (!result) throw new Error(`No chart data for ${ticker}`);

      const timestamps: number[] = result.timestamp ?? [];
      const closes: (number | null)[] =
        result.indicators?.quote?.[0]?.close ?? [];

      const rows: PriceRow[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null) {
          const d = new Date(timestamps[i] * 1000);
          rows.push({
            date: d.toISOString().slice(0, 10),
            ticker,
            close: closes[i]!,
          });
        }
      }
      return rows;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to fetch ${ticker} after 3 attempts: ${lastErr}`);
}

/**
 * Fetch daily close prices for multiple tickers.
 */
async function fetchPrices(
  tickers: readonly string[],
  startDate: string,
  endDate: string,
): Promise<PriceRow[]> {
  const allRows: PriceRow[] = [];
  // Fetch sequentially to avoid rate limits
  for (const ticker of tickers) {
    const rows = await fetchTickerPrices(ticker, startDate, endDate);
    allRows.push(...rows);
    // Brief pause between requests
    await new Promise((r) => setTimeout(r, 300));
  }
  return allRows;
}

/**
 * Compute close-to-close log returns from sorted price rows.
 */
function computeReturns(prices: PriceRow[]): ReturnRow[] {
  const byTicker = new Map<string, PriceRow[]>();
  for (const p of prices) {
    const arr = byTicker.get(p.ticker) ?? [];
    arr.push(p);
    byTicker.set(p.ticker, arr);
  }

  const returns: ReturnRow[] = [];
  for (const [ticker, arr] of byTicker) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < arr.length; i++) {
      returns.push({
        date: arr[i].date,
        ticker,
        ret: Math.log(arr[i].close / arr[i - 1].close),
      });
    }
  }

  return returns;
}

/**
 * Build a date-aligned return matrix.
 * Returns: { dates, tickers, matrix } where matrix[t][i] = return of ticker i on date t.
 * Only dates where ALL tickers have data are included.
 */
export function buildReturnMatrix(
  returns: ReturnRow[],
  tickers: string[],
): { dates: string[]; tickers: string[]; matrix: number[][] } {
  const byDate = new Map<string, Map<string, number>>();
  for (const r of returns) {
    let m = byDate.get(r.date);
    if (!m) {
      m = new Map();
      byDate.set(r.date, m);
    }
    m.set(r.ticker, r.ret);
  }

  const allDates = [...byDate.keys()].sort();
  const validDates: string[] = [];
  const matrix: number[][] = [];

  for (const d of allDates) {
    const m = byDate.get(d)!;
    if (tickers.every((t) => m.has(t))) {
      validDates.push(d);
      matrix.push(tickers.map((t) => m.get(t)!));
    }
  }

  return { dates: validDates, tickers, matrix };
}

/**
 * Fetch all US + JP data and return aligned return matrix.
 */
export async function fetchAllData(
  startDate: string,
  endDate: string,
): Promise<{ dates: string[]; tickers: string[]; matrix: number[][] }> {
  console.log("Fetching US sector ETF prices...");
  const usPrices = await fetchPrices(US_TICKERS, startDate, endDate);
  console.log(`  Got ${usPrices.length} US price rows`);

  console.log("Fetching JP sector ETF prices...");
  const jpPrices = await fetchPrices(JP_TICKERS, startDate, endDate);
  console.log(`  Got ${jpPrices.length} JP price rows`);

  const allReturns = [
    ...computeReturns(usPrices),
    ...computeReturns(jpPrices),
  ];

  // Dynamic universe: exclude tickers with insufficient data
  const allTickers = [...US_TICKERS, ...JP_TICKERS] as unknown as string[];
  const activeTickers = allTickers.filter((t) =>
    allReturns.some((r) => r.ticker === t),
  );

  console.log(`Active universe: ${activeTickers.length} tickers`);

  return buildReturnMatrix(allReturns, activeTickers);
}
