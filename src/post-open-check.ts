/**
 * Post-open price confirmation (§8.7) - 寄り後価格確認.
 * Separate from mechanical filter (§8.4): runs at 09:10 JST after market open.
 *
 * Checks:
 *   - §8.7.2 Direction maintenance: signal direction vs post-open price movement
 *   - §8.7.2 BBO spread recheck (delegated to mechanical filter)
 *   - §8.7.2 Board stability / sudden moves (via detectRecentVolatility)
 */

import { POST_OPEN_CHECK_TIME, JP_SECTOR_NAMES } from "./config.js";
import type { QuoteData } from "./realtime.js";

export type PostOpenCheckResult = {
  ticker: string;
  signalDirection: "long" | "short";
  directionMatch: boolean;
  priceVsOpen: number;
  passed: boolean;
  reason: string;
};

/**
 * Check if the post-open price movement is consistent with signal direction.
 * Long candidates: price should be >= open (or not significantly below).
 * Short candidates: price should be <= open (or not significantly above).
 */
function checkDirection(
  ticker: string,
  direction: "long" | "short",
  quote: QuoteData,
): PostOpenCheckResult {
  if (quote.open <= 0 || quote.price <= 0) {
    return {
      ticker, signalDirection: direction, directionMatch: false,
      priceVsOpen: 0, passed: false, reason: "価格データなし",
    };
  }

  const moveFromOpen = (quote.price - quote.open) / quote.open;
  const directionMatch =
    direction === "long" ? moveFromOpen >= -0.003 : moveFromOpen <= 0.003;

  return {
    ticker,
    signalDirection: direction,
    directionMatch,
    priceVsOpen: moveFromOpen,
    passed: directionMatch,
    reason: directionMatch
      ? "方向維持OK"
      : `方向不一致: ${direction === "long" ? "ロング" : "ショート"}候補が${moveFromOpen > 0 ? "上昇" : "下落"}${(moveFromOpen * 100).toFixed(2)}%`,
  };
}

/**
 * Run post-open checks for signal candidates.
 * Returns check results for each candidate with direction match status.
 */
export function checkPostOpen(
  longCandidates: readonly string[],
  shortCandidates: readonly string[],
  quotes: Map<string, { quote: QuoteData; bars: unknown[] }>,
): PostOpenCheckResult[] {
  const results: PostOpenCheckResult[] = [];

  for (const t of longCandidates) {
    const data = quotes.get(t);
    if (!data) {
      results.push({
        ticker: t, signalDirection: "long", directionMatch: false,
        priceVsOpen: 0, passed: false, reason: "データなし",
      });
      continue;
    }
    results.push(checkDirection(t, "long", data.quote));
  }

  for (const t of shortCandidates) {
    const data = quotes.get(t);
    if (!data) {
      results.push({
        ticker: t, signalDirection: "short", directionMatch: false,
        priceVsOpen: 0, passed: false, reason: "データなし",
      });
      continue;
    }
    results.push(checkDirection(t, "short", data.quote));
  }

  return results;
}

/**
 * Check if current time is near the post-open check window (§8.7.1).
 * Returns a warning message if outside the expected window.
 */
export function checkTimeWindow(checkTime = POST_OPEN_CHECK_TIME): string | null {
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const [targetH, targetM] = checkTime.split(":").map(Number);
  const diffMin = (jst.getHours() * 60 + jst.getMinutes()) - (targetH * 60 + targetM);

  if (Math.abs(diffMin) > 30) {
    return `現在時刻は基準時刻 ${checkTime} JST から ${Math.abs(diffMin)}分離れています。寄り後確認は ${checkTime} 前後に実行してください。`;
  }
  return null;
}

/** Format post-open check results for console output. */
export function formatPostOpenResults(results: PostOpenCheckResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const name = JP_SECTOR_NAMES[r.ticker] ?? r.ticker;
    const dir = r.signalDirection === "long" ? "L" : "S";
    const status = r.passed ? "✓" : "✗";
    const move = (r.priceVsOpen * 100).toFixed(2);
    lines.push(`  ${status} ${r.ticker} (${name}) [${dir}] 始値比:${move}%  ${r.reason}`);
  }
  return lines;
}
