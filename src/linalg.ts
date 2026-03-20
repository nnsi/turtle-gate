/**
 * Linear algebra utilities using mathjs.
 */
import { matrix, eigs } from "mathjs";

/**
 * Compute correlation matrix from a T×N data matrix (already standardized).
 */
export function correlationMatrix(data: number[][]): number[][] {
  const T = data.length;
  const N = data[0].length;

  // Compute means
  const means = new Array(N).fill(0);
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) {
      means[i] += data[t][i];
    }
  }
  for (let i = 0; i < N; i++) means[i] /= T;

  // Compute std devs
  const stds = new Array(N).fill(0);
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < N; i++) {
      stds[i] += (data[t][i] - means[i]) ** 2;
    }
  }
  for (let i = 0; i < N; i++) stds[i] = Math.sqrt(stds[i] / T);

  // Standardize and compute correlation
  const corr: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    corr[i][i] = 1.0;
    for (let j = i + 1; j < N; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) {
        const xi = (data[t][i] - means[i]) / (stds[i] || 1e-12);
        const xj = (data[t][j] - means[j]) / (stds[j] || 1e-12);
        s += xi * xj;
      }
      corr[i][j] = s / T;
      corr[j][i] = corr[i][j];
    }
  }

  return corr;
}

/**
 * Regularize correlation matrix: Creg = (1-λ)Ct + λC0
 */
export function regularizeCorrelation(
  Ct: number[][],
  C0: number[][],
  lambda: number,
): number[][] {
  const N = Ct.length;
  const result: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      result[i][j] = (1 - lambda) * Ct[i][j] + lambda * C0[i][j];
    }
  }
  return result;
}

/**
 * Build prior correlation matrix C0 from prior subspace vectors and full
 * correlation matrix (paper §8.2, equations 10-12).
 *
 * 1. D0 = diag(v_k' Cfull v_k)  — eigenvalue scale along each prior direction
 * 2. C0_raw = Σ_k d_k * v_k v_k'
 * 3. Normalize to correlation matrix: C0[i][j] = C0_raw[i][j] / √(C0_raw[i][i] C0_raw[j][j])
 */
export function priorCorrelationFromSubspace(
  priorVectors: number[][],
  Cfull: number[][],
): number[][] {
  const N = priorVectors[0].length;
  const C0: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));

  for (const v of priorVectors) {
    // d_k = v' Cfull v
    let dk = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        dk += v[i] * Cfull[i][j] * v[j];
      }
    }
    // C0 += d_k * v v'
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        C0[i][j] += dk * v[i] * v[j];
      }
    }
  }

  // Normalize to correlation matrix
  const diagSqrt = C0.map((row, i) => Math.sqrt(Math.max(row[i], 1e-12)));
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      C0[i][j] /= diagSqrt[i] * diagSqrt[j];
    }
  }

  return C0;
}

/**
 * Compute top-K eigenvectors of a symmetric matrix.
 * Returns eigenvectors as rows sorted by descending eigenvalue.
 */
export function topKEigenvectors(mat: number[][], K: number): { values: number[]; vectors: number[][] } {
  const m = matrix(mat);
  const result = eigs(m);

  // mathjs eigs returns { eigenvectors: [{value, vector}, ...] }
  const eigenvectors = result.eigenvectors as Array<{ value: number; vector: { toArray(): number[] } }>;

  // Sort by descending eigenvalue
  const sorted = [...eigenvectors].sort((a, b) => (b.value as number) - (a.value as number));

  const topValues: number[] = [];
  const topVectors: number[][] = [];
  for (let k = 0; k < K; k++) {
    topValues.push(sorted[k].value as number);
    topVectors.push(sorted[k].vector.toArray() as number[]);
  }

  return { values: topValues, vectors: topVectors };
}

/**
 * Gram-Schmidt orthonormalization.
 */
export function orthonormalize(vectors: number[][]): number[][] {
  const result: number[][] = [];
  for (const v of vectors) {
    let u = [...v];
    for (const prev of result) {
      const dot = u.reduce((s, x, i) => s + x * prev[i], 0);
      u = u.map((x, i) => x - dot * prev[i]);
    }
    const n = Math.sqrt(u.reduce((s, x) => s + x * x, 0));
    if (n < 1e-12) continue;
    result.push(u.map((x) => x / n));
  }
  return result;
}
