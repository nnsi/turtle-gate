/**
 * Helpers for order execution (§8.8).
 *
 * Extracted from execute.ts to keep CLI entry point under 200 lines.
 */

import type { BrokerPort, OrderSide } from "./broker.js";
import { MAX_TOTAL_POSITION_JPY, MAX_SIDE_COUNT } from "./config.js";
import { expandSectorToBasket } from "./basket.js";
import type { SectorSignalInput } from "./basket.js";
import type { MarketIndicator } from "./market-context.js";

export type VixRegime = "low" | "normal" | "high" | "unavailable";

export type VixRegimeResult = {
  regime: VixRegime;
  vixLevel: number | null;
  multiplier: number;
};

/**
 * Determine position-size multiplier based on VIX regime (F-2).
 *
 *   VIX < 15:        low vol  → x1.3 (more aggressive)
 *   VIX 15–25:       normal   → x1.0
 *   VIX > 25:        high vol → x0.5 (defensive)
 *   VIX unavailable:          → x1.0 (no change)
 */
export function getVixRegimeMultiplier(usIndicators: MarketIndicator[] | undefined): VixRegimeResult {
  if (!usIndicators || usIndicators.length === 0) {
    return { regime: "unavailable", vixLevel: null, multiplier: 1.0 };
  }
  const vix = usIndicators.find((i) => i.ticker === "^VIX");
  if (!vix || vix.price <= 0) {
    return { regime: "unavailable", vixLevel: null, multiplier: 1.0 };
  }
  const level = vix.price;
  if (level < 15) return { regime: "low", vixLevel: level, multiplier: 1.3 };
  if (level <= 25) return { regime: "normal", vixLevel: level, multiplier: 1.0 };
  return { regime: "high", vixLevel: level, multiplier: 0.5 };
}

export type FinalCandidate = {
  ticker: string;
  side: OrderSide;
  quantity: number;
  price: number;
  /** Set when --basket expands a sector ETF into individual stocks */
  sectorTicker?: string;
};

/** Pick candidates that passed both mechanical filter and post-open check. */
export function resolveCandidates(
  checkData: Record<string, any>,
  positionSize: number,
  sizeMultiplier: number,
): FinalCandidate[] {
  const filterResults: any[] = checkData.filterResults ?? [];
  const postOpenResults: any[] = checkData.postOpenResults ?? [];
  const quotes: Record<string, any> = checkData.quotes ?? {};

  const passedFilter = new Set(filterResults.filter((r: any) => r.passed).map((r: any) => r.ticker));
  const raw: FinalCandidate[] = [];

  for (const poc of postOpenResults) {
    if (!poc.passed || !passedFilter.has(poc.ticker)) continue;
    const quote = quotes[poc.ticker];
    const price = quote?.price ?? 0;
    if (price <= 0) continue;

    const notional = positionSize * sizeMultiplier;
    const quantity = Math.floor(notional / price);
    if (quantity <= 0) continue;

    raw.push({ ticker: poc.ticker, side: poc.signalDirection as OrderSide, quantity, price });
  }

  // §12.1 片側銘柄数制限
  const longs = raw.filter((c) => c.side === "long").slice(0, MAX_SIDE_COUNT);
  const shorts = raw.filter((c) => c.side === "short").slice(0, MAX_SIDE_COUNT);
  const limited = [...longs, ...shorts];

  // §12.1 売買総額制限
  let totalNotional = 0;
  const final: FinalCandidate[] = [];
  for (const c of limited) {
    const notional = c.price * c.quantity;
    if (totalNotional + notional > MAX_TOTAL_POSITION_JPY) break;
    totalNotional += notional;
    final.push(c);
  }
  return final;
}

/** Expand sector-level candidates into individual stock orders via basket mapping. */
export function expandToBasket(
  candidates: FinalCandidate[],
  quotes: Record<string, any>,
): FinalCandidate[] {
  const inputs: SectorSignalInput[] = candidates.map((c) => ({
    sectorTicker: c.ticker,
    direction: c.side,
    sizeJpy: c.price * c.quantity,
  }));
  const positions = expandSectorToBasket(inputs);
  const expanded: FinalCandidate[] = [];
  for (const p of positions) {
    const quote = quotes[p.stockTicker];
    const price = quote?.price ?? 0;
    if (price <= 0) continue;
    const quantity = Math.floor(p.sizeJpy / price);
    if (quantity <= 0) continue;
    expanded.push({ ticker: p.stockTicker, side: p.direction, quantity, price, sectorTicker: p.sectorTicker });
  }
  return expanded;
}

/** Place orders sequentially and return results. */
export async function executeOrders(broker: BrokerPort, candidates: FinalCandidate[]) {
  const results = [];
  for (const c of candidates) {
    const result = await broker.placeOrder({
      ticker: c.ticker,
      side: c.side,
      quantity: c.quantity,
      orderType: "market",
    });
    results.push({ ...c, ...result });
  }
  return results;
}
