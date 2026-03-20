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
  for (let i = 0; i < N; i++) stds[i] = Math.sqrt(stds[i] / (T - 1));

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
      corr[i][j] = s / (T - 1);
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
 * Build prior correlation matrix C0 from prior subspace vectors.
 * C0 = V_prior @ V_prior^T (projection onto prior subspace).
 */
export function priorCorrelationFromSubspace(priorVectors: number[][]): number[][] {
  const N = priorVectors[0].length;
  const C0: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));

  for (const v of priorVectors) {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        C0[i][j] += v[i] * v[j];
      }
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
