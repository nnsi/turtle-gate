/**
 * Gate conditions & phased forward-testing management (§19.2, §19.3).
 *
 * Gates G1-G4 must pass before live trading.
 * Phases progress: paper -> p90_only -> p90_plus_llm -> normal.
 */

export type Phase = "paper" | "p90_only" | "p90_plus_llm" | "normal";

export type GateStatus = {
  g1: { passed: boolean; avg12mSpread: number };
  g2: { passed: boolean; liveVsJpxRatio: number; consecutiveMonthsExceeding: number };
  g3: { passed: boolean; tradingDays: number; netReturn: number };
  g4: { passed: boolean; consecutiveNormalDays: number; lastAnomalyDate: string | null };
};

export type PhaseConfig = {
  phase: Phase;
  useLLM: boolean;
  minPercentile: number;
  maxPercentile: number;
  allowMediumBand: boolean;
};

/** Fixed one-way cost for G3 evaluation (§19.2: 片道10bps, L/S turnover=2) */
const G3_FIXED_COST_ONE_WAY_BPS = 10;
const G3_TURNOVER = 2; // daily L/S full replacement

/** Daily record fed into gate evaluation. */
export type GateHistoryEntry = {
  date: string;
  jpxAvg12mSpread: number;   // 12-month MA of JPX spread (one-way bps) for G1
  liveVsJpxRatio: number;    // live 09:10 BBO / JPX baseline ratio for G2
  grossReturn: number;        // gross return (before cost) for G3
  traded: boolean;            // actual trade execution flag for G3
  systemNormal: boolean;      // anomaly-free day flag for G4
};

export type GateHistory = {
  entries: GateHistoryEntry[];
  /** Consecutive months where liveVsJpxRatio exceeded 1.5 (for G2) */
  consecutiveMonthsExceeding: number;
  /** Latest BBO-measured liveVsJpxRatio (null if no BBO data) */
  latestBboRatio: number | null;
};

const G1_SPREAD_LIMIT = 10;          // one-way bps
const G2_RATIO_LIMIT = 1.5;
const G2_MAX_CONSECUTIVE_MONTHS = 3;
const G3_MIN_DAYS = 20;
const G4_MIN_DAYS = 20;
const PHASE2_MIN_TRADES = 30;
const PHASE2_GROSS_RR_TARGET = 1.5;
const PHASE3_MIN_TRADES = 30;

const PHASE_CONFIGS: Record<Phase, PhaseConfig> = {
  paper:        { phase: "paper",        useLLM: false, minPercentile: 80, maxPercentile: 90, allowMediumBand: true },
  p90_only:     { phase: "p90_only",     useLLM: false, minPercentile: 90, maxPercentile: 90, allowMediumBand: false },
  p90_plus_llm: { phase: "p90_plus_llm", useLLM: true,  minPercentile: 80, maxPercentile: 90, allowMediumBand: true },
  normal:       { phase: "normal",       useLLM: true,  minPercentile: 80, maxPercentile: 90, allowMediumBand: true },
};

/** Get phase config for current phase. */
export function getPhaseConfig(phase: Phase): PhaseConfig {
  return PHASE_CONFIGS[phase];
}

/** Check if all gates pass based on accumulated history. */
export function checkGates(history: GateHistory): GateStatus {
  const { entries } = history;
  const latest = entries.at(-1);

  // G1: latest 12-month MA spread <= 10 bps
  const avg12m = latest?.jpxAvg12mSpread ?? Infinity;
  const g1 = { passed: avg12m <= G1_SPREAD_LIMIT, avg12mSpread: avg12m };

  // G2: live-to-JPX ratio within 1.5x, not exceeding for 3 consecutive months
  // Use latest BBO-measured ratio (skip days without actual BBO measurement)
  const latestRatio = history.latestBboRatio ?? Infinity;
  const consMonths = history.consecutiveMonthsExceeding;
  const g2 = {
    passed: latestRatio <= G2_RATIO_LIMIT && consMonths < G2_MAX_CONSECUTIVE_MONTHS,
    liveVsJpxRatio: latestRatio,
    consecutiveMonthsExceeding: consMonths,
  };

  // G3: at least 20 trading days, cumulative net return > 0 (§19.2: 片道10bps固定)
  // Use traded flag (not grossReturn) to identify actual trade days.
  const tradeEntries = entries.filter((e) => e.traded);
  const tradingDays = tradeEntries.length;
  const dailyCost = G3_TURNOVER * G3_FIXED_COST_ONE_WAY_BPS / 10000;
  const cumNetReturn = tradeEntries.reduce(
    (sum, e) => sum + e.grossReturn - dailyCost,
    0,
  );
  const g3 = {
    passed: tradingDays >= G3_MIN_DAYS && cumNetReturn > 0,
    tradingDays,
    netReturn: cumNetReturn,
  };

  // G4: 20 consecutive anomaly-free days (count backwards from latest)
  let consecutiveNormal = 0;
  let lastAnomalyDate: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].systemNormal) {
      consecutiveNormal++;
    } else {
      lastAnomalyDate = entries[i].date;
      break;
    }
  }
  const g4 = {
    passed: consecutiveNormal >= G4_MIN_DAYS,
    consecutiveNormalDays: consecutiveNormal,
    lastAnomalyDate,
  };

  return { g1, g2, g3, g4 };
}

/** Determine if phase should advance based on gate status and performance. */
export function shouldAdvancePhase(
  phase: Phase,
  gateStatus: GateStatus,
  tradeCount: number,
  grossRR: number,
): { advance: boolean; nextPhase: Phase; reason: string } {
  const allGatesPass = gateStatus.g1.passed && gateStatus.g2.passed
    && gateStatus.g3.passed && gateStatus.g4.passed;

  switch (phase) {
    case "paper": {
      if (!allGatesPass) return { advance: false, nextPhase: "paper", reason: `Gate未通過: ${failingGates(gateStatus)}` };
      return { advance: true, nextPhase: "p90_only", reason: "G1-G4全通過 → Phase 2へ" };
    }
    case "p90_only": {
      if (tradeCount < PHASE2_MIN_TRADES)
        return { advance: false, nextPhase: "p90_only", reason: `取引数不足: ${tradeCount}/${PHASE2_MIN_TRADES}` };
      if (grossRR < PHASE2_GROSS_RR_TARGET)
        return { advance: false, nextPhase: "p90_only", reason: `グロスR/R未達: ${grossRR.toFixed(2)} < ${PHASE2_GROSS_RR_TARGET}` };
      return { advance: true, nextPhase: "p90_plus_llm", reason: `${tradeCount}取引, グロスR/R ${grossRR.toFixed(2)} → Phase 3へ` };
    }
    case "p90_plus_llm": {
      if (tradeCount < PHASE3_MIN_TRADES)
        return { advance: false, nextPhase: "p90_plus_llm", reason: `取引数不足: ${tradeCount}/${PHASE3_MIN_TRADES}` };
      return { advance: true, nextPhase: "normal", reason: `${tradeCount}取引完了 → Phase 4 通常運用へ` };
    }
    case "normal":
      return { advance: false, nextPhase: "normal", reason: "通常運用中 (四半期モニタリング)" };
  }
}

/** Format gate/phase status for console output. */
export function formatGateStatus(status: GateStatus, phase: Phase): string[] {
  const label: Record<Phase, string> = {
    paper: "Phase 1: ペーパートレード",
    p90_only: "Phase 2: 小額実運用 (P90のみ)",
    p90_plus_llm: "Phase 3: LLM導入 (P90+P80-P89)",
    normal: "Phase 4: 通常運用",
  };
  const p = (ok: boolean) => ok ? "PASS" : "FAIL";
  const { g1, g2, g3, g4 } = status;
  return [
    `--- Gate Status [${label[phase]}] ---`,
    `  G1 スプレッド:   ${p(g1.passed)} 12ヶ月MA ${g1.avg12mSpread.toFixed(2)} bps (上限 ${G1_SPREAD_LIMIT} bps)`,
    `  G2 ライブ乖離:  ${p(g2.passed)} 倍率 ${g2.liveVsJpxRatio.toFixed(2)}x (上限 ${G2_RATIO_LIMIT}x, 連続超過 ${g2.consecutiveMonthsExceeding}/${G2_MAX_CONSECUTIVE_MONTHS}ヶ月)`,
    `  G3 ペーパー損益: ${p(g3.passed)} ${g3.tradingDays}日, Net ${(g3.netReturn * 100).toFixed(2)}% (要${G3_MIN_DAYS}日+プラス)`,
    `  G4 システム安定: ${p(g4.passed)} 連続正常 ${g4.consecutiveNormalDays}日/${G4_MIN_DAYS}日${g4.lastAnomalyDate ? ` (最終異常: ${g4.lastAnomalyDate})` : ""}`,
  ];
}

function failingGates(s: GateStatus): string {
  const f: string[] = [];
  if (!s.g1.passed) f.push("G1");
  if (!s.g2.passed) f.push("G2");
  if (!s.g3.passed) f.push("G3");
  if (!s.g4.passed) f.push("G4");
  return f.join(", ");
}
