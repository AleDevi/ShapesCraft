export interface Point { x: number; y: number }

/** Row-major 3×3 matrix. */
export type Mat3 = number[];

export function applyH(h: Mat3, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Singular matrix');
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

function multiply3(a: Mat3, b: Mat3): Mat3 {
  const r: Mat3 = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return r;
}

/** Similarity transform that centres points and scales them to mean distance √2 (Hartley normalisation). */
function normaliser(pts: Point[]): Mat3 {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  const s = Math.SQRT2 / (d || 1);
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Solves the n×n system `a·x = b` in place with partial pivoting. */
export function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    if (Math.abs(a[col][col]) < 1e-14) throw new Error('Singular system');
    for (let r = col + 1; r < n; r++) {
      const k = a[r][col] / a[col][col];
      for (let c = col; c < n; c++) a[r][c] -= k * a[col][c];
      b[r] -= k * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

/**
 * Least-squares homography mapping `src[i]` to `dst[i]` (at least 4 pairs),
 * with h33 fixed to 1 and Hartley normalisation for numerical stability.
 */
export function findHomography(src: Point[], dst: Point[]): Mat3 {
  if (src.length !== dst.length || src.length < 4) throw new Error('At least 4 point pairs are needed');
  const ns = normaliser(src);
  const nd = normaliser(dst);
  const ata = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const s = applyH(ns, src[i]);
    const d = applyH(nd, dst[i]);
    const rows = [
      { r: [s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x], v: d.x },
      { r: [0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y], v: d.y },
    ];
    for (const { r, v } of rows) {
      for (let j = 0; j < 8; j++) {
        atb[j] += r[j] * v;
        for (let k = 0; k < 8; k++) ata[j][k] += r[j] * r[k];
      }
    }
  }
  const hn = [...solve(ata, atb), 1];
  const h = multiply3(invert3(nd), multiply3(hn, ns));
  return h.map((v) => v / h[8]);
}
