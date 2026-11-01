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

/**
 * Removes bumps and noise shorter than about `scale` from a raw contour while
 * keeping its overall shape: curves stay round and sharp corners stay sharp.
 * Corners (turns above `cornerDeg` at that scale) are pinned, as are the ends
 * of an open line; the stretches between them are resampled at `scale / 8`
 * and low-pass filtered with Taubin smoothing, which unlike plain averaging
 * does not shrink the shape.
 */
export function smoothContour(line: Point[], scale: number, cornerDeg: number, closed = true): Point[] {
  const n = line.length;
  if (scale <= 0 || n < (closed ? 8 : 3)) return line;
  const reach = scale / 2;
  const angle = line.map((_, i) => turnAngle(line, i, reach, closed));
  // Keep only the sharpest point of each corner region.
  const pins: number[] = closed ? [] : [0];
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    if (angle[i] <= cornerDeg) continue;
    let isMax = true;
    for (const dir of [-1, 1]) {
      for (let k = 1; k < n && isMax; k++) {
        const j = i + dir * k;
        if (!closed && (j < 0 || j >= n)) break;
        const jj = ((j % n) + n) % n;
        if (dist(line[i], line[jj]) > reach) break;
        if (angle[jj] > angle[i] || (angle[jj] === angle[i] && jj < i)) isMax = false;
      }
    }
    if (isMax) pins.push(i);
  }
  if (!closed) pins.push(n - 1);

  const step = Math.max(1, scale / 8);
  const pts: Point[] = [];
  const pinned: boolean[] = [];
  const stretches = closed
    ? pins.length
      ? pins.map((c, k) => [c, pins[(k + 1) % pins.length]])
      : [[0, 0]]
    : pins.slice(0, -1).map((c, k) => [c, pins[k + 1]]);
  for (const [a, b] of stretches) {
    // Collect the raw points from pin a up to pin b.
    const raw: Point[] = [];
    let j = a;
    do {
      raw.push(line[j]);
      j = (j + 1) % n;
    } while (j !== b);
    raw.push(line[b]);
    const res = resample(raw, step);
    res.pop(); // the end point starts the next stretch
    res.forEach((p, k) => {
      pts.push(p);
      pinned.push(pins.length > 0 && k === 0);
    });
  }
  if (!closed) {
    pts.push(line[n - 1]);
    pinned.push(true);
  }
  if (pts.length < (closed ? 8 : 3)) return line;

  const m = pts.length;
  let cur = pts;
  for (let iter = 0; iter < 30; iter++) {
    for (const f of [0.5, -0.53]) {
      const next = cur.slice();
      for (let i = 0; i < m; i++) {
        if (pinned[i]) continue;
        const a = cur[(i + m - 1) % m];
        const b = cur[(i + 1) % m];
        next[i] = { x: cur[i].x + f * ((a.x + b.x) / 2 - cur[i].x), y: cur[i].y + f * ((a.y + b.y) / 2 - cur[i].y) };
      }
      cur = next;
    }
  }
  return cur;
}

/** Points along an open polyline at roughly equal arc-length spacing, endpoints kept. */
function resample(line: Point[], step: number): Point[] {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += dist(line[i - 1], line[i]);
  const count = Math.max(1, Math.round(total / step));
  const spacing = total / count;
  const out: Point[] = [line[0]];
  let seg = 1;
  let along = 0; // distance travelled before line[seg - 1]
  for (let k = 1; k < count; k++) {
    const target = k * spacing;
    while (seg < line.length - 1 && along + dist(line[seg - 1], line[seg]) < target) {
      along += dist(line[seg - 1], line[seg]);
      seg++;
    }
    const len = dist(line[seg - 1], line[seg]) || 1;
    const t = (target - along) / len;
    out.push({
      x: line[seg - 1].x + (line[seg].x - line[seg - 1].x) * t,
      y: line[seg - 1].y + (line[seg].y - line[seg - 1].y) * t,
    });
  }
  out.push(line[line.length - 1]);
  return out;
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
  const a = simplifyOpen(poly.slice(0, far + 1), tolerance);
  const b = simplifyOpen([...poly.slice(far), poly[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Ramer–Douglas–Peucker on an open polyline; both ends are kept. */
export function simplifyOpen(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
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

export interface PathShape { start: Point; segments: Segment[]; closed: boolean }

/**
 * Turns a simplified polygon into a smooth closed path. Vertices where the
 * outline turns by more than `cornerDeg` (measured over `reach`, so a corner
 * split into a few close vertices still counts as one) stay sharp; everything
 * else becomes Catmull-Rom curves with tangents scaled to each side's length,
 * which keeps short sides from overshooting. A vertex whose curve would bulge
 * more than `1.25·tolerance` away from the polygon (a gentle bend between two
 * long straight sides) is made a corner too, since the polygon already stays
 * within `tolerance` of the traced edge.
 */
export function smoothPath(input: Point[], cornerDeg: number, reach: number, tolerance: number, closed = true): PathShape {
  const poly = closed ? mergeCorners(input, cornerDeg, reach) : input;
  const n = poly.length;
  const at = (i: number) => poly[((i % n) + n) % n];
  // The ends of an open line act as corners: their tangent follows the end segment.
  const corner = poly.map((_, i) => (!closed && (i === 0 || i === n - 1)) || turnAngle(poly, i, reach, closed) > cornerDeg);

  const unit = (a: Point, b: Point) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  // Outgoing / incoming tangent at a smooth vertex: parallel to its neighbours' chord.
  const tangent = (i: number) => unit(at(i - 1), at(i + 1));
  // Distance from the side p1→p2 of a control point placed along tangent t, a third of the side away.
  const bulge = (p1: Point, p2: Point, t: Point) => {
    const d = unit(p1, p2);
    return (Math.abs(t.x * d.y - t.y * d.x) * Math.hypot(p2.x - p1.x, p2.y - p1.y)) / 3;
  };
  for (let i = 0; i < n; i++) {
    if (corner[i]) continue;
    const t = tangent(i);
    // A cubic Bézier stays within 3/4 of its control points' offset.
    if (0.75 * Math.max(bulge(at(i), at(i + 1), t), bulge(at(i), at(i - 1), t)) > 1.25 * tolerance) corner[i] = true;
  }

  const segments: Segment[] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    const c1 = corner[i % n];
    const c2 = corner[(i + 1) % n];
    if (c1 && c2) {
      segments.push({ kind: 'L', to: p2 });
      continue;
    }
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3;
    const t1 = c1 ? unit(p1, p2) : tangent(i);
    const t2 = c2 ? unit(p1, p2) : tangent(i + 1);
    segments.push({
      kind: 'C',
      c1: { x: p1.x + t1.x * len, y: p1.y + t1.y * len },
      c2: { x: p2.x - t2.x * len, y: p2.y - t2.y * len },
      to: p2,
    });
  }
  return { start: poly[0], segments, closed };
}

/** Turning angle at vertex i, using points at least `reach` away on either side. */
function turnAngle(poly: Point[], i: number, reach: number, closed = true): number {
  const n = poly.length;
  const p = poly[i];
  const walk = (dir: number) => {
    let j = i;
    for (let k = 1; k < n; k++) {
      const next = i + dir * k;
      if (!closed && (next < 0 || next >= n)) break; // an open line stops at its ends
      j = ((next % n) + n) % n;
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
