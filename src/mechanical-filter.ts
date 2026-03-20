/**
 * Mechanical filter (§8.4) - Pre-execution checks.
 * Checks BBO spreads, anomalies, trading halts, liquidity, and recent volatility.
 *
 * Spread priority:
 *   1. Level2 from broker (BrokerPort.getLevel2Quotes)
 *   2. Real-time bid/ask from Yahoo Finance
 *   3. JPX baseline × stress multiplier
 *   4. JPX baseline (fallback)
 */

import {
  BBO_SPREAD_THRESHOLDS,
  AVG_SPREAD_BPS,
  SPREAD_EMERGENCY_MULTIPLIER,
  MACHINERY_SKIP_BPS,
  ANOMALY_GAP_THRESHOLD,
  MIN_DEPTH_SHARES,
} from "./config.js";
import type { QuoteData, IntradayBar } from "./realtime.js";
import type { Level2Quote } from "./broker.js";
import {
  estimateSpreadFromBidAsk,
  detectStressMultiplier,
  detectRecentVolatility,
} from "./realtime.js";

export type FilterResult = {
  ticker: string;
  passed: boolean;
  estimatedSpreadBps: number;
  baselineSpreadBps: number;
  spreadSource: "level2" | "bid_ask" | "jpx_baseline" | "jpx_stressed";
  stressMultiplier: number;
  emergencyThresholdBps: number;
  rawBid: number | null;
  rawAsk: number | null;
  checkedAt: string;
  reasons: string[];
  checks: {
    spreadOk: boolean;
    noHalt: boolean;
    noAnomaly: boolean;
    noRecentVolatility: boolean;
    liquidityOk: boolean;
  };
};

/**
 * Estimate effective one-way spread (bps) for a ticker.
 * Priority: (1) broker Level2 → (2) live bid/ask → (3) JPX baseline × stress.
 */
function estimateEffectiveSpread(
  ticker: string,
  quote: QuoteData,
  level2?: Level2Quote,
): { spreadBps: number; source: FilterResult["spreadSource"]; stressMul: number } {
  if (level2 && level2.spreadBps > 0) {
    return { spreadBps: level2.spreadBps, source: "level2", stressMul: 1.0 };
  }

  const bidAsk = estimateSpreadFromBidAsk(quote);
  if (bidAsk != null) return { spreadBps: bidAsk, source: "bid_ask", stressMul: 1.0 };

  const baseline = BBO_SPREAD_THRESHOLDS[ticker] ?? AVG_SPREAD_BPS;
  const stress = detectStressMultiplier(quote);
  if (stress > 1.0) return { spreadBps: baseline * stress, source: "jpx_stressed", stressMul: stress };
  return { spreadBps: baseline, source: "jpx_baseline", stressMul: 1.0 };
}

/**
 * Apply mechanical filter to a single ticker (§8.4.1).
 * Checks: (1) halt, (2) BBO spread, (3) anomaly, (4) recent volatility, (5) liquidity.
 */
export function checkTicker(
  ticker: string,
  quote: QuoteData,
  bars: IntradayBar[],
  level2?: Level2Quote,
): FilterResult {
  const baseline = BBO_SPREAD_THRESHOLDS[ticker] ?? AVG_SPREAD_BPS;
  const { spreadBps, source, stressMul } = estimateEffectiveSpread(ticker, quote, level2);
  const emergencyBps = baseline * SPREAD_EMERGENCY_MULTIPLIER;
  const reasons: string[] = [];

  // Check 1: Trading halt
  const noHalt = quote.price > 0 && quote.volume > 0;
  if (!noHalt) reasons.push("取引停止 or データなし");

  // Check 2: BBO spread
  let spreadOk = true;
  if (ticker === "1624.T" && spreadBps > MACHINERY_SKIP_BPS) {
    spreadOk = false;
    reasons.push(`機械(1624.T) spread ${spreadBps.toFixed(1)}bps > ${MACHINERY_SKIP_BPS}bps`);
  } else if (spreadBps > emergencyBps) {
    spreadOk = false;
    reasons.push(`spread ${spreadBps.toFixed(1)}bps > 緊急閾値 ${emergencyBps.toFixed(1)}bps (3×基準)`);
  }

  // Check 3: Price anomaly (gap from previous close)
  let noAnomaly = true;
  if (quote.previousClose > 0 && quote.price > 0) {
    const gap = Math.abs(quote.price / quote.previousClose - 1);
    if (gap >= ANOMALY_GAP_THRESHOLD) {
      noAnomaly = false;
      reasons.push(`異常値: 前日比 ${((quote.price / quote.previousClose - 1) * 100).toFixed(1)}%`);
    }
  }

  // Check 4: Recent volatility (§8.7.2 板の安定性・急変動)
  const recentSwing = detectRecentVolatility(bars);
  const noRecentVolatility = recentSwing < 0.005; // 0.5% swing in recent bars
  if (!noRecentVolatility) {
    reasons.push(`直近急変動: ${(recentSwing * 100).toFixed(2)}%`);
  }

  // Check 5: Liquidity — board depth from broker Level2 (§8.4.1)
  let liquidityOk = true;
  if (level2) {
    if (level2.bestBidSize < MIN_DEPTH_SHARES || level2.bestAskSize < MIN_DEPTH_SHARES) {
      liquidityOk = false;
      reasons.push(
        `流動性不足: bid=${level2.bestBidSize}株 ask=${level2.bestAskSize}株 (最低${MIN_DEPTH_SHARES}株)`,
      );
    }
  }

  const passed = spreadOk && noHalt && noAnomaly && noRecentVolatility && liquidityOk;

  return {
    ticker,
    passed,
    estimatedSpreadBps: spreadBps,
    baselineSpreadBps: baseline,
    spreadSource: source,
    stressMultiplier: stressMul,
    emergencyThresholdBps: emergencyBps,
    rawBid: level2 ? level2.bestBid : quote.bid,
    rawAsk: level2 ? level2.bestAsk : quote.ask,
    checkedAt: new Date().toISOString(),
    reasons: passed ? ["PASS"] : reasons,
    checks: { spreadOk, noHalt, noAnomaly, noRecentVolatility, liquidityOk },
  };
}

/**
 * Apply mechanical filter to candidate tickers.
 * Optionally accepts Level2 data from broker for BBO enrichment + liquidity check.
 */
export function applyMechanicalFilter(
  candidates: readonly string[],
  quotes: Map<string, { quote: QuoteData; bars: IntradayBar[] }>,
  level2Quotes?: Map<string, Level2Quote>,
): FilterResult[] {
  return candidates.map((ticker) => {
    const data = quotes.get(ticker);
    if (!data) {
      const baseline = BBO_SPREAD_THRESHOLDS[ticker] ?? AVG_SPREAD_BPS;
      return {
        ticker,
        passed: false,
        estimatedSpreadBps: baseline,
        baselineSpreadBps: baseline,
        spreadSource: "jpx_baseline" as const,
        stressMultiplier: 1.0,
        emergencyThresholdBps: baseline * SPREAD_EMERGENCY_MULTIPLIER,
        rawBid: null,
        rawAsk: null,
        checkedAt: new Date().toISOString(),
        reasons: ["データ取得失敗"],
        checks: { spreadOk: false, noHalt: false, noAnomaly: false, noRecentVolatility: false, liquidityOk: false },
      };
    }
    return checkTicker(ticker, data.quote, data.bars, level2Quotes?.get(ticker));
  });
}
