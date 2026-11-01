/** Grayscale image with values in 0..1. */
export interface Gray { width: number; height: number; data: Float32Array }

export interface Rgba { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

export function toGray(img: Rgba): Gray {
  const n = img.width * img.height;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    data[i] = (0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) / 255;
  }
  return { width: img.width, height: img.height, data };
}

export function grayToRgba(g: Gray): Rgba {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i] * 255;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: g.width, height: g.height, data };
}

/** Area-average downscale by an integer factor. */
export function downscale(g: Gray, factor: number): Gray {
  if (factor <= 1) return g;
  const w = Math.floor(g.width / factor);
  const h = Math.floor(g.height / factor);
  const data = new Float32Array(w * h);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * g.width + x * factor;
        for (let dx = 0; dx < factor; dx++) s += g.data[row + dx];
      }
      data[y * w + x] = s * inv;
    }
  return { width: w, height: h, data };
}

export function sampleBilinear(g: Gray, x: number, y: number, fallback: number): number {
  if (x < 0 || y < 0 || x > g.width - 1 || y > g.height - 1) return fallback;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, g.width - 1);
  const y1 = Math.min(y0 + 1, g.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = g.data;
  const top = d[y0 * g.width + x0] * (1 - fx) + d[y0 * g.width + x1] * fx;
  const bottom = d[y1 * g.width + x0] * (1 - fx) + d[y1 * g.width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Separable box blur, repeated `passes` times (3 passes ≈ Gaussian). */
export function boxBlur(g: Gray, radius: number, passes = 1): Gray {
  if (radius < 1) return g;
  const { width: w, height: h } = g;
  let src = g.data;
  let tmp = new Float32Array(w * h);
  let dst = new Float32Array(w * h);
  const run = (from: Float32Array, to: Float32Array, len: number, count: number, stride: number, step: number) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += from[base + Math.min(Math.max(i, 0), len - 1) * step];
      for (let i = 0; i < len; i++) {
        to[base + i * step] = sum / (2 * radius + 1);
        const add = Math.min(i + radius + 1, len - 1);
        const sub = Math.max(i - radius, 0);
        sum += from[base + add * step] - from[base + sub * step];
      }
    }
  };
  for (let p = 0; p < passes; p++) {
    run(src, tmp, w, h, w, 1);
    run(tmp, dst, h, w, 1, w);
    src = dst;
    [tmp, dst] = [tmp, new Float32Array(w * h)];
  }
  return { width: w, height: h, data: src };
}

/**
 * Estimates the paper brightness as a smooth quadratic surface fitted to the
 * bright cells of the image, then divides it out. This removes gradients from
 * uneven light while staying robust to large dark objects on the sheet.
 */
export function flattenIllumination(g: Gray, cell: number): Gray {
  const cw = Math.max(1, Math.floor(g.width / cell));
  const ch = Math.max(1, Math.floor(g.height / cell));
  const samples: { x: number; y: number; v: number }[] = [];
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      // The 90th percentile of the cell tracks paper, not ink.
      const vals: number[] = [];
      for (let y = cy * cell; y < (cy + 1) * cell && y < g.height; y++)
        for (let x = cx * cell; x < (cx + 1) * cell && x < g.width; x++) vals.push(g.data[y * g.width + x]);
      if (vals.length < (cell * cell) / 4) continue;
      vals.sort((a, b) => a - b);
      samples.push({ x: (cx + 0.5) / cw, y: (cy + 0.5) / ch, v: vals[Math.floor(vals.length * 0.9)] });
    }
  if (samples.length < 12) return g;

  const basis = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];
  let coef = [samples.reduce((s, p) => s + p.v, 0) / samples.length, 0, 0, 0, 0, 0];
  let active = samples;
  for (let iter = 0; iter < 4; iter++) {
    const ata = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const atb = new Array<number>(6).fill(0);
    for (const p of active) {
      const b = basis(p.x, p.y);
      for (let i = 0; i < 6; i++) {
        atb[i] += b[i] * p.v;
        for (let j = 0; j < 6; j++) ata[i][j] += b[i] * b[j];
      }
    }
    for (let i = 0; i < 6; i++) ata[i][i] += 1e-6;
    coef = solveSmall(ata, atb);
    const evalAt = (p: { x: number; y: number }) => basis(p.x, p.y).reduce((s, b, i) => s + b * coef[i], 0);
    // Cells clearly darker than the fit are covered by the drawing: drop them and refit.
    const next = samples.filter((p) => p.v > evalAt(p) * 0.85);
    if (next.length < 12 || next.length === active.length) break;
    active = next;
  }

  const data = new Float32Array(g.data.length);
  for (let y = 0; y < g.height; y++) {
    const ny = (y + 0.5) / g.height;
    for (let x = 0; x < g.width; x++) {
      const nx = (x + 0.5) / g.width;
      const bg = coef[0] + coef[1] * nx + coef[2] * ny + coef[3] * nx * nx + coef[4] * nx * ny + coef[5] * ny * ny;
      const i = y * g.width + x;
      data[i] = Math.min(1, g.data[i] / Math.max(bg, 0.05));
    }
  }
  return { width: g.width, height: g.height, data };
}

function solveSmall(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = m[r][c] / m[c][c];
      for (let k2 = c; k2 <= n; k2++) m[r][k2] -= k * m[c][k2];
    }
  }
  return m.map((r, i) => r[n] / r[i]);
}

/** Otsu threshold. */
export function otsu(g: Gray): number {
  const bins = 256;
  const hist = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < g.data.length; i++) {
    hist[Math.min(bins - 1, Math.max(0, Math.floor(g.data[i] * (bins - 1))))]++;
    total++;
  }
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = bins / 2;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return (bestT + 0.5) / (bins - 1);
}
