import type { Point } from '../core/homography';
import type { Rgba } from '../core/image';
import { matDrawing, type MatLayout } from './mat';
import type { Pose } from './pose';

/**
 * Where the object is in each frame. The app knows exactly what the printed mat looks
 * like and, from the camera pose, where each of its points falls in the frame: a pixel
 * that should show white paper but doesn't, shows the object (or something else
 * standing on the mat). Around the mat, the table is learnt from the frames themselves,
 * where the object can't be in the way: elsewhere, a pixel with a colour the table has
 * and the object hasn't is table.
 * Pixels that should show ink, or that can't be told apart, are left out.
 */

/** Pixel classes of a silhouette mask. */
export const UNKNOWN = 0;
/** Plain background: paper or table. */
export const PAPER = 1;
export const OBJECT = 2;

/** Map of the printed mat at a few cells per millimetre: 0 = off the paper, 1 = white paper, 2 = ink. */
export interface PaperMap { mat: MatLayout; perMm: number; width: number; height: number; data: Uint8Array }

const PER_MM = 2;
/** Clearance around ink, in mm: covers blur and small pose errors. */
const INK_MARGIN = 1;
/** White cells of the markers count as paper, away from their edges by this much, in mm. */
const CELL_INSET = 0.7;
/** Clearance from the paper edge, in mm: the edge may be cut unevenly. */
const EDGE_MARGIN = 3;
/** The table is learnt and used from this far to this far from the paper's edge, in mm. */
const TABLE_NEAR = 5;
const TABLE_FAR = 150;

const maps = new Map<string, PaperMap>();

export function paperMap(mat: MatLayout): PaperMap {
  const cached = maps.get(mat.id);
  if (cached) return cached;
  const width = Math.ceil(mat.width * PER_MM);
  const height = Math.ceil(mat.height * PER_MM);
  const data = new Uint8Array(width * height);
  const at = (i: number) => (i + 0.5) / PER_MM;

  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) data[j * width + i] = outside(mat, at(i), at(j)) < -EDGE_MARGIN ? 1 : 0;

  const mark = (pts: Point[], value: number, test: (x: number, y: number) => boolean) => {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - 2) * PER_MM)), i1 = Math.min(width - 1, Math.ceil((Math.max(...xs) + 2) * PER_MM));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - 2) * PER_MM)), j1 = Math.min(height - 1, Math.ceil((Math.max(...ys) + 2) * PER_MM));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) if (data[j * width + i] && test(at(i), at(j))) data[j * width + i] = value;
  };

  // The labels differ by language: keep clear of the longest text that could be printed there.
  const ops = matDrawing(mat, { title: 'x'.repeat(40), scale: 'x'.repeat(40), place: 'x'.repeat(26), cut: 'x'.repeat(50) });
  for (const op of ops) {
    if (op.kind === 'poly' && op.gray < 0.5) mark(op.points, 2, (x, y) => convexDistance(op.points, x, y) < INK_MARGIN);
    else if (op.kind === 'line') {
      const m = op.width / 2 + INK_MARGIN;
      const ends = [{ x: op.x1, y: op.y1 }, { x: op.x2, y: op.y2 }];
      mark(ends, 2, (x, y) => segmentDistance(x, y, op.x1, op.y1, op.x2, op.y2) < m);
    } else if (op.kind === 'text') {
      const half = op.body.length * op.size * 0.3 + INK_MARGIN;
      const box = [{ x: op.x - half, y: op.y - op.size - INK_MARGIN }, { x: op.x + half, y: op.y + op.size * 0.35 + INK_MARGIN }];
      mark(box, 2, (x, y) => x >= box[0].x && x <= box[1].x && y >= box[0].y && y <= box[1].y);
    }
  }
  // White cells inside the markers are paper too, away from their edges.
  for (const op of ops)
    if (op.kind === 'poly' && op.gray >= 0.5) mark(op.points, 1, (x, y) => convexDistance(op.points, x, y) < -CELL_INSET);

  const map = { mat, perMm: PER_MM, width, height, data };
  maps.set(mat.id, map);
  return map;
}

/** Signed distance from the edge of the mat's paper: negative inside. */
function outside(mat: MatLayout, x: number, y: number): number {
  if (mat.round) return Math.hypot(x - mat.center.x, y - mat.center.y) - mat.round.cut;
  const dx = Math.max(-x, x - mat.width), dy = Math.max(-y, y - mat.height);
  return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
}

/** Signed distance from a convex polygon's edges (either winding): negative inside. */
function convexDistance(pts: Point[], x: number, y: number): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  const s = Math.sign(area) || 1;
  let d = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const l = Math.hypot(ex, ey) || 1;
    // Outward normal for a counter-clockwise (s > 0) polygon is (ey, −ex).
    d = Math.max(d, (s * ((x - a.x) * ey - (y - a.y) * ex)) / l);
  }
  return d;
}

function segmentDistance(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const k = l2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2)) : 0;
  return Math.hypot(x - x1 - k * dx, y - y1 - k * dy);
}

/** One frame for carving: a small colour copy and where the camera was. */
export interface View {
  image: Rgba;
  pose: Pose;
  /** Focal length in pixels of `image`. */
  focal: number;
}

/** 3×4 projection matrix mat mm → image pixels, principal point at the image centre. */
export function projection(v: View): Float64Array {
  const { R, t } = v.pose;
  const f = v.focal, cx = v.image.width / 2, cy = v.image.height / 2;
  const P = new Float64Array(12);
  for (let c = 0; c < 3; c++) {
    P[c] = f * R[c] + cx * R[6 + c];
    P[4 + c] = f * R[3 + c] + cy * R[6 + c];
    P[8 + c] = R[6 + c];
  }
  P[3] = f * t[0] + cx * t[2];
  P[7] = f * t[1] + cy * t[2];
  P[11] = t[2];
  return P;
}

/** Brightness at least this fraction of the paper's, and nearly as neutral: paper (maybe in a soft shadow). */
const MIN_BRIGHTNESS = 0.55;
const MAX_TINT = 0.16;

/** What the table plane holds under each pixel: 0 nothing usable, 1 paper, 3 table. */
const ON_PAPER = 1;
const ON_TABLE = 3;
/** Table that the object can't hide from this camera: what the table looks like is learnt there. */
const CLEAR_TABLE = 4;

/** Colours, relative to the paper of the frame, in a coarse 12×12×12 grid. */
const BINS = 12;
function bin(r: number, g: number, b: number): number {
  const q = (v: number) => Math.min(BINS - 1, Math.floor((v / 1.25) * BINS));
  return q(r) + BINS * (q(g) + BINS * q(b));
}
/** Colours the table shows this often and the object hardly ever are table. */
const TABLE_SHARE = 0.004;
const TABLE_OVER_OBJECT = 3;

interface Prepared { kind: Uint8Array; white: number[] | null }

/** The space the object can take: a vertical cylinder standing on the mat, in mat mm. */
export interface Reach { x: number; y: number; radius: number; height: number }

/** True when nothing inside `reach` can stand between the camera `c` and the table point (tx, ty). */
function clearOf(reach: Reach, c: number[], tx: number, ty: number): boolean {
  // Points c + s·(t − c); z goes from c[2] (above the table, negative) to 0.
  const s0 = Math.max(0, 1 - reach.height / -c[2]);
  const ox = c[0] - reach.x, oy = c[1] - reach.y;
  const dx = tx - c[0], dy = ty - c[1];
  const a = dx * dx + dy * dy;
  const s = Math.min(1, Math.max(s0, a ? -(ox * dx + oy * dy) / a : s0));
  return Math.hypot(ox + s * dx, oy + s * dy) > reach.radius;
}

function prepare(v: View, map: PaperMap, reach: Reach): Prepared {
  const { width: w, height: h, data: px } = v.image;
  const P = projection(v);
  const { R, t } = v.pose;
  const cam = [0, 1, 2].map((i) => -(R[i] * t[0] + R[3 + i] * t[1] + R[6 + i] * t[2]));
  // Image → mat plane (z = 0): inverse of the homography made of columns 0, 1 and 3 of P.
  const H = invert3([P[0], P[1], P[3], P[4], P[5], P[7], P[8], P[9], P[11]]);
  const kind = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x + 0.5, vv = y + 0.5;
      const d = H[6] * u + H[7] * vv + H[8];
      const mx = (H[0] * u + H[1] * vv + H[2]) / d;
      const my = (H[3] * u + H[4] * vv + H[5]) / d;
      // Rays above the horizon meet the table plane behind the camera.
      if (P[8] * mx + P[9] * my + P[11] <= 0) continue;
      const i = Math.floor(mx * map.perMm), j = Math.floor(my * map.perMm);
      const m = i >= 0 && j >= 0 && i < map.width && j < map.height ? map.data[j * map.width + i] : 0;
      if (m === 1) kind[y * w + x] = ON_PAPER;
      else if (m === 0) {
        const out = outside(map.mat, mx, my);
        if (out > TABLE_NEAR && out < TABLE_FAR) kind[y * w + x] = clearOf(reach, cam, mx, my) ? CLEAR_TABLE : ON_TABLE;
      }
    }

  // The colour of the paper in this frame (light and white balance differ between frames).
  const samples: number[][] = [[], [], []];
  for (let k = 0; k < w * h; k += 3)
    if (kind[k] === ON_PAPER) for (let c = 0; c < 3; c++) samples[c].push(px[k * 4 + c]);
  // Most of the visible paper is paper: its median is the paper colour, even with the object in view.
  const white = samples[0].length < 50 ? null : samples.map((s) => Math.max(1, median(s)));
  return { kind, white };
}

/**
 * Silhouette masks of all the frames: UNKNOWN, PAPER or OBJECT per pixel. The object's
 * colours are learnt where it stands in front of paper, in every frame together, so the
 * table can be told apart from the object around the mat.
 */
export function silhouettes(views: View[], map: PaperMap, reach: Reach): Uint8Array[] {
  const prepared = views.map((v) => prepare(v, map, reach));
  const objectHist = new Float64Array(BINS ** 3);
  const masks = views.map((v, n) => {
    const { kind, white } = prepared[n];
    const { width: w, height: h, data: px } = v.image;
    const mask = new Uint8Array(w * h);
    if (!white) return mask;
    for (let k = 0; k < w * h; k++) {
      if (kind[k] !== ON_PAPER) continue;
      const r = px[k * 4] / white[0], g = px[k * 4 + 1] / white[1], b = px[k * 4 + 2] / white[2];
      const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
      const paper = (r + g + b) / 3 >= MIN_BRIGHTNESS && (hi - lo) / Math.max(hi, 1e-6) <= MAX_TINT;
      mask[k] = paper ? PAPER : OBJECT;
      if (!paper) objectHist[bin(r, g, b)]++;
    }
    return mask;
  });
  views.forEach((v, n) => fillHighlights(masks[n], v.image.width, v.image.height));
  const objectTotal = objectHist.reduce((s, c) => s + c, 0) || 1;

  views.forEach((v, n) => {
    const { kind, white } = prepared[n];
    if (!white) return;
    const { width: w, height: h, data: px } = v.image;
    const tableHist = new Float64Array(BINS ** 3);
    let tableTotal = 0;
    for (let k = 0; k < w * h; k++)
      if (kind[k] === CLEAR_TABLE) {
        tableHist[bin(px[k * 4] / white[0], px[k * 4 + 1] / white[1], px[k * 4 + 2] / white[2])]++;
        tableTotal++;
      }
    if (tableTotal < 200) return;
    const mask = masks[n];
    for (let k = 0; k < w * h; k++) {
      if (kind[k] === CLEAR_TABLE) {
        mask[k] = PAPER;
        continue;
      }
      if (kind[k] !== ON_TABLE) continue;
      const b = bin(px[k * 4] / white[0], px[k * 4 + 1] / white[1], px[k * 4 + 2] / white[2]);
      const table = tableHist[b] / tableTotal;
      if (table >= TABLE_SHARE && table >= TABLE_OVER_OBJECT * (objectHist[b] / objectTotal)) mask[k] = PAPER;
    }
  });
  return masks;
}

/** Paper patches up to this share of the frame, closed in by the object all round, are glints on it. */
const MAX_GLINT = 0.0006;

/**
 * A shiny object reflects the light in bright, colourless spots that look like paper.
 * Real paper seen past the object always reaches the rest of the paper, ink or the
 * frame's edge; a small patch with object all round it is a glint, and object too.
 */
function fillHighlights(mask: Uint8Array, w: number, h: number) {
  const maxArea = Math.max(20, Math.round(MAX_GLINT * w * h));
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const patch: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (mask[s] !== PAPER || seen[s]) continue;
    stack.length = 0;
    patch.length = 0;
    stack.push(s);
    seen[s] = 1;
    let open = false;
    while (stack.length) {
      const k = stack.pop()!;
      if (patch.length <= maxArea) patch.push(k);
      const x = k % w, y = (k - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true;
      for (const q of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
        if (q < 0) continue;
        if (mask[q] === PAPER) {
          if (!seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        } else if (mask[q] !== OBJECT) open = true;
      }
    }
    if (!open && patch.length <= maxArea) for (const k of patch) mask[k] = OBJECT;
  }
}

function median(a: number[]): number {
  const s = Float64Array.from(a).sort();
  return s[Math.floor(s.length / 2)];
}

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
