/**
 * Human-readable signal report formatting.
 * Extracted from generate-signal.ts for modularity.
 */

import { JP_SECTOR_NAMES } from "./config.js";
import type { SignalResult } from "./signal.js";
import type { TradeDecision } from "./trade-decision.js";
import { formatTradeDecision } from "./trade-decision.js";

export function formatSignalReport(
  signal: SignalResult,
  confidence: { isTradeDay: boolean; threshold: number; reason?: string; band?: string; thresholdHigh?: number; thresholdLow?: number },
  decision?: TradeDecision,
): string {
  const lines: string[] = [];
  lines.push(`=== ${signal.date} ===`);
  lines.push(`Signal Range: ${signal.signalRange.toFixed(4)}`);

  if (confidence.band) {
    const bandLabel = confidence.band === "high" ? "HIGH (P90+)"
      : confidence.band === "medium" ? "MEDIUM (P80-P89)"
      : "LOW (<P80)";
    lines.push(`Confidence Band: ${bandLabel}`);
    lines.push(`Threshold High (P90): ${(confidence.thresholdHigh ?? confidence.threshold).toFixed(4)}`);
    lines.push(`Threshold Low (P80):  ${(confidence.thresholdLow ?? confidence.threshold).toFixed(4)}`);
  } else {
    lines.push(`Confidence Threshold: ${confidence.threshold.toFixed(4)}`);
  }

  lines.push(`Trade Day: ${confidence.isTradeDay ? "YES" : "NO"}`);
  if (confidence.reason) lines.push(`Reason: ${confidence.reason}`);

  if (decision) {
    lines.push("");
    for (const l of formatTradeDecision(decision)) lines.push(l);
  }

  lines.push("");
  lines.push("Factor Scores: " + signal.factorScores.map((f) => f.toFixed(4)).join(", "));
  lines.push("");

  lines.push("Long Candidates:");
  for (const t of signal.longCandidates) {
    lines.push(`  ${t} (${JP_SECTOR_NAMES[t] ?? t}): ${signal.signals[t].toFixed(4)}`);
  }
  lines.push("");

  lines.push("Short Candidates:");
  for (const t of signal.shortCandidates) {
    lines.push(`  ${t} (${JP_SECTOR_NAMES[t] ?? t}): ${signal.signals[t].toFixed(4)}`);
  }
  lines.push("");

  lines.push("All Signals:");
  const sorted = Object.entries(signal.signals).sort((a, b) => b[1] - a[1]);
  for (const [t, v] of sorted) {
    const tag = signal.longCandidates.includes(t) ? " [LONG]"
      : signal.shortCandidates.includes(t) ? " [SHORT]" : "";
    lines.push(`  ${t} (${JP_SECTOR_NAMES[t] ?? t}): ${v.toFixed(4)}${tag}`);
  }

  return lines.join("\n");
}
