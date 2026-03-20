/**
 * US major indices, rates, and FX data (§8.1.1).
 *
 * Fetches context data for mechanical filter and LLM judgment:
 *   - S&P 500 (SPY) — US equity market
 *   - VIX (^VIX) — implied volatility
 *   - US 10Y yield (^TNX) — interest rates
 *   - USD/JPY (JPY=X) — FX
 *   - DXY (DX-Y.NYB) — dollar index
 *
 * Uses Yahoo Finance v8 chart API (same as realtime.ts).
 */

const UA = "Mozilla/5.0";
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

export type MarketIndicator = {
  ticker: string;
  label: string;
  price: number;
  previousClose: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  timestamp: number;
};

const INDICATORS = [
  { ticker: "SPY", label: "S&P 500 ETF" },
  { ticker: "^VIX", label: "VIX" },
  { ticker: "^TNX", label: "US 10Y Yield" },
  { ticker: "JPY=X", label: "USD/JPY" },
  { ticker: "DX-Y.NYB", label: "Dollar Index" },
] as const;

async function fetchIndicator(
  ticker: string,
  label: string,
): Promise<MarketIndicator | null> {
  const url = `${BASE}/${encodeURIComponent(ticker)}?interval=1d&range=5d`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": UA } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const json = (await resp.json()) as Record<string, any>;
      const meta = json.chart?.result?.[0]?.meta;
      if (!meta) throw new Error("No meta");

      const price = meta.regularMarketPrice ?? 0;
      const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;
      const change = price - previousClose;
      const changePct = previousClose > 0 ? change / previousClose : 0;

      return {
        ticker,
        label,
        price,
        previousClose,
        change,
        changePct,
        dayHigh: meta.regularMarketDayHigh ?? price,
        dayLow: meta.regularMarketDayLow ?? price,
        timestamp: meta.regularMarketTime ?? 0,
      };
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  console.warn(`  Failed to fetch ${ticker} (${label})`);
  return null;
}

/** Fetch all US market context indicators. */
export async function fetchMarketContext(): Promise<MarketIndicator[]> {
  const results: MarketIndicator[] = [];

  for (const { ticker, label } of INDICATORS) {
    const ind = await fetchIndicator(ticker, label);
    if (ind) results.push(ind);
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}

/** Format market context for LLM prompt injection. */
export function formatMarketContextForPrompt(indicators: MarketIndicator[]): string {
  if (indicators.length === 0) return "(No US market data available)";

  const lines: string[] = [];
  for (const ind of indicators) {
    const dir = ind.changePct >= 0 ? "+" : "";
    lines.push(
      `${ind.label} (${ind.ticker}): ${ind.price.toFixed(2)}  ${dir}${(ind.changePct * 100).toFixed(2)}%  (prev: ${ind.previousClose.toFixed(2)})`,
    );
  }
  return lines.join("\n");
}

/** Format market context for console display. */
export function formatMarketContextForConsole(indicators: MarketIndicator[]): string[] {
  const lines: string[] = [];
  lines.push("--- 米国主要指標 (§8.1.1) ---");
  for (const ind of indicators) {
    const dir = ind.changePct >= 0 ? "+" : "";
    const pctStr = `${dir}${(ind.changePct * 100).toFixed(2)}%`;
    lines.push(
      `  ${ind.label.padEnd(16)} ${String(ind.price.toFixed(2)).padStart(10)}  ${pctStr.padStart(8)}`,
    );
  }
  return lines;
}

/** Check if VIX is elevated (stress signal for mechanical filter). */
export function isVIXElevated(indicators: MarketIndicator[]): {
  elevated: boolean;
  level: number;
  threshold: number;
} {
  const vix = indicators.find((i) => i.ticker === "^VIX");
  if (!vix) return { elevated: false, level: 0, threshold: 25 };
  return { elevated: vix.price >= 25, level: vix.price, threshold: 25 };
}

/** Check for significant overnight moves that may impact JP market. */
export function detectOvernightMoves(indicators: MarketIndicator[]): string[] {
  const alerts: string[] = [];
  for (const ind of indicators) {
    const absPct = Math.abs(ind.changePct);
    if (ind.ticker === "SPY" && absPct >= 0.015) {
      alerts.push(`S&P 500 大幅${ind.changePct > 0 ? "上昇" : "下落"}: ${(ind.changePct * 100).toFixed(2)}%`);
    }
    if (ind.ticker === "^VIX" && ind.price >= 30) {
      alerts.push(`VIX 高水準: ${ind.price.toFixed(1)} (≥30)`);
    }
    if (ind.ticker === "JPY=X" && absPct >= 0.01) {
      alerts.push(`USD/JPY 急変: ${(ind.changePct * 100).toFixed(2)}%`);
    }
  }
  return alerts;
}
