/**
 * Cfull stability monitor (§8.2 Cfull更新ポリシー).
 *
 * Metrics: Frobenius distance, top eigenvalue shift, subspace angle,
 * gross R/R rolling 3-month (§8.2.1), monotonicity Q5 vs Q1 (D.3).
 */

import { correlationMatrix, topKEigenvectors } from "./linalg.js";

export type GrossRRCheck = { rolling3m: number; belowThreshold: boolean; consecutiveMonthsBelow: number };
export type MonotonicityCheck = { q5Alpha: number; q1Alpha: number; monotonic: boolean };

export type CfullDriftReport = {
  date: string;
  windowSize: number;
  frobeniusDistance: number;
  frobeniusNormalized: number;
  topEigenvalueShift: number;
  subspaceAngle: number;
  grossRR?: GrossRRCheck;
  monotonicityCheck?: MonotonicityCheck;
  alerts: string[];
  recommendation: "stable" | "monitor" | "recalibrate";
};

const GROSS_RR_THRESHOLD = 0.5;
const GROSS_RR_MONTHS = 3;
const MONTH = 21;
const FROB_WARN = 0.3, FROB_ALERT = 0.5;
const EIG_WARN = 0.2, EIG_ALERT = 0.4;
const ANGLE_WARN = 20, ANGLE_ALERT = 35; // degrees

function frobeniusDistance(A: number[][], B: number[][]): { raw: number; normalized: number } {
  const N = A.length;
  let sum = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) sum += (A[i][j] - B[i][j]) ** 2;
  const raw = Math.sqrt(sum);
  return { raw, normalized: raw / N };
}

function subspaceAngle(vecs1: number[][], vecs2: number[][], K: number): number {
  const G: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      let dot = 0;
      for (let d = 0; d < vecs1[i].length; d++) dot += vecs1[i][d] * vecs2[j][d];
      G[i][j] = dot;
    }
  }
  let frobSq = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) frobSq += G[i][j] ** 2;
  const avgCos = Math.min(1, Math.max(0, Math.sqrt(frobSq / K)));
  return Math.acos(avgCos) * (180 / Math.PI);
}

/** Per-day gross return record for R/R and monotonicity checks. */
export type DailyReturnRecord = { date: string; grossReturn: number; quintileRank?: number };

function sliceRR(items: DailyReturnRecord[]): number {
  const w = items.filter((d) => d.grossReturn > 0);
  const l = items.filter((d) => d.grossReturn < 0);
  const avgW = w.length > 0 ? w.reduce((s, d) => s + d.grossReturn, 0) / w.length : 0;
  const avgL = l.length > 0 ? Math.abs(l.reduce((s, d) => s + d.grossReturn, 0) / l.length) : 1;
  return avgL > 0 ? avgW / avgL : Infinity;
}

/** Rolling 3-month gross R/R and consecutive months below threshold. */
export function computeGrossRRCheck(daily: DailyReturnRecord[]): GrossRRCheck {
  const last63 = daily.slice(-MONTH * 3);
  if (last63.length < 20) return { rolling3m: NaN, belowThreshold: false, consecutiveMonthsBelow: 0 };
  const rr = sliceRR(last63);
  let cons = 0;
  for (let m = 0; m < 3 && daily.length >= MONTH * (m + 1); m++) {
    if (sliceRR(daily.slice(daily.length - MONTH * (m + 1), daily.length - MONTH * m)) < GROSS_RR_THRESHOLD) cons++;
    else break;
  }
  return { rolling3m: rr, belowThreshold: rr < GROSS_RR_THRESHOLD, consecutiveMonthsBelow: cons };
}

/** Q5 vs Q1 monotonicity (appendix D.3). */
export function computeMonotonicityCheck(daily: DailyReturnRecord[]): MonotonicityCheck | undefined {
  const q5 = daily.filter((d) => d.quintileRank === 5);
  const q1 = daily.filter((d) => d.quintileRank === 1);
  if (q5.length === 0 || q1.length === 0) return undefined;
  const a5 = (q5.reduce((s, d) => s + d.grossReturn, 0) / q5.length) * 10000;
  const a1 = (q1.reduce((s, d) => s + d.grossReturn, 0) / q1.length) * 10000;
  return { q5Alpha: a5, q1Alpha: a1, monotonic: a5 > a1 };
}

/** Compute Cfull drift report with optional R/R and monotonicity checks. */
export function computeCfullDrift(
  recentReturns: number[][], Cfull: number[][], date: string, K = 3,
  dailyReturns?: DailyReturnRecord[],
): CfullDriftReport {
  const Ct = correlationMatrix(recentReturns);
  const { raw: frobRaw, normalized: frobNorm } = frobeniusDistance(Ct, Cfull);
  const eigCt = topKEigenvectors(Ct, K);
  const eigCfull = topKEigenvectors(Cfull, K);
  const eigenShift = Math.abs(eigCt.values[0] - eigCfull.values[0]) / eigCfull.values[0];
  const angle = subspaceAngle(eigCt.vectors, eigCfull.vectors, K);

  const alerts: string[] = [];
  if (frobNorm >= FROB_ALERT) alerts.push(`Frobenius距離が警戒水準超過: ${frobNorm.toFixed(3)} >= ${FROB_ALERT}`);
  else if (frobNorm >= FROB_WARN) alerts.push(`Frobenius距離が注意水準: ${frobNorm.toFixed(3)} >= ${FROB_WARN}`);
  if (eigenShift >= EIG_ALERT) alerts.push(`第1固有値シフトが警戒水準: ${(eigenShift * 100).toFixed(1)}% >= ${EIG_ALERT * 100}%`);
  else if (eigenShift >= EIG_WARN) alerts.push(`第1固有値シフトが注意水準: ${(eigenShift * 100).toFixed(1)}% >= ${EIG_WARN * 100}%`);
  if (angle >= ANGLE_ALERT) alerts.push(`部分空間角度が警戒水準: ${angle.toFixed(1)}deg >= ${ANGLE_ALERT}deg`);
  else if (angle >= ANGLE_WARN) alerts.push(`部分空間角度が注意水準: ${angle.toFixed(1)}deg >= ${ANGLE_WARN}deg`);

  const grossRR = dailyReturns ? computeGrossRRCheck(dailyReturns) : undefined;
  if (grossRR?.belowThreshold) {
    alerts.push(`グロスR/R低下: ${grossRR.rolling3m.toFixed(2)} < ${GROSS_RR_THRESHOLD} (${grossRR.consecutiveMonthsBelow}ヶ月連続)`);
  }
  if (grossRR && grossRR.consecutiveMonthsBelow >= GROSS_RR_MONTHS) {
    alerts.push("Cfull更新検討: グロスR/Rが3ヶ月連続で閾値以下");
  }

  const mono = dailyReturns ? computeMonotonicityCheck(dailyReturns) : undefined;
  if (mono && !mono.monotonic) {
    alerts.push(`モノトニシティ崩壊: Q5(${mono.q5Alpha.toFixed(1)} bps) < Q1(${mono.q1Alpha.toFixed(1)} bps)`);
  }

  const shouldRecal = frobNorm >= FROB_ALERT || eigenShift >= EIG_ALERT || angle >= ANGLE_ALERT
    || (grossRR !== undefined && grossRR.consecutiveMonthsBelow >= GROSS_RR_MONTHS)
    || (mono !== undefined && !mono.monotonic);
  const shouldMon = frobNorm >= FROB_WARN || eigenShift >= EIG_WARN || angle >= ANGLE_WARN
    || (grossRR?.belowThreshold ?? false);

  const recommendation = shouldRecal ? "recalibrate" : shouldMon ? "monitor" : "stable";

  return {
    date, windowSize: recentReturns.length, frobeniusDistance: frobRaw,
    frobeniusNormalized: frobNorm, topEigenvalueShift: eigenShift, subspaceAngle: angle,
    grossRR, monotonicityCheck: mono, alerts, recommendation,
  };
}

/** Format drift report for console output. */
export function formatDriftReport(report: CfullDriftReport): string[] {
  const lines: string[] = [];
  lines.push(`--- Cfull Drift Monitor (${report.date}) ---`);
  lines.push(`  Window: ${report.windowSize} days`);
  lines.push(`  Frobenius distance (norm): ${report.frobeniusNormalized.toFixed(4)} [warn:${FROB_WARN} alert:${FROB_ALERT}]`);
  lines.push(`  Top eigenvalue shift:      ${(report.topEigenvalueShift * 100).toFixed(1)}% [warn:${EIG_WARN * 100}% alert:${EIG_ALERT * 100}%]`);
  lines.push(`  Subspace angle:            ${report.subspaceAngle.toFixed(1)}deg [warn:${ANGLE_WARN}deg alert:${ANGLE_ALERT}deg]`);
  if (report.grossRR) {
    const rr = report.grossRR;
    const v = Number.isNaN(rr.rolling3m) ? "N/A" : rr.rolling3m.toFixed(2);
    lines.push(`  Gross R/R (3m):            ${v} [threshold:${GROSS_RR_THRESHOLD}] (${rr.consecutiveMonthsBelow}m below)`);
  }
  if (report.monotonicityCheck) {
    const mc = report.monotonicityCheck;
    lines.push(`  Monotonicity (Q5 vs Q1):   ${mc.monotonic ? "OK" : "BROKEN"} — Q5=${mc.q5Alpha.toFixed(1)} bps, Q1=${mc.q1Alpha.toFixed(1)} bps`);
  }
  const recLabel = report.recommendation === "stable" ? "STABLE" : report.recommendation === "monitor" ? "MONITOR" : "RECALIBRATE";
  lines.push(`  Recommendation: ${recLabel}`);
  if (report.alerts.length > 0) for (const a of report.alerts) lines.push(`  ! ${a}`);
  return lines;
}
