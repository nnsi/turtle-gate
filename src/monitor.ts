/**
 * Operational monitoring module (sections 12.3, 12.4, 13.3, 17.2, D.3).
 *
 * Band pass rates, LLM quality, cumulative return, spread monitoring,
 * quintile Q5/Q1, gross R/R, and halt conditions.
 */

export type ConfidenceBand = "high" | "medium" | "low";

export type TradeHistory = {
  date: string;
  band: ConfidenceBand;
  traded: boolean;
  grossReturn: number;
  spreadCostBps: number;
  llmJudgment?: "tailwind" | "neutral" | "headwind" | "invalid";
  quintileRank?: number;
};

export type MonitorConfig = {
  windowDays: number;
  spreadAlertBps: number;
  haltConsecutiveDays: number;
  llmPassAlphaMinBps: number;
  llmExcludeAlphaMaxBps: number;
  llmDiffMinBps: number;
  grossRRThreshold: number;
};

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  windowDays: 60, spreadAlertBps: 10, haltConsecutiveDays: 20,
  llmPassAlphaMinBps: 15, llmExcludeAlphaMaxBps: 10, llmDiffMinBps: 5,
  grossRRThreshold: 0.5,
};

export type MonitorReport = {
  date: string;
  passRate: { high: number; medium: number; low: number; total: number };
  llmQuality: { passAlpha: number; excludeAlpha: number; diff: number; meetsThreshold: boolean } | null;
  cumulativeReturn: { gross: number; net: number; consecutiveNegativeDays: number };
  spreadMonitor: { avg12m: number; shouldUpgrade: boolean; suggestedPercentiles: { high: number; low: number } };
  quintileCheck: { q5Alpha: number; q1Alpha: number; q5AboveQ1: boolean } | null;
  grossRR: { rolling3m: number; belowThreshold: boolean; consecutiveMonthsBelow: number };
  alerts: string[];
  recommendation: "continue" | "degrade_to_p90" | "disable_llm" | "halt";
};

const MONTH = 21;

function meanReturn(items: TradeHistory[]): number {
  return items.length > 0
    ? (items.reduce((s, h) => s + h.grossReturn, 0) / items.length) * 10000
    : 0;
}

function monthlyRR(slice: TradeHistory[]): number {
  const w = slice.filter((h) => h.grossReturn > 0);
  const l = slice.filter((h) => h.grossReturn < 0);
  const avgW = w.length > 0 ? w.reduce((s, h) => s + h.grossReturn, 0) / w.length : 0;
  const avgL = l.length > 0 ? Math.abs(l.reduce((s, h) => s + h.grossReturn, 0) / l.length) : 1;
  return avgL > 0 ? avgW / avgL : Infinity;
}

/** Compute comprehensive monitoring report from trade history. */
export function computeMonitorReport(
  history: TradeHistory[],
  monthlySpreadAvg12m: number,
  config: MonitorConfig = DEFAULT_MONITOR_CONFIG,
): MonitorReport {
  const win = history.slice(-config.windowDays);
  const date = win.length > 0 ? win[win.length - 1].date : "";
  const alerts: string[] = [];
  const total = win.length;

  // Pass rate
  const passRate = total === 0
    ? { high: 0, medium: 0, low: 0, total: 0 }
    : {
        high: win.filter((h) => h.band === "high").length / total,
        medium: win.filter((h) => h.band === "medium").length / total,
        low: win.filter((h) => h.band === "low").length / total,
        total,
      };

  // LLM quality (section 13.3)
  const passed = win.filter((h) => h.llmJudgment === "tailwind" || h.llmJudgment === "neutral");
  const excluded = win.filter((h) => h.llmJudgment === "headwind" || h.llmJudgment === "invalid");
  const llmQuality = passed.length === 0 && excluded.length === 0 ? null : (() => {
    const passAlpha = meanReturn(passed);
    const excludeAlpha = meanReturn(excluded);
    const diff = passAlpha - excludeAlpha;
    return {
      passAlpha, excludeAlpha, diff,
      meetsThreshold: passAlpha >= config.llmPassAlphaMinBps
        && excludeAlpha < config.llmExcludeAlphaMaxBps && diff >= config.llmDiffMinBps,
    };
  })();

  // Quintile check (appendix D.3)
  const q5 = win.filter((h) => h.quintileRank === 5);
  const q1 = win.filter((h) => h.quintileRank === 1);
  const quintileCheck = q5.length === 0 || q1.length === 0 ? null : {
    q5Alpha: meanReturn(q5), q1Alpha: meanReturn(q1),
    q5AboveQ1: meanReturn(q5) > meanReturn(q1),
  };

  // Cumulative return (section 12.4)
  let gross = 0, net = 0, consecutive = 0;
  for (const h of history) {
    if (!h.traded) continue;
    gross += h.grossReturn;
    net += h.grossReturn - h.spreadCostBps / 10000;
    consecutive = net < 0 ? consecutive + 1 : 0;
  }
  const cumulativeReturn = { gross, net, consecutiveNegativeDays: consecutive };

  // Gross R/R (section 8.2.1)
  const traded = history.filter((h) => h.traded);
  const last63 = traded.slice(-MONTH * 3);
  const rr = last63.length < 20 ? NaN : monthlyRR(last63);
  let consMonths = 0;
  for (let m = 0; m < 3 && traded.length >= MONTH * (m + 1); m++) {
    const sl = traded.slice(traded.length - MONTH * (m + 1), traded.length - MONTH * m);
    if (monthlyRR(sl) < config.grossRRThreshold) consMonths++;
    else break;
  }
  const grossRR = {
    rolling3m: rr,
    belowThreshold: !Number.isNaN(rr) && rr < config.grossRRThreshold,
    consecutiveMonthsBelow: consMonths,
  };

  // Spread monitor (section 12.3)
  const shouldUpgrade = monthlySpreadAvg12m > config.spreadAlertBps;
  const spreadMonitor = {
    avg12m: monthlySpreadAvg12m, shouldUpgrade,
    suggestedPercentiles: shouldUpgrade ? { high: 95, low: 85 } : { high: 90, low: 80 },
  };

  // Alerts & recommendation
  let recommendation: MonitorReport["recommendation"] = "continue";

  if (cumulativeReturn.consecutiveNegativeDays >= config.haltConsecutiveDays) {
    alerts.push(`HALT: コスト控除後累積リターンが${consecutive}営業日連続マイナス (閾値: ${config.haltConsecutiveDays})`);
    recommendation = "halt";
  }
  if (quintileCheck && !quintileCheck.q5AboveQ1) {
    alerts.push(`HALT: Q5(${quintileCheck.q5Alpha.toFixed(1)} bps) < Q1(${quintileCheck.q1Alpha.toFixed(1)} bps) — 直近${config.windowDays}日`);
    recommendation = "halt";
  }
  if (llmQuality && !llmQuality.meetsThreshold) {
    alerts.push(`LLM品質基準未達: pass=${llmQuality.passAlpha.toFixed(1)}, exclude=${llmQuality.excludeAlpha.toFixed(1)}, diff=${llmQuality.diff.toFixed(1)} bps`);
    if (recommendation !== "halt") recommendation = "disable_llm";
  }
  if (shouldUpgrade) {
    alerts.push(`スプレッド警告: 12ヶ月平均 ${monthlySpreadAvg12m.toFixed(1)} bps > ${config.spreadAlertBps} bps`);
    if (recommendation === "continue") recommendation = "degrade_to_p90";
  }
  if (grossRR.belowThreshold) {
    alerts.push(`グロスR/R低下: ${rr.toFixed(2)} < ${config.grossRRThreshold} (${consMonths}ヶ月連続)`);
  }
  if (consMonths >= 3) {
    alerts.push("Cfull更新検討: グロスR/Rが3ヶ月連続で閾値以下");
  }

  return { date, passRate, llmQuality, cumulativeReturn, spreadMonitor, quintileCheck, grossRR, alerts, recommendation };
}
