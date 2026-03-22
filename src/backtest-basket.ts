/**
 * Basket return helpers for backtest.
 *
 * When running backtest in basket mode, strategy returns are measured
 * using individual stock baskets (3 stocks per sector, equal weight)
 * instead of sector ETF returns.
 */

import { loadClosesFromCsv, buildReturnMatrix } from "./data.js";
import { SECTOR_BASKETS } from "./basket.js";

export type BasketReturnLookup = {
  /** Get basket return for a sector ticker on a given date (CC log return). */
  getReturn: (date: string, sectorTicker: string) => number | undefined;
  /** All dates available in the stock data. */
  dates: string[];
  /** All individual stock tickers loaded. */
  stockTickers: string[];
};

/**
 * Build a lookup that maps (date, sectorTicker) -> equal-weight basket CC return.
 *
 * @param stocksCsvPath - CSV with individual stock close prices (same format as ETF CSV)
 * @param startDate - optional start date filter
 */
export function buildBasketReturnLookup(
  stocksCsvPath: string,
  startDate?: string,
): BasketReturnLookup {
  // Collect all basket stock tickers
  const allStockTickers: string[] = [];
  for (const basket of Object.values(SECTOR_BASKETS)) {
    for (const s of basket.stocks) allStockTickers.push(s.ticker);
  }
  const uniqueTickers = [...new Set(allStockTickers)];

  // Load stock prices and build CC return matrix
  let prices = loadClosesFromCsv(stocksCsvPath);
  if (startDate) prices = prices.filter((p) => p.date >= startDate);

  const byTicker = new Map<string, { date: string; close: number }[]>();
  for (const p of prices) {
    if (!uniqueTickers.includes(p.ticker)) continue;
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

  const activeTickers = uniqueTickers.filter((t) => returns.some((r) => r.ticker === t));
  const { dates, tickers, matrix } = buildReturnMatrix(returns, activeTickers);

  // Build date -> ticker index map for fast lookup
  const dateIdx = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) dateIdx.set(dates[i], i);
  const tickerIdx = new Map<string, number>();
  for (let i = 0; i < tickers.length; i++) tickerIdx.set(tickers[i], i);

  // Pre-build sector -> stock ticker indices
  const sectorStockIndices = new Map<string, number[]>();
  for (const [sectorTicker, basket] of Object.entries(SECTOR_BASKETS)) {
    const indices: number[] = [];
    for (const s of basket.stocks) {
      const idx = tickerIdx.get(s.ticker);
      if (idx !== undefined) indices.push(idx);
    }
    if (indices.length > 0) sectorStockIndices.set(sectorTicker, indices);
  }

  const getReturn = (date: string, sectorTicker: string): number | undefined => {
    const dIdx = dateIdx.get(date);
    if (dIdx === undefined) return undefined;
    const indices = sectorStockIndices.get(sectorTicker);
    if (!indices || indices.length === 0) return undefined;
    let sum = 0;
    let count = 0;
    for (const idx of indices) {
      const val = matrix[dIdx][idx];
      if (!isNaN(val)) { sum += val; count++; }
    }
    return count > 0 ? sum / count : undefined;
  };

  console.log(`Basket data: ${dates.length} dates x ${activeTickers.length} stocks`);
  const coveredSectors = [...sectorStockIndices.keys()];
  console.log(`Basket sectors covered: ${coveredSectors.length}/17`);

  return { getReturn, dates, stockTickers: activeTickers };
}

/**
 * Compute portfolio return using basket returns instead of ETF returns.
 * Falls back to ETF returns for sectors without basket data.
 */
export function basketPortfolioReturn(
  lookup: BasketReturnLookup,
  etfReturns: Record<string, number>,
  date: string,
  longs: string[],
  shorts: string[],
): number {
  const resolve = (ticker: string): number => {
    const basketRet = lookup.getReturn(date, ticker);
    return basketRet ?? (etfReturns[ticker] ?? 0);
  };
  const lr = longs.reduce((s, t) => s + resolve(t), 0) / longs.length;
  const sr = shorts.reduce((s, t) => s + resolve(t), 0) / shorts.length;
  return lr - sr;
}

// ---------------------------------------------------------------------------
// Generic return helpers (shared with backtest.ts)
// ---------------------------------------------------------------------------

/** Get ticker->return map for a date offset from signalDate. */
export function getReturnMap(
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

export function getNextDayOCReturns(
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

export function portfolioReturn(
  dayReturns: Record<string, number>, longs: string[], shorts: string[],
): number {
  const lr = longs.reduce((s, t) => s + (dayReturns[t] ?? 0), 0) / longs.length;
  const sr = shorts.reduce((s, t) => s + (dayReturns[t] ?? 0), 0) / shorts.length;
  return lr - sr;
}
