import type { Volume } from './carve';
import { CLEAR_TABLE, OBJECT, ON_PAPER, ON_TABLE, PAPER, UNKNOWN, looksLikePaper, projection, type Backdrop, type View } from './silhouette';

/**
 * Second look at the frames, by colour (the idea of "GrabCut"). A first carving gives
 * the rough shape; seen from each camera it covers the object and a bit more. Then:
 * - the object's colours are learnt inside that outline, all frames together: a few
 *   colour clusters, so a cup with a dark body, a light rim and a coloured logo has a
 *   cluster for each;
 * - the background's colours are learnt away from the outline, frame by frame and
 *   separately for what lies behind: paper, printed ink, table, the rest of the room;
 * - near the outline each pixel goes to whichever explains its colour better, after
 *   comparing it with its neighbours too. Pixels neither side explains clearly stay
 *   undecided, and so cast no vote.
 * Light parts of the object over ink or table, and dark ones over a light table, are no
 * longer lost; a shadow on the paper is learnt as paper.
 */

/** Colour clusters for the object, and for each kind of background. */
const OBJECT_CLUSTERS = 6;
const BACKGROUND_CLUSTERS = 4;
/** Fewer samples than this and a background kind is not modelled: its pixels keep their first reading. */
const MIN_SAMPLES = 150;
/** Samples used to learn each model, at most. */
const MAX_SAMPLES = 20000;
/** How much likelier one side must be (log ratio, after averaging over neighbours) to win the pixel. */
const DECIDE = Math.log(4);
/** Share of the object's own colours that count as unusual for it. */
const ATYPICAL = 0.03;
/** Neighbourhood averaged before deciding, as a radius in pixels at 720 px. */
const SMOOTH = 2;
/** Band around the projected outline that is looked at again, and the core trusted as object, as a share of the frame's longer side. */
const BAND = 0.015;

type Gmm = { w: Float64Array; mean: Float64Array; inv: Float64Array; logNorm: Float64Array; k: number };

/** New silhouette masks from colour models, given the first carving. */
export function colorMasks(views: View[], backdrops: Backdrop[], first: Uint8Array[], volume: Volume): Uint8Array[] {
  const hulls = views.map((v) => hullMask(v, volume));

  // The object: inside the outline (shrunk a little), wherever the first reading wasn't paper.
  const objectSamples: number[] = [];
  const bands: { near: Uint8Array; core: Uint8Array }[] = [];
  const total = views.reduce((s, v) => s + v.image.width * v.image.height, 0);
  views.forEach((v, n) => {
    const { width: w, height: h, data: px } = v.image;
    const r = Math.max(2, Math.round(BAND * Math.max(w, h)));
    const near = grow(hulls[n], w, h, r);
    const core = shrink(hulls[n], w, h, r);
    bands.push({ near, core });
    const white = backdrops[n]?.white;
    if (!white) return;
    const every = Math.max(1, Math.ceil((total / MAX_SAMPLES) * 0.2));
    for (let k = 0; k < w * h; k += every) {
      if (!core[k] || first[n][k] === PAPER) continue;
      const r = px[k * 4] / white[0], g = px[k * 4 + 1] / white[1], b = px[k * 4 + 2] / white[2];
      // Over paper, glints were read as object: they would teach the object the paper's
      // colour. Elsewhere a shiny object's light spots are its own colours.
      if (!(backdrops[n].kind[k] === ON_PAPER && looksLikePaper(r, g, b))) objectSamples.push(r, g, b);
    }
  });
  if (objectSamples.length / 3 < MIN_SAMPLES) return first;
  const objectColors = thin(objectSamples, MAX_SAMPLES);
  const object = fit(objectColors, OBJECT_CLUSTERS);
  // How unlikely a colour must be for the object before a pixel can be called background:
  // a colour the object also has stays undecided, even if the background has it more.
  const typical: number[] = [];
  for (let i = 0; i < objectColors.length; i += 3) typical.push(logLikelihood(object, objectColors[i], objectColors[i + 1], objectColors[i + 2]));
  typical.sort((a, b) => a - b);
  const atypical = typical[Math.floor(typical.length * ATYPICAL)];

  return views.map((v, n) => {
    const { kind, white } = backdrops[n] ?? {};
    const old = first[n];
    if (!white || !kind) return old;
    const { width: w, height: h, data: px } = v.image;
    const { near } = bands[n];
    const color = (k: number): [number, number, number] => [px[k * 4] / white[0], px[k * 4 + 1] / white[1], px[k * 4 + 2] / white[2]];

    // Background models for this frame, one per kind of thing behind.
    const group = (k: number) => (kind[k] === CLEAR_TABLE ? ON_TABLE : kind[k]);
    const samples: number[][] = [[], [], [], []];
    for (let k = 0; k < w * h; k += 2) if (!near[k]) samples[group(k)].push(...color(k));
    const models = samples.map((s) => (s.length / 3 >= MIN_SAMPLES ? fit(thin(s, MAX_SAMPLES), BACKGROUND_CLUSTERS) : null));

    // Log-likelihood ratio, object over background, near the outline.
    const llr = new Float32Array(w * h);
    const own = new Float32Array(w * h);
    const known = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      if (!near[k]) continue;
      const bg = models[group(k)];
      if (!bg) continue;
      const [r, g, b] = color(k);
      const lo = logLikelihood(object, r, g, b);
      own[k] = Math.max(atypical - 12, lo);
      llr[k] = Math.max(-12, Math.min(12, lo - logLikelihood(bg, r, g, b)));
      known[k] = 1;
    }
    const s = Math.max(1, Math.round((SMOOTH * Math.max(w, h)) / 720));
    const avg = boxMean(llr, known, w, h, s);
    const avgOwn = boxMean(own, known, w, h, s);

    const mask = Uint8Array.from(old);
    for (let k = 0; k < w * h; k++) {
      if (!near[k] || !known[k]) continue;
      // Glints on a shiny object look like paper: the first reading already filled them in.
      if (old[k] === OBJECT && kind[k] === ON_PAPER && looksLikePaper(...color(k))) continue;
      mask[k] = avg[k] >= DECIDE ? OBJECT : avg[k] <= -DECIDE && avgOwn[k] < atypical ? PAPER : UNKNOWN;
    }
    return mask;
  });
}

/** Where the carved shape falls in the frame. */
export function hullMask(v: View, vol: Volume): Uint8Array {
  const { width: w, height: h } = v.image;
  const mask = new Uint8Array(w * h);
  const P = projection(v);
  const { nx, ny, nz, voxel, origin, data } = vol;
  const filled = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && data[i + nx * (j + ny * k)] === 1;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!filled(i, j, k)) continue;
        // Only cubes on the surface show.
        if (filled(i - 1, j, k) && filled(i + 1, j, k) && filled(i, j - 1, k) && filled(i, j + 1, k) && filled(i, j, k - 1) && filled(i, j, k + 1)) continue;
        const x = origin.x + i * voxel, y = origin.y + j * voxel, z = origin.z - k * voxel;
        const Z = P[8] * x + P[9] * y + P[10] * z + P[11];
        if (Z <= 0) continue;
        const u = (P[0] * x + P[1] * y + P[2] * z + P[3]) / Z;
        const vv = (P[4] * x + P[5] * y + P[6] * z + P[7]) / Z;
        // The cube's size on screen, as a square of about the same area.
        const half = Math.max(0.5, (0.6 * voxel * v.focal) / Z);
        const u0 = Math.max(0, Math.floor(u - half)), u1 = Math.min(w - 1, Math.floor(u + half));
        const v0 = Math.max(0, Math.floor(vv - half)), v1 = Math.min(h - 1, Math.floor(vv + half));
        for (let y2 = v0; y2 <= v1; y2++) mask.fill(1, y2 * w + u0, y2 * w + u1 + 1);
      }
  return mask;
}

/** Square dilation by r pixels. */
function grow(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const sum = boxSum(m, w, h, r);
  const out = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) out[k] = sum[k] > 0 ? 1 : 0;
  return out;
}

/** Square erosion by r pixels (outside the frame counts as empty). */
function shrink(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const sum = boxSum(m, w, h, r);
  const out = new Uint8Array(w * h);
  const full = (2 * r + 1) ** 2;
  for (let k = 0; k < w * h; k++) out[k] = sum[k] >= full ? 1 : 0;
  return out;
}

/** Sum over the (2r+1)² square around each pixel, cut at the frame's edges. */
function boxSum(m: ArrayLike<number>, w: number, h: number, r: number): Float64Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += m[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    }
  }
  return out;
}

/** Mean of `v` over the known pixels of the square around each pixel. */
function boxMean(v: Float32Array, known: Uint8Array, w: number, h: number, r: number): Float32Array {
  const s = boxSum(v, w, h, r), c = boxSum(known, w, h, r);
  const out = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) out[k] = c[k] ? s[k] / c[k] : 0;
  return out;
}

/** At most `max` colours (r, g, b triples), evenly picked. */
function thin(s: number[], max: number): Float64Array {
  const n = s.length / 3;
  if (n <= max) return Float64Array.from(s);
  const out = new Float64Array(max * 3);
  for (let i = 0; i < max; i++) {
    const q = Math.floor((i * n) / max) * 3;
    out[i * 3] = s[q];
    out[i * 3 + 1] = s[q + 1];
    out[i * 3 + 2] = s[q + 2];
  }
  return out;
}

/** Gaussian mixture of `k` clusters with full 3×3 covariances: k-means to start, then EM. */
export function fit(x: Float64Array, k: number): Gmm {
  const n = x.length / 3;
  k = Math.max(1, Math.min(k, Math.floor(n / 20)));
  // k-means++ style start, deterministic: each new centre is the colour farthest from the others.
  const mean = new Float64Array(k * 3);
  mean.set(x.subarray(0, 3));
  const d2 = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let far = 0;
    for (let i = 0; i < n; i++) {
      const p = c - 1;
      const d = (x[i * 3] - mean[p * 3]) ** 2 + (x[i * 3 + 1] - mean[p * 3 + 1]) ** 2 + (x[i * 3 + 2] - mean[p * 3 + 2]) ** 2;
      if (d < d2[i]) d2[i] = d;
      if (d2[i] > d2[far]) far = i;
    }
    mean.set(x.subarray(far * 3, far * 3 + 3), c * 3);
  }
  const label = new Int32Array(n);
  for (let it = 0; it < 6; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (x[i * 3] - mean[c * 3]) ** 2 + (x[i * 3 + 1] - mean[c * 3 + 1]) ** 2 + (x[i * 3 + 2] - mean[c * 3 + 2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      label[i] = best;
    }
    const sum = new Float64Array(k * 4);
    for (let i = 0; i < n; i++) {
      const c = label[i];
      sum[c * 4] += x[i * 3]; sum[c * 4 + 1] += x[i * 3 + 1]; sum[c * 4 + 2] += x[i * 3 + 2]; sum[c * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) if (sum[c * 4 + 3]) for (let a = 0; a < 3; a++) mean[c * 3 + a] = sum[c * 4 + a] / sum[c * 4 + 3];
  }
  // Responsibilities from the k-means labels, then a few EM rounds.
  let resp: Float64Array = new Float64Array(n * k);
  for (let i = 0; i < n; i++) resp[i * k + label[i]] = 1;
  let gmm = mStep(x, resp, k);
  for (let it = 0; it < 8; it++) {
    resp = eStep(x, gmm);
    gmm = mStep(x, resp, k);
  }
  return gmm;
}

/** Smallest spread of a cluster, per channel: camera noise and JPEG blocks. */
const MIN_VAR = 0.02 ** 2;

function mStep(x: Float64Array, resp: Float64Array, k: number): Gmm {
  const n = x.length / 3;
  const w = new Float64Array(k), mean = new Float64Array(k * 3), inv = new Float64Array(k * 9), logNorm = new Float64Array(k);
  for (let c = 0; c < k; c++) {
    let s = 0, m0 = 0, m1 = 0, m2 = 0;
    for (let i = 0; i < n; i++) {
      const r = resp[i * k + c];
      s += r; m0 += r * x[i * 3]; m1 += r * x[i * 3 + 1]; m2 += r * x[i * 3 + 2];
    }
    if (s < 1e-9) {
      w[c] = 0;
      logNorm[c] = -Infinity;
      continue;
    }
    m0 /= s; m1 /= s; m2 /= s;
    const C = new Float64Array(9);
    for (let i = 0; i < n; i++) {
      const r = resp[i * k + c];
      if (!r) continue;
      const d = [x[i * 3] - m0, x[i * 3 + 1] - m1, x[i * 3 + 2] - m2];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += r * d[a] * d[b];
    }
    for (let a = 0; a < 9; a++) C[a] /= s;
    for (let a = 0; a < 3; a++) C[a * 4] += MIN_VAR;
    const det = C[0] * (C[4] * C[8] - C[5] * C[7]) - C[1] * (C[3] * C[8] - C[5] * C[6]) + C[2] * (C[3] * C[7] - C[4] * C[6]);
    const I = [
      (C[4] * C[8] - C[5] * C[7]) / det, (C[2] * C[7] - C[1] * C[8]) / det, (C[1] * C[5] - C[2] * C[4]) / det,
      (C[5] * C[6] - C[3] * C[8]) / det, (C[0] * C[8] - C[2] * C[6]) / det, (C[2] * C[3] - C[0] * C[5]) / det,
      (C[3] * C[7] - C[4] * C[6]) / det, (C[1] * C[6] - C[0] * C[7]) / det, (C[0] * C[4] - C[1] * C[3]) / det,
    ];
    w[c] = s / n;
    mean.set([m0, m1, m2], c * 3);
    inv.set(I, c * 9);
    logNorm[c] = Math.log(w[c]) - 0.5 * Math.log(Math.max(det, 1e-30)) - 1.5 * Math.log(2 * Math.PI);
  }
  return { w, mean, inv, logNorm, k };
}

function componentLog(g: Gmm, c: number, r: number, gr: number, b: number): number {
  if (g.logNorm[c] === -Infinity) return -Infinity;
  const d0 = r - g.mean[c * 3], d1 = gr - g.mean[c * 3 + 1], d2 = b - g.mean[c * 3 + 2];
  const I = g.inv, o = c * 9;
  const q = d0 * (I[o] * d0 + I[o + 1] * d1 + I[o + 2] * d2) + d1 * (I[o + 3] * d0 + I[o + 4] * d1 + I[o + 5] * d2) + d2 * (I[o + 6] * d0 + I[o + 7] * d1 + I[o + 8] * d2);
  return g.logNorm[c] - 0.5 * q;
}

function eStep(x: Float64Array, g: Gmm): Float64Array {
  const n = x.length / 3, k = g.k;
  const resp = new Float64Array(n * k);
  const l = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    let top = -Infinity;
    for (let c = 0; c < k; c++) {
      l[c] = componentLog(g, c, x[i * 3], x[i * 3 + 1], x[i * 3 + 2]);
      if (l[c] > top) top = l[c];
    }
    let s = 0;
    for (let c = 0; c < k; c++) s += (l[c] = Math.exp(l[c] - top));
    for (let c = 0; c < k; c++) resp[i * k + c] = l[c] / s;
  }
  return resp;
}

/** Log-density of a colour under the mixture. */
export function logLikelihood(g: Gmm, r: number, gr: number, b: number): number {
  let top = -Infinity;
  const l: number[] = [];
  for (let c = 0; c < g.k; c++) {
    const v = componentLog(g, c, r, gr, b);
    l.push(v);
    if (v > top) top = v;
  }
  if (top === -Infinity) return -1e9;
  let s = 0;
  for (const v of l) s += Math.exp(v - top);
  return top + Math.log(s);
}
