/**
 * Final trade decision module (§8.6).
 *
 * Decision flow:
 *   High confidence (P90+) → auto-pass → mechanical filter → execute (normal size)
 *   Medium confidence (P80–P89) → LLM review → size depends on judgment → mechanical filter
 *   Low confidence (<P80) → skip
 *
 * Size rules (§8.6.2):
 *   - High confidence / LLM "tailwind" → normal (1.0)
 *   - LLM "neutral" → half (0.5)
 *   - LLM "headwind" or "invalid" → skip (0.0)
 */

import type { SignalResult, ConfidenceResult, ConfidenceBand } from "./signal.js";
import type { LLMResult } from "./llm.js";
import { judgeMediumBand } from "./llm.js";
import { fetchMarketNews, formatNewsForPrompt } from "./news.js";
import { fetchMarketContext, formatMarketContextForPrompt } from "./market-context.js";

export type TradeSize = "normal" | "half" | "skip";

export type TradeDecision = {
  date: string;
  band: ConfidenceBand;
  size: TradeSize;
  sizeMultiplier: number;
  longCandidates: string[];
  shortCandidates: string[];
  signalRange: number;
  thresholdHigh: number;
  thresholdLow: number;
  llmResult?: LLMResult;
  skipReason?: string;
  eventDominance?: boolean;
};

function sizeFromLLMJudgment(judgment: LLMResult["judgment"]): { size: TradeSize; multiplier: number } {
  switch (judgment) {
    case "tailwind": return { size: "normal", multiplier: 1.0 };
    case "neutral":  return { size: "half", multiplier: 0.5 };
    case "headwind": return { size: "skip", multiplier: 0.0 };
    case "invalid":  return { size: "skip", multiplier: 0.0 };
  }
}

/**
 * Make trade decision for a single date (§8.6.1).
 *
 * Requires dual-band confidence result (with band field set).
 */
export async function makeTradeDecision(
  signal: SignalResult,
  confidence: ConfidenceResult,
  skipLLM = false,
): Promise<TradeDecision> {
  const band = confidence.band ?? "low";
  const thresholdHigh = confidence.thresholdHigh ?? confidence.threshold;
  const thresholdLow = confidence.thresholdLow ?? confidence.threshold;

  const base = {
    date: signal.date,
    band,
    signalRange: signal.signalRange,
    thresholdHigh,
    thresholdLow,
    longCandidates: signal.longCandidates,
    shortCandidates: signal.shortCandidates,
  };

  // Low confidence → skip
  if (band === "low") {
    return {
      ...base,
      size: "skip",
      sizeMultiplier: 0.0,
      skipReason: confidence.reason ?? "Low confidence band",
    };
  }

  // High confidence → auto-pass, normal size
  if (band === "high") {
    return {
      ...base,
      size: "normal",
      sizeMultiplier: 1.0,
    };
  }

  // Medium confidence without LLM (P80 all-pass mode) → auto-pass, normal size
  if (band === "medium" && skipLLM) {
    return { ...base, size: "normal", sizeMultiplier: 1.0 };
  }

  // Medium confidence → fetch context + LLM review (§8.5)
  let newsContext: string | undefined;
  let marketContext: string | undefined;

  try {
    console.log("  Fetching market context for LLM...");
    const [news, indicators] = await Promise.all([
      fetchMarketNews().catch(() => []),
      fetchMarketContext().catch(() => []),
    ]);

    if (news.length > 0) {
      newsContext = formatNewsForPrompt(news);
      console.log(`  News: ${news.length} items (Finnhub + Google News RSS)`);
    }
    if (indicators.length > 0) {
      marketContext = formatMarketContextForPrompt(indicators);
      console.log(`  US indicators: ${indicators.length} (SPY, VIX, TNX, USDJPY, DXY)`);
    }
  } catch (err) {
    console.warn("  Context fetch failed, proceeding without:", err);
  }

  // §9.5: LLM応答異常時は中確信バンド全見送り（高確信バンドは影響なし）
  let llmResult: LLMResult;
  try {
    llmResult = await judgeMediumBand({
      date: signal.date,
      signalRange: signal.signalRange,
      band: "medium",
      longCandidates: signal.longCandidates,
      shortCandidates: signal.shortCandidates,
      signals: signal.signals,
      newsContext,
      marketContext,
    });
  } catch (err) {
    console.warn("LLM応答異常、中確信バンド全見送り:", err);
    return {
      ...base,
      size: "skip",
      sizeMultiplier: 0.0,
      skipReason: `LLM応答異常: ${err}`,
    };
  }

  // §11.3: イベント支配 → 当日全停止（高確信バンド含む）
  if (llmResult.eventDominance) {
    return {
      ...base,
      size: "skip",
      sizeMultiplier: 0.0,
      skipReason: `Event dominance: ${llmResult.summary}`,
      llmResult,
      eventDominance: true,
    };
  }

  const { size, multiplier } = sizeFromLLMJudgment(llmResult.judgment);
  return {
    ...base,
    size,
    sizeMultiplier: multiplier,
    llmResult,
    skipReason: size === "skip"
      ? `LLM judgment: ${llmResult.judgment} — ${llmResult.summary}`
      : undefined,
  };
}

/**
 * Batch trade decisions for all signal dates.
 * Only processes dates where band is set (requires applyDualBandFilter).
 */
export async function makeAllTradeDecisions(
  signals: SignalResult[],
  confidences: ConfidenceResult[],
): Promise<TradeDecision[]> {
  const decisions: TradeDecision[] = [];
  for (let i = 0; i < signals.length; i++) {
    decisions.push(await makeTradeDecision(signals[i], confidences[i]));
  }
  return decisions;
}

/** Format a trade decision for human-readable output. */
export function formatTradeDecision(d: TradeDecision): string[] {
  const lines: string[] = [];
  const bandLabel = d.band === "high" ? "HIGH (auto-pass)"
    : d.band === "medium" ? "MEDIUM (LLM review)"
    : "LOW (skip)";

  lines.push(`Band: ${bandLabel}`);
  lines.push(`Size: ${d.size} (×${d.sizeMultiplier})`);
  lines.push(`Thresholds: P80=${d.thresholdLow.toFixed(4)}, P90=${d.thresholdHigh.toFixed(4)}`);

  if (d.eventDominance) {
    lines.push("** EVENT DOMINANCE: all trades halted (§11.3) **");
  }

  if (d.llmResult) {
    lines.push(`LLM Judgment: ${d.llmResult.judgment} (confidence: ${d.llmResult.confidence.toFixed(2)})`);
    lines.push(`LLM Summary: ${d.llmResult.summary}`);
    if (d.llmResult.newsSummary) lines.push(`News Summary: ${d.llmResult.newsSummary}`);
    if (d.llmResult.riskFactors.length > 0) {
      lines.push(`Risk Factors: ${d.llmResult.riskFactors.join("; ")}`);
    }
    lines.push(`LLM Provider: ${d.llmResult.provider}/${d.llmResult.model}`);
    if (Object.keys(d.llmResult.sectorNotes).length > 0) {
      lines.push("LLM Sector Notes:");
      for (const [t, note] of Object.entries(d.llmResult.sectorNotes)) {
        lines.push(`  ${t}: ${note}`);
      }
    }
  }

  if (d.skipReason) {
    lines.push(`Skip Reason: ${d.skipReason}`);
  }

  return lines;
}
