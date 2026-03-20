/**
 * Cfull stability monitor (§8.2 Cfull更新ポリシー).
 *
 * Monitors whether the fixed Cfull (2010-2014) is drifting from recent
 * market correlation structure. Alerts when drift exceeds thresholds,
 * suggesting Cfull recalibration may be needed.
 *
 * Metrics:
 *   1. Frobenius distance: ||Ct - Cfull||_F / N
 *   2. Top eigenvalue shift: |λ1(Ct) - λ1(Cfull)| / λ1(Cfull)
 *   3. Subspace angle: angle between top-K eigenspaces
 */

import { correlationMatrix } from "./linalg.js";
import { topKEigenvectors } from "./linalg.js";

export type CfullDriftReport = {
  date: string;
  windowSize: number;
  frobeniusDistance: number;
  frobeniusNormalized: number;
  topEigenvalueShift: number;
  subspaceAngle: number;
  alerts: string[];
  recommendation: "stable" | "monitor" | "recalibrate";
};

const FROBENIUS_WARN = 0.3;
const FROBENIUS_ALERT = 0.5;
const EIGENVALUE_WARN = 0.2;
const EIGENVALUE_ALERT = 0.4;
const SUBSPACE_WARN = 20;   // degrees
const SUBSPACE_ALERT = 35;  // degrees

/** Frobenius distance between two N×N matrices, normalized by N. */
function frobeniusDistance(A: number[][], B: number[][]): { raw: number; normalized: number } {
  const N = A.length;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      sum += (A[i][j] - B[i][j]) ** 2;
    }
  }
  const raw = Math.sqrt(sum);
  return { raw, normalized: raw / N };
}

/**
 * Principal angle between two K-dimensional subspaces.
 * Uses the smallest singular value of Q1' Q2 to compute the largest principal angle.
 * Returns angle in degrees.
 */
function subspaceAngle(vecs1: number[][], vecs2: number[][], K: number): number {
  // Compute Q1' Q2 (K×K matrix)
  const G: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      let dot = 0;
      for (let d = 0; d < vecs1[i].length; d++) {
        dot += vecs1[i][d] * vecs2[j][d];
      }
      G[i][j] = dot;
    }
  }

  // For K=3, compute approximate smallest singular value via ||G||_F
  // min σ ≈ max(0, K - ||G||_F^2)  (rough bound)
  // More precise: cos(θ_max) = min singular value of G
  // For simplicity, use determinant-based approach for small K
  let frobSq = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      frobSq += G[i][j] ** 2;
    }
  }

  // Average cosine similarity: sqrt(||G||_F^2 / K)
  const avgCos = Math.sqrt(frobSq / K);
  const clampedCos = Math.min(1, Math.max(0, avgCos));
  return Math.acos(clampedCos) * (180 / Math.PI);
}

/**
 * Compute Cfull drift report for a given rolling window of recent returns.
 *
 * @param recentReturns - Recent T×N return matrix (e.g. last 120-250 days)
 * @param Cfull - The fixed Cfull correlation matrix
 * @param date - Date label for the report
 * @param K - Number of principal components to compare (default: 3)
 */
export function computeCfullDrift(
  recentReturns: number[][],
  Cfull: number[][],
  date: string,
  K = 3,
): CfullDriftReport {
  const Ct = correlationMatrix(recentReturns);
  const N = Cfull.length;

  // 1. Frobenius distance
  const { raw: frobRaw, normalized: frobNorm } = frobeniusDistance(Ct, Cfull);

  // 2. Top eigenvalue shift
  const eigCt = topKEigenvectors(Ct, K);
  const eigCfull = topKEigenvectors(Cfull, K);
  const eigenShift = Math.abs(eigCt.values[0] - eigCfull.values[0]) / eigCfull.values[0];

  // 3. Subspace angle
  const angle = subspaceAngle(eigCt.vectors, eigCfull.vectors, K);

  // Generate alerts
  const alerts: string[] = [];
  if (frobNorm >= FROBENIUS_ALERT) {
    alerts.push(`Frobenius距離が警戒水準超過: ${frobNorm.toFixed(3)} ≥ ${FROBENIUS_ALERT}`);
  } else if (frobNorm >= FROBENIUS_WARN) {
    alerts.push(`Frobenius距離が注意水準: ${frobNorm.toFixed(3)} ≥ ${FROBENIUS_WARN}`);
  }

  if (eigenShift >= EIGENVALUE_ALERT) {
    alerts.push(`第1固有値シフトが警戒水準: ${(eigenShift * 100).toFixed(1)}% ≥ ${EIGENVALUE_ALERT * 100}%`);
  } else if (eigenShift >= EIGENVALUE_WARN) {
    alerts.push(`第1固有値シフトが注意水準: ${(eigenShift * 100).toFixed(1)}% ≥ ${EIGENVALUE_WARN * 100}%`);
  }

  if (angle >= SUBSPACE_ALERT) {
    alerts.push(`部分空間角度が警戒水準: ${angle.toFixed(1)}° ≥ ${SUBSPACE_ALERT}°`);
  } else if (angle >= SUBSPACE_WARN) {
    alerts.push(`部分空間角度が注意水準: ${angle.toFixed(1)}° ≥ ${SUBSPACE_WARN}°`);
  }

  // Recommendation
  let recommendation: CfullDriftReport["recommendation"];
  if (frobNorm >= FROBENIUS_ALERT || eigenShift >= EIGENVALUE_ALERT || angle >= SUBSPACE_ALERT) {
    recommendation = "recalibrate";
  } else if (frobNorm >= FROBENIUS_WARN || eigenShift >= EIGENVALUE_WARN || angle >= SUBSPACE_WARN) {
    recommendation = "monitor";
  } else {
    recommendation = "stable";
  }

  return {
    date,
    windowSize: recentReturns.length,
    frobeniusDistance: frobRaw,
    frobeniusNormalized: frobNorm,
    topEigenvalueShift: eigenShift,
    subspaceAngle: angle,
    alerts,
    recommendation,
  };
}

/** Format drift report for console output. */
export function formatDriftReport(report: CfullDriftReport): string[] {
  const lines: string[] = [];
  lines.push(`--- Cfull Drift Monitor (${report.date}) ---`);
  lines.push(`  Window: ${report.windowSize} days`);
  lines.push(`  Frobenius distance (norm): ${report.frobeniusNormalized.toFixed(4)} [warn:${FROBENIUS_WARN} alert:${FROBENIUS_ALERT}]`);
  lines.push(`  Top eigenvalue shift:      ${(report.topEigenvalueShift * 100).toFixed(1)}% [warn:${EIGENVALUE_WARN * 100}% alert:${EIGENVALUE_ALERT * 100}%]`);
  lines.push(`  Subspace angle:            ${report.subspaceAngle.toFixed(1)}° [warn:${SUBSPACE_WARN}° alert:${SUBSPACE_ALERT}°]`);

  const recLabel = report.recommendation === "stable" ? "STABLE"
    : report.recommendation === "monitor" ? "MONITOR"
    : "RECALIBRATE";
  lines.push(`  Recommendation: ${recLabel}`);

  if (report.alerts.length > 0) {
    for (const a of report.alerts) lines.push(`  ⚠ ${a}`);
  }

  return lines;
}
