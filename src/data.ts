/**
 * Market data loading from CSV (fetched via scripts/fetch-data.py)
 * and Yahoo Finance API fallback.
 */
import * as fs from "node:fs";
import { US_TICKERS, JP_TICKERS } from "./config.js";

export type PriceRow = {
  date: string;       // YYYY-MM-DD
  ticker: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

export type ReturnRow = {
  date: string;
  ticker: string;
  ret: number;        // close-to-close log return
}

export type OCReturnRow = {
  date: string;
  ticker: string;
  ret: number;        // open-to-close simple return: close/open - 1
}

/**
 * Load close prices from a CSV file (output of scripts/fetch-data.py).
 * CSV format: date,TICKER1,TICKER2,...
 */
export function loadClosesFromCsv(csvPath: string): PriceRow[] {
  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const header = lines[0].split(",");
  const tickers = header.slice(1); // first column is date

  const rows: PriceRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = cols[0];
    for (let j = 1; j < cols.length; j++) {
      const val = parseFloat(cols[j]);
      if (!isNaN(val)) {
        rows.push({ date, ticker: tickers[j - 1], close: val });
      }
    }
  }

  return rows;
}

/**
 * Load OHLCV data from a CSV file (format: date,ticker,open,high,low,close,volume).
 * Used for raw data persistence when CSV is the data source.
 */
export function loadOhlcvFromCsv(csvPath: string): PriceRow[] {
  if (!fs.existsSync(csvPath)) return [];
  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const header = lines[0].split(",");
  const colIdx = (name: string) => header.indexOf(name);
  const iDate = colIdx("date"), iTicker = colIdx("ticker");
  const iOpen = colIdx("open"), iHigh = colIdx("high"), iLow = colIdx("low");
  const iClose = colIdx("close"), iVol = colIdx("volume");
  if (iDate < 0 || iClose < 0) return [];

  const rows: PriceRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const close = parseFloat(cols[iClose]);
    if (isNaN(close)) continue;
    rows.push({
      date: cols[iDate],
      ticker: iTicker >= 0 ? cols[iTicker] : "",
      close,
      open: iOpen >= 0 ? parseFloat(cols[iOpen]) || undefined : undefined,
      high: iHigh >= 0 ? parseFloat(cols[iHigh]) || undefined : undefined,
      low: iLow >= 0 ? parseFloat(cols[iLow]) || undefined : undefined,
      volume: iVol >= 0 ? parseFloat(cols[iVol]) || undefined : undefined,
    });
  }
  return rows;
}

/**
 * Load open prices from a CSV file (output of scripts/fetch-data.py).
 * CSV format: date,TICKER1,TICKER2,...
 */
export function loadOpensFromCsv(csvPath: string): PriceRow[] {
  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const header = lines[0].split(",");
  const tickers = header.slice(1);

  const rows: PriceRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = cols[0];
    for (let j = 1; j < cols.length; j++) {
      const val = parseFloat(cols[j]);
      if (!isNaN(val)) {
        rows.push({ date, ticker: tickers[j - 1], open: val, close: 0 });
      }
    }
  }

  return rows;
}

/**
 * Build OC (open-to-close) return matrix for JP tickers.
 * OC return = close[t] / open[t] - 1 (simple return, per paper eq. 2).
 * Returns only rows where ALL given tickers have both open and close data.
 */
export function buildOCReturnMatrix(
  closes: PriceRow[],
  opens: PriceRow[],
  tickers: string[],
): { dates: string[]; tickers: string[]; matrix: number[][] } {
  // Index open prices by date+ticker
  const openMap = new Map<string, number>();
  for (const o of opens) {
    openMap.set(`${o.date}|${o.ticker}`, o.open!);
  }

  // Index close prices by date+ticker
  const closeMap = new Map<string, number>();
  for (const c of closes) {
    closeMap.set(`${c.date}|${c.ticker}`, c.close);
  }

  // Collect all dates from closes
  const allDates = [...new Set(closes.map((c) => c.date))].sort();

  const validDates: string[] = [];
  const matrix: number[][] = [];

  for (const d of allDates) {
    const row: number[] = [];
    let valid = true;
    for (const t of tickers) {
      const openVal = openMap.get(`${d}|${t}`);
      const closeVal = closeMap.get(`${d}|${t}`);
      if (openVal == null || closeVal == null || openVal === 0) {
        valid = false;
        break;
      }
      row.push(closeVal / openVal - 1); // simple OC return
    }
    if (valid) {
      validDates.push(d);
      matrix.push(row);
    }
  }

  return { dates: validDates, tickers, matrix };
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
      const opens: (number | null)[] =
        result.indicators?.quote?.[0]?.open ?? [];
      const highs: (number | null)[] =
        result.indicators?.quote?.[0]?.high ?? [];
      const lows: (number | null)[] =
        result.indicators?.quote?.[0]?.low ?? [];
      const volumes: (number | null)[] =
        result.indicators?.quote?.[0]?.volume ?? [];
      // Use exchange timezone to avoid date shift (US close 16:00 EDT → JST +1 day bug)
      const tz: string = result.meta?.exchangeTimezoneName ?? "Asia/Tokyo";

      const rows: PriceRow[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null) {
          const d = new Date(timestamps[i] * 1000);
          rows.push({
            date: d.toLocaleDateString("sv-SE", { timeZone: tz }),
            ticker,
            close: closes[i]!,
            open: opens[i] ?? undefined,
            high: highs[i] ?? undefined,
            low: lows[i] ?? undefined,
            volume: volumes[i] ?? undefined,
          });
        }
      }
      // Deduplicate by date — Yahoo Finance may return two bars for the
      // latest day (one at open, one at close). Keep the last entry.
      const byDate = new Map<string, PriceRow>();
      for (const r of rows) byDate.set(r.date, r);
      return [...byDate.values()];
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to fetch ${ticker} after 3 attempts: ${lastErr}`);
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
 *
 * @param sparse - if true, include dates where at least one (but not all) ticker
 *   has data, filling missing values with NaN. This enables dynamic universe
 *   shrinking in signal generation (§8.1.2: XLC/XLRE availability).
 *   Default false preserves legacy behavior (only complete rows).
 */
export function buildReturnMatrix(
  returns: ReturnRow[],
  tickers: string[],
  sparse = false,
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
    if (sparse) {
      // Include date if at least one ticker has data
      if (tickers.some((t) => m.has(t))) {
        validDates.push(d);
        matrix.push(tickers.map((t) => m.get(t) ?? NaN));
      }
    } else {
      // Legacy: only dates where ALL tickers have data
      if (tickers.every((t) => m.has(t))) {
        validDates.push(d);
        matrix.push(tickers.map((t) => m.get(t)!));
      }
    }
  }

  return { dates: validDates, tickers, matrix };
}

/**
 * Load data from CSV file or fetch via API, and return aligned return matrix.
 */
export async function fetchAllData(
  startDate: string,
  endDate: string,
  csvPath?: string,
): Promise<{ dates: string[]; tickers: string[]; matrix: number[][]; rawPrices: PriceRow[] }> {
  let allPrices: PriceRow[];

  if (csvPath && fs.existsSync(csvPath)) {
    console.log(`Loading data from CSV: ${csvPath}`);
    // Try OHLCV format first (date,ticker,open,high,low,close,volume), fallback to wide closes
    const ohlcvPath = csvPath.replace(/\.csv$/, "-ohlcv.csv");
    const ohlcvRows = loadOhlcvFromCsv(ohlcvPath);
    if (ohlcvRows.length > 0) {
      allPrices = ohlcvRows;
      console.log(`  Loaded ${allPrices.length} OHLCV rows from ${ohlcvPath}`);
    } else {
      allPrices = loadClosesFromCsv(csvPath);
      console.log(`  Loaded ${allPrices.length} close-only rows`);
    }
  } else {
    console.log("Fetching US sector ETF prices...");
    const usPrices: PriceRow[] = [];
    for (const ticker of US_TICKERS) {
      const rows = await fetchTickerPrices(ticker, startDate, endDate);
      usPrices.push(...rows);
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  Got ${usPrices.length} US price rows`);

    console.log("Fetching JP sector ETF prices...");
    const jpPrices: PriceRow[] = [];
    for (const ticker of JP_TICKERS) {
      const rows = await fetchTickerPrices(ticker, startDate, endDate);
      jpPrices.push(...rows);
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  Got ${jpPrices.length} JP price rows`);

    allPrices = [...usPrices, ...jpPrices];
  }

  const allReturns = computeReturns(allPrices);

  // Dynamic universe: exclude tickers with no data at all
  const allTickers = [...US_TICKERS, ...JP_TICKERS] as unknown as string[];
  const activeTickers = allTickers.filter((t) =>
    allReturns.some((r) => r.ticker === t),
  );

  console.log(`Active universe: ${activeTickers.length} tickers`);

  // Sparse mode (§8.1.2) fills NaN for missing tickers instead of dropping dates,
  // enabling per-window dynamic universe shrinking in generateSignalForDate().
  // Callers that compute Cfull must handle NaN columns appropriately.
  const result = buildReturnMatrix(allReturns, activeTickers, true);
  return { ...result, rawPrices: allPrices };
}
