import { AR } from '../vendor/js-aruco2/aruco.js';
import { DICTIONARY, MARKER_IDS, markerCorners, workArea, type FrameLayout } from './frame';
import { applyH, findHomography, type Mat3, type Point } from './homography';
import {
  boxBlur,
  downscale,
  flattenIllumination,
  grayToRgba,
  otsu,
  sampleBilinear,
  type Gray,
} from './image';
import { isoContours, signedArea, simplifyClosed, smoothPath, type PathShape } from './trace';

export interface Detection {
  /** Maps sheet millimetres to photo pixels. */
  sheetToPhoto: Mat3;
  markerIds: number[];
  /** Mean reprojection error of the marker corners, in photo pixels. */
  errorPx: number;
}

/** Longest side used for marker detection; larger photos are downscaled first. */
const DETECT_MAX_SIDE = 2000;

export function detectFrame(photo: Gray, frame: FrameLayout): Detection {
  const factor = Math.max(1, Math.ceil(Math.max(photo.width, photo.height) / DETECT_MAX_SIDE));
  const small = downscale(photo, factor);
  const detector = new AR.Detector({ dictionaryName: DICTIONARY });
  const markers = detector.detect(grayToRgba(small));

  const expected = markerCorners(frame);
  const src: Point[] = [];
  const dst: Point[] = [];
  const ids: number[] = [];
  for (const id of MARKER_IDS) {
    // Keep the most confident detection of each id.
    const found = markers.filter((m) => m.id === id).sort((a, b) => a.hammingDistance - b.hammingDistance)[0];
    if (!found) continue;
    ids.push(id);
    // Detector coordinates are integer pixel indices of the low-res image; the
    // pixel centre is at +0.5. Edge refinement then recovers sub-pixel corners.
    const rough = found.corners.map((c) => ({ x: (c.x + 0.5) * factor, y: (c.y + 0.5) * factor }));
    const refined = refineQuad(photo, rough, 2 * factor + 2);
    refined.forEach((c, i) => {
      src.push(expected[id][i]);
      dst.push(c);
    });
  }
  if (ids.length < 3) {
    throw new Error(
      `Cornice non trovata: riconosciuti ${ids.length} marker su 4. ` +
        'Inquadra tutto il foglio, evita riflessi e ombre sui quadrati neri.',
    );
  }
  const sheetToPhoto = findHomography(src, dst);
  const errorPx = src.reduce((s, p, i) => {
    const q = applyH(sheetToPhoto, p);
    return s + Math.hypot(q.x - dst[i].x, q.y - dst[i].y);
  }, 0) / src.length;
  return { sheetToPhoto, markerIds: ids, errorPx };
}

/**
 * Sharpens a marker quad to sub-pixel accuracy: each side is re-located by
 * finding the strongest intensity step along its normal at many points, a line
 * is fitted through them, and the corners become the line intersections.
 */
export function refineQuad(img: Gray, quad: Point[], search: number): Point[] {
  const lines: { p: Point; d: Point }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const n = { x: -d.y, y: d.x };
    const hits: Point[] = [];
    const samples = Math.max(8, Math.round(len / 3));
    for (let k = 1; k < samples; k++) {
      const t = 0.15 + (0.7 * k) / samples; // stay clear of the corners
      const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const step = 0.5;
      const prof: number[] = [];
      for (let o = -search; o <= search; o += step) prof.push(sampleBilinear(img, base.x + n.x * o - 0.5, base.y + n.y * o - 0.5, 1));
      let best = -1;
      let bestG = 0;
      for (let j = 1; j < prof.length - 1; j++) {
        const g = Math.abs(prof[j + 1] - prof[j - 1]);
        if (g > bestG) {
          bestG = g;
          best = j;
        }
      }
      if (best < 2 || best > prof.length - 3 || bestG < 0.1) continue;
      const gm = Math.abs(prof[best] - prof[best - 2]);
      const gp = Math.abs(prof[best + 2] - prof[best]);
      const denom = gm - 2 * bestG + gp;
      const shift = denom !== 0 ? (0.5 * (gm - gp)) / denom : 0;
      const o = -search + (best + Math.max(-0.5, Math.min(0.5, shift))) * step;
      hits.push({ x: base.x + n.x * o, y: base.y + n.y * o });
    }
    if (hits.length < 4) return quad;
    lines.push(fitLine(hits));
  }
  const out: Point[] = [];
  for (let i = 0; i < 4; i++) {
    // Corner i is shared by side i-1 (ending there) and side i (starting there).
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p || Math.hypot(p.x - quad[i].x, p.y - quad[i].y) > search * 2) return quad;
    out.push(p);
  }
  return out;
}

function fitLine(pts: Point[]): { p: Point; d: Point } {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    sxx += (p.x - cx) ** 2;
    sxy += (p.x - cx) * (p.y - cy);
    syy += (p.y - cy) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: cx, y: cy }, d: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function intersect(l1: { p: Point; d: Point }, l2: { p: Point; d: Point }): Point | null {
  const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
  return { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
}

export interface Rectified {
  gray: Gray;
  /** Sheet-mm position of the top-left of pixel (0,0). */
  origin: Point;
  pxPerMm: number;
}

/** Resamples the frame window into a fronto-parallel image at `pxPerMm`. */
export function rectify(photo: Gray, frame: FrameLayout, det: Detection, pxPerMm: number): Rectified {
  const area = workArea(frame);
  const width = Math.round(area.w * pxPerMm);
  const height = Math.round(area.h * pxPerMm);
  const data = new Float32Array(width * height);
  const h = det.sheetToPhoto;
  for (let y = 0; y < height; y++) {
    const my = area.y + (y + 0.5) / pxPerMm;
    for (let x = 0; x < width; x++) {
      const mx = area.x + (x + 0.5) / pxPerMm;
      const w = h[6] * mx + h[7] * my + h[8];
      const px = (h[0] * mx + h[1] * my + h[2]) / w;
      const py = (h[3] * mx + h[4] * my + h[5]) / w;
      // Photo pixel (i, j) covers [i, i+1); its sample sits at the centre.
      data[y * width + x] = sampleBilinear(photo, px - 0.5, py - 0.5, 1);
    }
  }
  return { gray: { width, height, data }, origin: { x: area.x, y: area.y }, pxPerMm };
}

export interface Prepared {
  /** Illumination-corrected image. */
  field: Gray;
  autoThreshold: number;
}

/** Normalises lighting so a single threshold works across the whole sheet. */
export function prepare(r: Rectified): Prepared {
  const flat = flattenIllumination(r.gray, Math.round(10 * r.pxPerMm));
  const t = otsu(flat);
  // A nearly blank sheet makes Otsu split paper noise; keep the threshold in a sane band.
  return { field: flat, autoThreshold: Math.min(0.8, Math.max(0.35, t)) };
}

export interface TraceOptions {
  threshold: number;
  /** Trace bright shapes on a dark background instead. */
  invert: boolean;
  /** Smallest shape kept, in mm². */
  minAreaMm2: number;
  /** Maximum deviation from the traced edge, in mm. */
  toleranceMm: number;
  /** Angles sharper than this stay corners instead of being smoothed. */
  cornerDeg: number;
  /** Noise-reduction blur radius, in mm. */
  blurMm: number;
}

export const DEFAULT_TRACE: Omit<TraceOptions, 'threshold'> = {
  invert: false,
  minAreaMm2: 4,
  toleranceMm: 0.2,
  cornerDeg: 50,
  blurMm: 0.3,
};

/** Traced outlines in sheet millimetres. */
export interface Traced {
  shapes: PathShape[];
  polygons: Point[][];
}

export function trace(p: Prepared, r: Rectified, opts: TraceOptions): Traced {
  let field = p.field;
  let level = opts.threshold;
  if (opts.invert) {
    const data = new Float32Array(field.data.length);
    for (let i = 0; i < data.length; i++) data[i] = 1 - field.data[i];
    field = { ...field, data };
    level = 1 - level;
  }
  field = boxBlur(field, Math.round(opts.blurMm * r.pxPerMm), 2);

  const toMm = (q: Point): Point => ({ x: r.origin.x + q.x / r.pxPerMm, y: r.origin.y + q.y / r.pxPerMm });
  const minAreaPx = opts.minAreaMm2 * r.pxPerMm * r.pxPerMm;
  const polygons: Point[][] = [];
  for (const loop of isoContours(field, level)) {
    if (Math.abs(signedArea(loop)) < minAreaPx) continue;
    const simple = simplifyClosed(loop, opts.toleranceMm * r.pxPerMm);
    if (simple.length < 3) continue;
    polygons.push(simple.map(toMm));
  }
  return { polygons, shapes: polygons.map((poly) => smoothPath(poly, opts.cornerDeg, 1)) };
}
