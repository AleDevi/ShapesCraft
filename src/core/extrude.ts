import earcut from 'earcut';
import type { Point } from './homography';
import type { Mesh } from '../scan3d/mesh';
import { isoContours, signedArea, simplifyClosed } from './trace';

export interface ExtrudeOptions {
  /** Height of the solid above the print bed, in mm. */
  thicknessMm: number;
  /** Radius of the rounded top edge, in mm. 0 keeps a sharp edge; at most a little less than the thickness. */
  roundMm: number;
}

/** Most grid cells the distance field may use, to keep phones within memory and time. */
const MAX_CELLS = 2_000_000;
/** Size of the distance-field cells, mm: the photo is traced at 0.2 mm per pixel too. */
const CELL_MM = 0.2;
/** Largest distance of the mesh from the exact outline, mm: far below what a printer shows. */
const MAX_TOLERANCE = 0.04;

/**
 * Turns flat closed shapes (sheet millimetres, y down, filled by the even-odd rule so
 * inner loops are holes) into a solid ready for 3D printing: the shape standing on
 * z = 0, `thicknessMm` high, its top edge optionally rounded with a quarter circle of
 * radius `roundMm`. The mesh is closed, its triangles face outwards, x and y are centred
 * on the shape and y points towards the top of the sheet.
 *
 * The rounded edge is a stack of insets: each level is the outline moved inwards by
 * r·(1 − cos θ) and raised to T − r + r·sin θ. The insets are contours of one signed
 * distance field, so they never cross, merge where the shape is thin, and parts too thin
 * for the full radius simply end lower down.
 */
export function extrude(loops: Point[][], opts: ExtrudeOptions): Mesh {
  const T = Math.max(0, opts.thicknessMm);
  // A low wall always stays under the rounding: with none, flat slivers of the rounded edge
  // would lie right on the bottom face.
  const r = Math.max(0, Math.min(opts.roundMm, T - Math.min(0.1, T / 4)));
  // Dense input (flattened curves) only slows the distance field down: 0.01 mm is plenty.
  const shapes = loops
    .filter((l) => l.length >= 3)
    .map((l) => clean(l.map((p) => ({ x: p.x, y: -p.y })), 0.01))
    .filter((l) => l.length >= 3);
  if (!shapes.length || T <= 0) return { positions: new Float32Array(0), triangles: new Uint32Array(0) };

  // Grid of the distance field, coarser for very big shapes.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of shapes) for (const p of l) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const res = Math.max(CELL_MM, Math.sqrt(((maxX - minX + 2) * (maxY - minY + 2)) / MAX_CELLS));
  const far = r + 3 * res;
  const margin = 3 * res;
  const x0 = minX - margin, y0 = minY - margin;
  const w = Math.ceil((maxX - minX + 2 * margin) / res);
  const h = Math.ceil((maxY - minY + 2 * margin) / res);
  const sd = signedDistance(shapes, x0, y0, res, w, h, far);

  // Levels of the rounded edge, from the wall top (θ = 0) to the flat top (θ = 90°).
  const steps = r > 0 ? Math.min(16, Math.max(3, Math.ceil((r * Math.PI) / 2 / 0.3))) : 0;
  const levels: { d: number; z: number }[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = steps ? (k / steps) * (Math.PI / 2) : 0;
    levels.push({ d: r * (1 - Math.cos(a)), z: T - r + r * Math.sin(a) });
  }
  // Each level is simplified by less than half the gap to its neighbours, so levels never cross.
  const gap = (k: number) => (k < 0 || k >= steps ? Infinity : levels[k + 1].d - levels[k].d);
  const tol = (k: number) => Math.min(MAX_TOLERANCE, gap(k - 1) / 2.5, gap(k) / 2.5);
  // isoContours treats values below the level as inside: inside the inset means sd > d.
  const field = { width: w, height: h, data: sd.map((v) => -v) };
  const contours = levels.map(({ d }, k) =>
    isoContours(field, -d)
      .map((l) => clean(l.map((p) => ({ x: x0 + p.x * res, y: y0 + p.y * res })), tol(k)))
      .filter((l) => l.length >= 3 && Math.abs(signedArea(l)) > res * res * 0.5),
  );

  // Centre on the base outline.
  const base = contours[0];
  if (!base.length) return { positions: new Float32Array(0), triangles: new Uint32Array(0) };
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const l of base) for (const p of l) {
    bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x);
    by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y);
  }
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;

  const pos: number[] = [];
  const tris: number[] = [];
  /** Vertices of each loop at a height; the same loop shared by two surfaces shares its edges. */
  const ring = (loop: Point[], z: number) => loop.map((p) => (pos.push(p.x - cx, p.y - cy, z), pos.length / 3 - 1));
  const rings = (ls: Point[][], z: number) => ls.map((l) => ring(l, z));

  // Orient every loop with the material on its left, so walls know their outside.
  const oriented = contours.map(orient);
  const bottom = rings(oriented[0], 0);
  const wallTop = rings(oriented[0], levels[0].z);
  const levelRings = [wallTop, ...oriented.slice(1).map((ls, k) => rings(ls, levels[k + 1].z))];

  cap(oriented[0], bottom, tris, false);
  for (let i = 0; i < bottom.length; i++) {
    const lo = bottom[i], hi = wallTop[i], n = lo.length;
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      tris.push(lo[j], lo[k], hi[k], lo[j], hi[k], hi[j]);
    }
  }
  for (let k = 0; k < steps; k++) {
    cap([...oriented[k], ...oriented[k + 1]], [...levelRings[k], ...levelRings[k + 1]], tris, true);
  }
  cap(oriented[steps], levelRings[steps], tris, true);

  return { positions: new Float32Array(pos), triangles: new Uint32Array(tris) };
}

/**
 * Signed distance to the outlines, in mm: positive inside (even-odd), negative outside,
 * exact within `far` of an outline and clamped to ±`far` beyond. Cell (i, j) has its centre
 * at (x0 + (i + ½)·res, y0 + (j + ½)·res).
 */
function signedDistance(loops: Point[][], x0: number, y0: number, res: number, w: number, h: number, far: number): Float32Array {
  const dist = new Float32Array(w * h).fill(far);
  const reach = Math.ceil(far / res) + 1;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      // Segment in cell units, measured from cell centres.
      const ax = (l[i].x - x0) / res - 0.5, ay = (l[i].y - y0) / res - 0.5;
      const b = l[(i + 1) % l.length];
      const bx = (b.x - x0) / res - 0.5, by = (b.y - y0) / res - 0.5;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx)) - reach), i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx)) + reach);
      const j0 = Math.max(0, Math.floor(Math.min(ay, by)) - reach), j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by)) + reach);
      for (let y = j0; y <= j1; y++) {
        for (let x = i0; x <= i1; x++) {
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
          const d = Math.hypot(x - ax - t * dx, y - ay - t * dy) * res;
          const k = y * w + x;
          if (d < dist[k]) dist[k] = d;
        }
      }
    }
  }
  // Inside by the even-odd rule, one scan line through each row of cell centres.
  const rows: { ax: number; ay: number; bx: number; by: number }[][] = Array.from({ length: h }, () => []);
  for (const l of loops) {
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const a = l[j], b = l[i];
      if (a.y === b.y) continue;
      // Rows whose centre line lies within the edge's y span.
      const lo = Math.max(0, Math.ceil((Math.min(a.y, b.y) - y0) / res - 0.5));
      const hi = Math.min(h - 1, Math.floor((Math.max(a.y, b.y) - y0) / res - 0.5));
      for (let y = lo; y <= hi; y++) rows[y].push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const py = y0 + (y + 0.5) * res;
    xs.length = 0;
    for (const e of rows[y]) if (e.ay > py !== e.by > py) xs.push(e.ax + ((py - e.ay) / (e.by - e.ay)) * (e.bx - e.ax));
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - x0) / res - 0.5));
      const to = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / res - 0.5));
      for (let x = from; x <= to; x++) dist[y * w + x] = -dist[y * w + x];
    }
  }
  // Flip the sign so inside is positive.
  for (let k = 0; k < dist.length; k++) dist[k] = -dist[k];
  return dist;
}

/** Drops repeated points and points on straight runs. */
function clean(loop: Point[], tol: number): Point[] {
  const out: Point[] = [];
  for (const p of loop) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q.x - p.x) > 1e-9 || Math.abs(q.y - p.y) > 1e-9) out.push(p);
  }
  if (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) <= 1e-9 && Math.abs(out[0].y - out[out.length - 1].y) <= 1e-9) out.pop();
  return out.length > 3 ? simplifyClosed(out, tol) : out;
}

interface Region { outer: number; holes: number[] }

/** Groups loops filled by the even-odd rule into outlines with their holes. */
function regions(loops: Point[][]): Region[] {
  const boxes = loops.map((l) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of l) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1 };
  });
  const containers = loops.map((l, i) => {
    const p = l[0];
    const out: number[] = [];
    for (let j = 0; j < loops.length; j++) {
      const b = boxes[j];
      if (j !== i && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && inside(p, loops[j])) out.push(j);
    }
    return out;
  });
  const depth = containers.map((c) => c.length);
  const result = new Map<number, Region>();
  loops.forEach((_, i) => {
    if (depth[i] % 2 === 0) result.set(i, result.get(i) ?? { outer: i, holes: [] });
  });
  loops.forEach((_, i) => {
    if (depth[i] % 2 === 0) return;
    // The hole belongs to the deepest loop around it.
    const parent = containers[i].reduce((a, b) => (depth[b] > depth[a] ? b : a));
    result.get(parent)?.holes.push(i);
  });
  return [...result.values()];
}

function inside(p: Point, poly: Point[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x)) c = !c;
  }
  return c;
}

/** Outer loops counter-clockwise, holes clockwise (y up): the material is always on the left. */
function orient(loops: Point[][]): Point[][] {
  const out = loops.slice();
  for (const { outer, holes } of regions(loops)) {
    if (signedArea(out[outer]) < 0) out[outer] = out[outer].slice().reverse();
    for (const hIdx of holes) if (signedArea(out[hIdx]) > 0) out[hIdx] = out[hIdx].slice().reverse();
  }
  return out;
}

/**
 * Triangulates the area between `loops` (even-odd) using only their vertices, whose mesh
 * indices are `ids`, facing up or down. Vertices may sit at different heights: the
 * triangles then form a slope between them.
 */
function cap(loops: Point[][], ids: number[][], tris: number[], up: boolean) {
  for (const { outer, holes } of regions(loops)) {
    const flat: number[] = [];
    const index: number[] = [];
    const holeStarts: number[] = [];
    for (const i of [outer, ...holes]) {
      if (i !== outer) holeStarts.push(index.length);
      for (let k = 0; k < loops[i].length; k++) {
        flat.push(loops[i][k].x, loops[i][k].y);
        index.push(ids[i][k]);
      }
    }
    const t = earcut(flat, holeStarts);
    // earcut winds all triangles of one call alike: find which way from their total area.
    let area = 0;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 2, b = t[k + 1] * 2, c = t[k + 2] * 2;
      area += (flat[b] - flat[a]) * (flat[c + 1] - flat[a + 1]) - (flat[c] - flat[a]) * (flat[b + 1] - flat[a + 1]);
    }
    const flip = area > 0 !== up;
    for (let k = 0; k < t.length; k += 3) {
      if (flip) tris.push(index[t[k]], index[t[k + 2]], index[t[k + 1]]);
      else tris.push(index[t[k]], index[t[k + 1]], index[t[k + 2]]);
    }
  }
}
