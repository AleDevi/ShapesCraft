import type { Gray } from './image';
import type { Point } from './homography';

/**
 * Extracts closed iso-contours `value = level` from a grayscale field with
 * marching squares. Pixels darker than `level` are "inside". Contour points are
 * interpolated between pixel centres, so edges are sub-pixel accurate. The
 * field is treated as bright beyond its border, so every contour is closed.
 */
export function isoContours(g: Gray, level: number): Point[][] {
  const W = g.width + 2;
  const H = g.height + 2;
  const bright = Math.max(level + 1, 1);
  const v = (x: number, y: number) =>
    x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1 ? bright : g.data[(y - 1) * g.width + (x - 1)];

  // Edge ids: horizontal edge (x,y)→(x+1,y) is 2·(y·W+x), vertical (x,y)→(x,y+1) is 2·(y·W+x)+1.
  const next = new Map<number, number>();
  const corners = new Array<number>(4);
  const crossings: { edge: number; exit: boolean }[] = [];

  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      corners[0] = v(x, y);
      corners[1] = v(x + 1, y);
      corners[2] = v(x + 1, y + 1);
      corners[3] = v(x, y + 1);
      const inside = corners.map((c) => c < level);
      if (inside.every((b) => b) || inside.every((b) => !b)) continue;

      // Walk the cell clockwise: top, right, bottom, left edges.
      const edges = [2 * (y * W + x), 2 * (y * W + x + 1) + 1, 2 * ((y + 1) * W + x), 2 * (y * W + x) + 1];
      crossings.length = 0;
      for (let i = 0; i < 4; i++) {
        const a = inside[i];
        const b = inside[(i + 1) % 4];
        if (a !== b) crossings.push({ edge: edges[i], exit: a });
      }
      if (crossings.length === 2) {
        const exit = crossings[0].exit ? crossings[0] : crossings[1];
        const entry = crossings[0].exit ? crossings[1] : crossings[0];
        next.set(exit.edge, entry.edge);
      } else {
        // Saddle: the cell centre decides whether the inside corners connect.
        const centreInside = (corners[0] + corners[1] + corners[2] + corners[3]) / 4 < level;
        for (let i = 0; i < 4; i++) {
          if (!crossings[i].exit) continue;
          const pair = centreInside ? crossings[(i + 1) % 4] : crossings[(i + 3) % 4];
          next.set(crossings[i].edge, pair.edge);
        }
      }
    }
  }

  const position = (edge: number): Point => {
    const vertical = edge & 1;
    const cell = edge >> 1;
    const x = cell % W;
    const y = (cell - x) / W;
    const a = v(x, y);
    const b = vertical ? v(x, y + 1) : v(x + 1, y);
    const t = Math.min(1, Math.max(0, (level - a) / (b - a)));
    // Shift by -1 for the padding and +0.5 because samples sit at pixel centres.
    return vertical ? { x: x - 0.5, y: y - 0.5 + t } : { x: x - 0.5 + t, y: y - 0.5 };
  };

  const loops: Point[][] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const loop: Point[] = [];
    let e: number | undefined = start;
    while (e !== undefined) {
      const n = next.get(e);
      if (n === undefined) break;
      next.delete(e);
      loop.push(position(e));
      e = n;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return s / 2;
}

/** Ramer–Douglas–Peucker on a closed polygon. */
export function simplifyClosed(poly: Point[], tolerance: number): Point[] {
  if (poly.length < 4) return poly;
  // Split at the vertex farthest from the first one so both halves are open chains.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i].x - poly[0].x, poly[i].y - poly[0].y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = rdp(poly.slice(0, far + 1), tolerance);
  const b = rdp([...poly.slice(far), poly[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts: Point[], tol: number): Point[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const ax = pts[s].x;
    const ay = pts[s].y;
    const dx = pts[e].x - ax;
    const dy = pts[e].y - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let idx = -1;
    let max = tol;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export type Segment =
  | { kind: 'L'; to: Point }
  | { kind: 'C'; c1: Point; c2: Point; to: Point };

export interface PathShape { start: Point; segments: Segment[] }

/**
 * Turns a simplified polygon into a smooth closed path. Vertices where the
 * outline turns by more than `cornerDeg` (measured over `reach`, so a corner
 * split into a few close vertices still counts as one) stay sharp; everything
 * else becomes Catmull-Rom curves with tangents scaled to each side's length,
 * which keeps short sides from overshooting.
 */
export function smoothPath(input: Point[], cornerDeg: number, reach: number): PathShape {
  const poly = mergeCorners(input, cornerDeg, reach);
  const n = poly.length;
  const at = (i: number) => poly[((i % n) + n) % n];
  const corner = poly.map((_, i) => turnAngle(poly, i, reach) > cornerDeg);

  const unit = (a: Point, b: Point) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  const segments: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    const c1 = corner[i % n];
    const c2 = corner[(i + 1) % n];
    if (c1 && c2) {
      segments.push({ kind: 'L', to: p2 });
      continue;
    }
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3;
    const t1 = c1 ? unit(p1, p2) : unit(at(i - 1), p2);
    const t2 = c2 ? unit(p1, p2) : unit(p1, at(i + 2));
    segments.push({
      kind: 'C',
      c1: { x: p1.x + t1.x * len, y: p1.y + t1.y * len },
      c2: { x: p2.x - t2.x * len, y: p2.y - t2.y * len },
      to: p2,
    });
  }
  return { start: poly[0], segments };
}

/** Turning angle at vertex i, using points at least `reach` away on either side. */
function turnAngle(poly: Point[], i: number, reach: number): number {
  const n = poly.length;
  const p = poly[i];
  const walk = (dir: number) => {
    let j = i;
    for (let k = 1; k < n; k++) {
      j = (((i + dir * k) % n) + n) % n;
      if (Math.hypot(poly[j].x - p.x, poly[j].y - p.y) >= reach) break;
    }
    return poly[j];
  };
  const a = walk(-1);
  const b = walk(1);
  const v1 = { x: p.x - a.x, y: p.y - a.y };
  const v2 = { x: b.x - p.x, y: b.y - p.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * Pixel sampling chamfers sharp corners into a few close vertices. Each such
 * run is replaced by the point where the two adjoining sides, extended, meet.
 */
function mergeCorners(poly: Point[], cornerDeg: number, reach: number): Point[] {
  const n = poly.length;
  if (n < 5) return poly;
  const sharp = poly.map((_, i) => turnAngle(poly, i, reach) > cornerDeg);
  const start = sharp.indexOf(false);
  if (start < 0) return poly;
  const at = (i: number) => poly[((i % n) + n) % n];
  const out: Point[] = [];
  for (let k = 0; k < n; k++) {
    const i = start + k;
    if (!sharp[i % n]) {
      out.push(at(i));
      continue;
    }
    // Extend the run while the next vertex is also sharp and close by.
    let e = i;
    while (e + 1 < start + n && sharp[(e + 1) % n] && dist(at(e), at(e + 1)) < reach) e++;
    k += e - i;
    if (e === i) {
      out.push(at(i));
      continue;
    }
    const p = intersectLines(at(i - 1), at(i), at(e), at(e + 1));
    const ok = p && dist(p, at(i)) < reach && dist(p, at(e)) < reach;
    if (ok) out.push(p);
    else for (let j = i; j <= e; j++) out.push(at(j));
  }
  return out.length >= 3 ? out : poly;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Intersection of line a1→a2 with line b1→b2. */
function intersectLines(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const d1 = { x: a2.x - a1.x, y: a2.y - a1.y };
  const d2 = { x: b2.x - b1.x, y: b2.y - b1.y };
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / den;
  return { x: a1.x + d1.x * t, y: a1.y + d1.y * t };
}
