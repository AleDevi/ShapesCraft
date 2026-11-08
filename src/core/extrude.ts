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
/** Size of the distance-field cells, mm: fine enough for smooth insets, coarse enough to stay quick. */
const CELL_MM = 0.1;
/** Insets smaller than this (mm²: crumbs where a thin part ends) are left out: too small to print. */
const MIN_LOOP_AREA_MM2 = 0.3;
/** Smallest inset of the rounded edge, mm (and at least one grid cell), so that it stays clear of the exact outline. */
const MIN_INSET_MM = 0.08;
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
  // About 0.25 mm of arc per level. The lowest insets would sit a hair inside the outline
  // (the first is 0.01 mm in for r = 1 mm): skipping those keeps the levels apart.
  const arcs = r > 0 ? Math.min(16, Math.max(4, Math.ceil((r * Math.PI) / 2 / 0.25))) : 0;
  const levels: { d: number; z: number }[] = [{ d: 0, z: T - r }];
  for (let k = 1; k <= arcs; k++) {
    const a = (k / arcs) * (Math.PI / 2);
    const d = r * (1 - Math.cos(a));
    if (d >= Math.max(MIN_INSET_MM, res) || k === arcs) levels.push({ d, z: T - r + r * Math.sin(a) });
  }
  const steps = levels.length - 1;
  // Each level is simplified by less than half the gap to its neighbours, so levels never cross.
  const gap = (k: number) => (k < 0 || k >= steps ? Infinity : levels[k + 1].d - levels[k].d);
  const tol = (k: number) => Math.min(MAX_TOLERANCE, gap(k - 1) / 2.5, gap(k) / 2.5);
  // isoContours treats values below the level as inside: inside the inset means sd > d.
  const field = { width: w, height: h, data: sd.map((v) => -v) };
  const fieldLoops = (d: number, k: number) =>
    isoContours(field, -d)
      .map((l) => l.map((p) => ({ x: x0 + p.x * res, y: y0 + p.y * res })))
      .map((l) => densify(clean(l, tol(k))))
      .filter((l) => l.length >= 3 && Math.abs(signedArea(l)) > MIN_LOOP_AREA_MM2);
  // The outline itself is the traced shape, exactly; only the insets come from the field.
  // Shapes that touch or overlap don't make one clean outline, though: then the field's
  // outline, which joins them, is used instead.
  const fieldOutline = fieldLoops(0, 0);
  const clean_ = fieldOutline.length === shapes.length && !crossing(shapes);
  const outline = clean_ ? (steps ? shapes.map(densify) : shapes) : fieldOutline;
  const contours = levels.map(({ d }, k) => (k === 0 ? outline : fieldLoops(d, k)));

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
  for (let k = 0; k < steps; k++) band(oriented[k], levelRings[k], oriented[k + 1], levelRings[k + 1], tris);
  cap(oriented[steps], levelRings[steps], tris, true);

  closeGaps(tris);
  return { positions: new Float32Array(pos), triangles: new Uint32Array(tris) };
}

/**
 * Last safety net for a printable file: earcut can, on rare near-degenerate input, leave
 * a tiny gap. Every edge with no partner running the other way is chained into the
 * gap's outline, which is then filled with a fan of triangles.
 */
function closeGaps(tris: number[]) {
  const edges = new Map<string, number>();
  const key = (a: number, b: number) => `${a},${b}`;
  for (let k = 0; k < tris.length; k += 3)
    for (let e = 0; e < 3; e++) {
      const id = key(tris[k + e], tris[k + ((e + 1) % 3)]);
      edges.set(id, (edges.get(id) ?? 0) + 1);
    }
  // Open edge a → b: the gap's outline runs b → a.
  const next = new Map<number, number>();
  for (const [id, count] of edges) {
    const [a, b] = id.split(',').map(Number);
    if (count === 1 && !edges.has(key(b, a)) && !next.has(b)) next.set(b, a);
  }
  while (next.size) {
    const [start] = next.keys();
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && next.has(v) && loop.length <= next.size + 1) {
      loop.push(v);
      const w: number = next.get(v)!;
      next.delete(v);
      v = w;
    }
    if (v !== start || loop.length < 3) continue;
    for (let i = 1; i + 1 < loop.length; i++) tris.push(loop[0], loop[i], loop[i + 1]);
  }
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

/** Whether any two sides of the loops cross or touch (sides of a loop next to each other aside). */
function crossing(loops: Point[][]): boolean {
  const CELL = 2;
  const cells = new Map<number, number[]>();
  const sides: [Point, Point, number, number][] = [];
  loops.forEach((l, li) => l.forEach((a, i) => sides.push([a, l[(i + 1) % l.length], li, i])));
  const cell = (v: number) => Math.floor(v / CELL);
  const orient = (a: Point, b: Point, c: Point) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let s = 0; s < sides.length; s++) {
    const [a, b, li, i] = sides[s];
    const seen = new Set<number>();
    for (let cy = cell(Math.min(a.y, b.y)); cy <= cell(Math.max(a.y, b.y)); cy++)
      for (let cx = cell(Math.min(a.x, b.x)); cx <= cell(Math.max(a.x, b.x)); cx++) {
        const key = (cx + 32768) * 65536 + (cy + 32768);
        const list = cells.get(key) ?? [];
        for (const o of list) {
          if (seen.has(o)) continue;
          seen.add(o);
          const [c, d, lo, io] = sides[o];
          const n = loops[li].length;
          if (lo === li && (Math.abs(io - i) === 1 || Math.abs(io - i) === n - 1)) continue;
          const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
          if (o1 !== o2 && o3 !== o4) return true;
          // Collinear overlap counts as touching.
          if (o1 === 0 && o2 === 0 && Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))) return true;
        }
        list.push(s);
        cells.set(key, list);
      }
  }
  return false;
}

/** Squared distance from p to the segment a–b. */
function segment2(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}

/** Largest fold (twice the area, mm²) a strip may have where both ways fold, as at sharp tips. */
const MAX_FOLD = 0.05;

/** Longest side of a level of the rounded edge, mm: alike levels stitch into an even strip. */
const MAX_SIDE_MM = 0.5;

/** Splits long sides so that every level has about the same spacing of points. */
function densify(loop: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / MAX_SIDE_MM);
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
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
  for (const region of regions(loops)) capRegion(loops, ids, region, tris, up);
}

/**
 * The sloped surface between two neighbouring levels of the rounded edge (loops of the
 * lower level `a`, of the upper level `b`). Where an outline and its inset pair up, the
 * strip between them is stitched edge to edge, so the slope stays even and smooth. Where
 * the shape changes between levels (a thin part ends, two parts split) the area is
 * triangulated as a whole.
 */
function band(a: Point[][], aIds: number[][], b: Point[][], bIds: number[][], tris: number[]) {
  const loops = [...a, ...b];
  const ids = [...aIds, ...bIds];
  for (const region of regions(loops)) {
    const members = [region.outer, ...region.holes];
    const lower = members.filter((i) => i < a.length);
    const upper = members.filter((i) => i >= a.length);
    const strip = lower.length === 1 && upper.length === 1 ? stitch(loops[lower[0]], ids[lower[0]], loops[upper[0]], ids[upper[0]]) : null;
    if (strip) tris.push(...strip);
    else capRegion(loops, ids, region, tris, true);
  }
}

/**
 * Joins loop A to loop B (its inset, running the same way, on A's left) by a strip of
 * triangles, walking both loops together one step at a time.
 * Returns null when the loops don't pair up that way (part of the shape ends between
 * the two levels): the strip would fold over itself there.
 */
function stitch(A0: Point[], aIds0: number[], B: Point[], bIds: number[]): number[] | null {
  const tris: number[] = [];
  const n = A0.length, m = B.length;
  // Start A at the side holding the foot of B's first point, so both start side by side.
  let k0 = 0;
  {
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const d = segment2(B[0], A0[k], A0[(k + 1) % n]);
      if (d < best) [best, k0] = [d, k];
    }
  }
  const A = [...A0.slice(k0), ...A0.slice(0, k0)];
  const aIds = [...aIds0.slice(k0), ...aIds0.slice(0, k0)];
  const d2 = (p: Point, q: Point) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
  const Bp = (j: number) => B[j % m];
  const bId = (j: number) => bIds[j % m];
  const area = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  let i = 0, j = 0;
  while (i < n || j < m) {
    // A step along A (if any left) or along B, whichever makes the shorter new edge...
    const stepA = i < n ? area(A[i], A[(i + 1) % n], Bp(j)) : -Infinity;
    const stepB = j < m ? area(A[i % n], Bp(j + 1), Bp(j)) : -Infinity;
    let alongA = j >= m || (i < n && d2(A[(i + 1) % n], Bp(j)) <= d2(A[i], Bp(j + 1)));
    // ...but never one whose triangle folds over when the other one doesn't,
    if (stepA > 0 !== stepB > 0) alongA = stepA > 0;
    // and the lesser fold when both do (a hair at a sharp tip). A real fold means
    // these levels don't pair up here.
    else if (stepA <= 0) alongA = stepA >= stepB;
    if ((alongA ? stepA : stepB) < -MAX_FOLD) return null;
    if (alongA) {
      tris.push(aIds[i], aIds[(i + 1) % n], bId(j));
      i++;
    } else {
      tris.push(aIds[i % n], bId(j + 1), bId(j));
      j++;
    }
  }
  return tris;
}

function capRegion(loops: Point[][], ids: number[][], { outer, holes }: Region, tris: number[], up: boolean) {
  const flat: number[] = [];
  const index: number[] = [];
  const rings: number[][] = [];
  const holeStarts: number[] = [];
  for (const i of [outer, ...holes]) {
    if (i !== outer) holeStarts.push(index.length);
    const ring: number[] = [];
    for (let k = 0; k < loops[i].length; k++) {
      ring.push(index.length);
      flat.push(loops[i][k].x, loops[i][k].y);
      index.push(ids[i][k]);
    }
    rings.push(ring);
  }
  const t = restoreDropped(earcut(flat, holeStarts), rings, flat);
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

/**
 * earcut skips points that lie exactly on a straight run of their loop. The surface next
 * door still has an edge to each such point, so the mesh would be open there: split the
 * triangle that spans the skipped points into a fan through them.
 */
function restoreDropped(t: number[], rings: number[][], flat: number[]): number[] {
  const out = t.slice();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const owner = new Map<string, number>();
  const note = (k: number) => {
    for (let e = 0; e < 3; e++) owner.set(key(out[k + e], out[k + ((e + 1) % 3)]), k);
  };
  for (let k = 0; k < out.length; k += 3) note(k);
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      if (owner.has(key(ring[i], ring[(i + 1) % n]))) continue;
      // Find the next point of the ring the triangles do reach from here.
      let j = i + 2;
      while (j - i < n && !owner.has(key(ring[i], ring[j % n]))) j++;
      if (j - i >= n) continue;
      const a = ring[i], c = ring[j % n];
      // Only points on the straight line from a to c were skipped on purpose.
      let straight = true;
      for (let m = i + 1; m < j && straight; m++) {
        const b = ring[m % n];
        const cross = (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]) - (flat[2 * c + 1] - flat[2 * a + 1]) * (flat[2 * b] - flat[2 * a]);
        straight = Math.abs(cross) < 1e-9;
      }
      if (!straight) continue;
      const k = owner.get(key(a, c))!;
      const tri = out.slice(k, k + 3);
      const x = tri.find((v) => v !== a && v !== c)!;
      // Keep the triangle's winding: walk a → c the way the triangle does.
      const forward = tri.indexOf(c) === (tri.indexOf(a) + 1) % 3;
      const chain = [a];
      for (let m = i + 1; m < j; m++) chain.push(ring[m % n]);
      chain.push(c);
      const fan: number[] = [];
      for (let m = 0; m + 1 < chain.length; m++) {
        if (forward) fan.push(chain[m], chain[m + 1], x);
        else fan.push(chain[m + 1], chain[m], x);
      }
      out.splice(k, 3, ...fan.slice(0, 3));
      note(k);
      for (let f = 3; f < fan.length; f += 3) {
        out.push(fan[f], fan[f + 1], fan[f + 2]);
        note(out.length - 3);
      }
      i = j - 1;
    }
  }
  return out;
}
