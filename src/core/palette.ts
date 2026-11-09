import type { Gray, Rgba } from './image';

/**
 * Colour mode for 2D: the ink on the sheet is split into a few colours, each
 * of which is then traced as its own layer. Paper stays paper: the same
 * threshold as black and white decides it, plus clearly coloured pixels that
 * are too light for the threshold (yellow, pastel) count as ink too.
 */

/** sRGB 0..1 to CIE L*a*b* (D65), where distances roughly match how different colours look. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  const R = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const G = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const B = 0.0557 * x - 0.204 * y + 1.057 * z;
  const gam = (c: number) => Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return [gam(R), gam(G), gam(B)];
}

export function hex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

/** Pixels this colourful (L*a*b* chroma) count as ink even when lighter than the threshold. */
const INK_CHROMA = 20;
/** Colours with less than this share of the ink are noise (mostly blended edges) and are merged away. */
const MIN_SHARE = 0.01;
/** Most ink pixels used to learn the colours; the rest are only assigned. */
const MAX_SAMPLES = 40_000;

export interface Palette {
  /** Per pixel: index into `colors`, or -1 for paper. */
  labels: Int8Array;
  width: number;
  height: number;
  /** The colours found, darkest first, as #rrggbb. */
  colors: string[];
}

/**
 * Reduces the ink to at most `count` colours.
 * `colour` is the straightened photo, `flat` its illumination-corrected grey
 * (both the same size), `threshold` the black-and-white threshold.
 */
export function quantize(colour: Rgba, flat: Gray, threshold: number, invert: boolean, count: number): Palette {
  const { width, height } = flat;
  const n = width * height;
  const gray = (i: number) => (0.299 * colour.data[i * 4] + 0.587 * colour.data[i * 4 + 1] + 0.114 * colour.data[i * 4 + 2]) / 255;

  // Same lighting correction as the grey image, then white balance on the paper.
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const gain = Math.min(4, flat.data[i] / Math.max(gray(i), 0.02));
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = (colour.data[i * 4 + c] / 255) * gain;
  }
  const white = [0, 0, 0];
  let papers = 0;
  if (!invert)
    for (let i = 0; i < n; i++) {
      if (flat.data[i] < 0.9) continue;
      for (let c = 0; c < 3; c++) white[c] += rgb[i * 3 + c];
      papers++;
    }
  // On a dark background (inverted) there is no paper to balance on.
  const balance = papers > n / 50 ? white.map((v) => Math.max(0.2, v / papers)) : [1, 1, 1];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.min(1, rgb[i * 3 + c] / balance[c]);

  // Lab, lightly blurred (3×3) so sensor noise doesn't speckle the colours.
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) lab.set(rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]), i * 3);
  const smooth = new Float32Array(n * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s0 = 0, s1 = 0, s2 = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = (yy * width + xx) * 3;
          s0 += lab[j]; s1 += lab[j + 1]; s2 += lab[j + 2]; k++;
        }
      }
      const o = (y * width + x) * 3;
      smooth[o] = s0 / k; smooth[o + 1] = s1 / k; smooth[o + 2] = s2 / k;
    }

  const labels = new Int8Array(n).fill(-1);
  const ink: number[] = [];
  for (let i = 0; i < n; i++) {
    const dark = invert ? flat.data[i] > threshold : flat.data[i] < threshold;
    const chroma = Math.hypot(smooth[i * 3 + 1], smooth[i * 3 + 2]);
    if (dark || (!invert && chroma > INK_CHROMA)) ink.push(i);
  }
  if (!ink.length) return { labels, width, height, colors: [] };

  const step = Math.max(1, Math.floor(ink.length / MAX_SAMPLES));
  const samples: number[] = [];
  for (let k = 0; k < ink.length; k += step) samples.push(ink[k]);
  let centres = kmeans(smooth, samples, Math.max(1, Math.min(count, samples.length)));

  // Drop colours that hardly occur and learn the rest again without them.
  for (;;) {
    const sizes = new Array(centres.length).fill(0);
    for (const i of samples) sizes[nearest(smooth, i, centres)]++;
    const keep = centres.filter((_, c) => sizes[c] >= MIN_SHARE * samples.length);
    if (keep.length === centres.length || !keep.length) break;
    centres = refine(smooth, samples, keep);
  }
  centres.sort((a, b) => a[0] - b[0]);

  for (const i of ink) labels[i] = nearest(smooth, i, centres);
  majority(labels, width, height, centres.length);
  return { labels, width, height, colors: centres.map((c) => hex(labToRgb(c[0], c[1], c[2]))) };
}

type Centre = [number, number, number];

function dist2(lab: Float32Array, i: number, c: Centre) {
  const o = i * 3;
  return (lab[o] - c[0]) ** 2 + (lab[o + 1] - c[1]) ** 2 + (lab[o + 2] - c[2]) ** 2;
}

function nearest(lab: Float32Array, i: number, centres: Centre[]) {
  let best = 0, bd = Infinity;
  for (let c = 0; c < centres.length; c++) {
    const d = dist2(lab, i, centres[c]);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** k-means++ with a fixed seed, so the same photo always gives the same colours. */
function kmeans(lab: Float32Array, samples: number[], k: number): Centre[] {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const at = (i: number): Centre => [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
  // Start from the darkest ink: it is nearly always one of the colours.
  let first = samples[0];
  for (const i of samples) if (lab[i * 3] < lab[first * 3]) first = i;
  const centres: Centre[] = [at(first)];
  const d = samples.map((i) => dist2(lab, i, centres[0]));
  while (centres.length < k) {
    const total = d.reduce((s, v) => s + v, 0);
    if (total <= 0) break;
    let r = rand() * total;
    let pick = 0;
    while (pick < d.length - 1 && (r -= d[pick]) > 0) pick++;
    centres.push(at(samples[pick]));
    for (let j = 0; j < samples.length; j++) d[j] = Math.min(d[j], dist2(lab, samples[j], centres[centres.length - 1]));
  }
  return refine(lab, samples, centres);
}

function refine(lab: Float32Array, samples: number[], start: Centre[]): Centre[] {
  let centres = start.map((c) => [...c] as Centre);
  for (let iter = 0; iter < 20; iter++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const i of samples) {
      const s = sum[nearest(lab, i, centres)];
      s[0] += lab[i * 3]; s[1] += lab[i * 3 + 1]; s[2] += lab[i * 3 + 2]; s[3]++;
    }
    let moved = 0;
    const next = centres.map((c, j): Centre => {
      const s = sum[j];
      if (!s[3]) return c;
      const m: Centre = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
      moved = Math.max(moved, Math.hypot(m[0] - c[0], m[1] - c[1], m[2] - c[2]));
      return m;
    });
    centres = next;
    if (moved < 0.1) break;
  }
  return centres;
}

/**
 * Each ink pixel takes the most common colour of the ink around it (3×3), twice:
 * the blended rim where two colours or ink and paper meet stops forming thin
 * slivers of a third colour.
 */
function majority(labels: Int8Array, w: number, h: number, k: number) {
  if (k < 2) return;
  const votes = new Int32Array(k);
  for (let pass = 0; pass < 2; pass++) {
    const src = labels.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (src[i] < 0) continue;
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const l = src[yy * w + xx];
            if (l >= 0) votes[l]++;
          }
        }
        let best = src[i];
        for (let c = 0; c < k; c++) if (votes[c] > votes[best]) best = c;
        labels[i] = best;
      }
  }
}
