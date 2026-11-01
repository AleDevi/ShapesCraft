import type { Point } from './homography';

/** A traced stroke centreline in pixel coordinates (pixel j's centre is at j + 0.5). */
export interface Centerline {
  points: Point[];
  closed: boolean;
  /** Whether each end is a free stroke end (as opposed to a junction with other strokes). */
  freeStart: boolean;
  freeEnd: boolean;
}

export interface CenterlineResult {
  lines: Centerline[];
  /** Typical stroke width in pixels, estimated as ink area / skeleton length. */
  strokeWidth: number;
}

const NEIGHBOURS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
] as const;

/**
 * Removes connected regions smaller than `minArea` pixels: specks of ink, and
 * holes inside strokes (which would otherwise turn into small loops).
 */
export function cleanBinary(ink: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = ink.slice();
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start]) continue;
    const value = out[start];
    const region: number[] = [];
    let touchesBorder = false;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      region.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      // Ink connects through diagonals, background only through edges, so the two stay complementary.
      const steps = value ? NEIGHBOURS : NEIGHBOURS.filter((_, k) => k % 2 === 0);
      for (const [dx, dy] of steps) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && out[j] === value) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (region.length < minArea && (value || !touchesBorder)) for (const i of region) out[i] = value ? 0 : 1;
  }
  return out;
}

/** Zhang–Suen thinning: reduces ink regions to one-pixel-wide 8-connected lines. */
export function thin(ink: Uint8Array, w: number, h: number): Uint8Array {
  const img = ink.slice();
  for (let x = 0; x < w; x++) img[x] = img[(h - 1) * w + x] = 0;
  for (let y = 0; y < h; y++) img[y * w] = img[y * w + w - 1] = 0;
  const remove: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pass of [0, 1]) {
      remove.length = 0;
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!img[i]) continue;
          // P2..P9 clockwise from north.
          const p = NEIGHBOURS.map(([dx, dy]) => img[i + dy * w + dx]);
          const b = p.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++;
          if (a !== 1) continue;
          const [p2, , p4, , p6, , p8] = p;
          if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          remove.push(i);
        }
      for (const i of remove) img[i] = 0;
      if (remove.length) changed = true;
    }
  }
  return img;
}

interface Edge {
  a: number;
  b: number;
  pts: Point[];
  closed: boolean;
}

const length = (pts: Point[]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
};

/**
 * Turns ink into stroke centrelines: thins it to a skeleton, splits the
 * skeleton into branches between ends and junctions, drops the short spurs
 * thinning leaves at bends and stroke ends, and rejoins the branches that
 * then meet in pairs.
 */
export function centerlines(ink: Uint8Array, w: number, h: number): CenterlineResult {
  const skel = thin(ink, w, h);
  let inkArea = 0;
  let skelLength = 0;
  for (let i = 0; i < w * h; i++) {
    inkArea += ink[i];
    skelLength += skel[i];
  }
  const strokeWidth = skelLength ? inkArea / skelLength : 0;

  const degree = new Uint8Array(w * h);
  const at = (i: number, k: number) => i + NEIGHBOURS[k][1] * w + NEIGHBOURS[k][0];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      for (let k = 0; k < 8; k++) degree[i] += skel[at(i, k)];
    }
  const isNode = (i: number) => skel[i] && degree[i] !== 2;
  const centre = (i: number): Point => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 });

  // Adjacent node pixels form one node; its position is their centroid.
  const nodeOf = new Int32Array(w * h).fill(-1);
  const nodes: { pos: Point; free: boolean }[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!isNode(i) || nodeOf[i] >= 0) continue;
    const id = nodes.length;
    const pixels = [i];
    nodeOf[i] = id;
    for (let k = 0; k < pixels.length; k++)
      for (let d = 0; d < 8; d++) {
        const j = at(pixels[k], d);
        if (isNode(j) && nodeOf[j] < 0) {
          nodeOf[j] = id;
          pixels.push(j);
        }
      }
    const pos = pixels.map(centre).reduce((s, p) => ({ x: s.x + p.x / pixels.length, y: s.y + p.y / pixels.length }), { x: 0, y: 0 });
    nodes.push({ pos, free: pixels.length === 1 && degree[i] === 1 });
  }

  const visited = new Uint8Array(w * h);
  const edges: Edge[] = [];
  const walk = (from: number, first: number, startNode: number) => {
    const pts = [nodes[startNode].pos];
    let prev = from;
    let cur = first;
    for (;;) {
      if (isNode(cur)) {
        pts.push(nodes[nodeOf[cur]].pos);
        edges.push({ a: startNode, b: nodeOf[cur], pts, closed: false });
        return;
      }
      visited[cur] = 1;
      pts.push(centre(cur));
      let next = -1;
      for (let d = 0; d < 8 && next < 0; d++) {
        const j = at(cur, d);
        if (skel[j] && j !== prev && (isNode(j) || !visited[j])) next = j;
      }
      if (next < 0) return; // ran into an already-walked branch from the other side
      prev = cur;
      cur = next;
    }
  };
  for (let i = 0; i < w * h; i++) {
    if (!isNode(i)) continue;
    for (let d = 0; d < 8; d++) {
      const j = at(i, d);
      if (skel[j] && !isNode(j) && !visited[j]) walk(i, j, nodeOf[i]);
    }
  }
  // What is left are closed loops with no ends or junctions.
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || isNode(i) || visited[i]) continue;
    const pts: Point[] = [];
    let prev = -1;
    let cur = i;
    while (cur >= 0 && !visited[cur]) {
      visited[cur] = 1;
      pts.push(centre(cur));
      let next = -1;
      for (let d = 0; d < 8 && next < 0; d++) {
        const j = at(cur, d);
        if (skel[j] && j !== prev && !visited[j]) next = j;
      }
      prev = cur;
      cur = next;
    }
    if (pts.length > 2) edges.push({ a: -1, b: -1, pts, closed: true });
  }

  const spur = Math.max(1.5 * strokeWidth, 3);
  let alive = edges;
  for (let round = 0; round < 6; round++) {
    const ends = new Map<number, number[]>();
    alive.forEach((e, k) => {
      if (e.closed) return;
      for (const n of [e.a, e.b]) ends.set(n, [...(ends.get(n) ?? []), k]);
    });
    const deg = (n: number) => ends.get(n)?.length ?? 0;
    // Spurs: short branches from a junction to a free end, and tiny loops on a junction.
    const keep = alive.filter((e) => {
      if (e.closed) return true;
      const len = length(e.pts);
      if (e.a === e.b) return len >= 2 * spur;
      const spurEnd = (n: number, other: number) => nodes[n].free && deg(other) >= 3;
      return !(len < spur && (spurEnd(e.a, e.b) || spurEnd(e.b, e.a)));
    });
    const merged = mergeThroughNodes(keep);
    if (merged.length === alive.length && keep.length === alive.length) break;
    alive = merged;
  }

  const lines = alive
    .filter((e) => e.closed || length(e.pts) >= spur)
    .map((e) => ({
      points: e.pts,
      closed: e.closed,
      freeStart: !e.closed && nodes[e.a].free,
      freeEnd: !e.closed && nodes[e.b].free,
    }));
  return { lines, strokeWidth };
}

/** Joins pairs of branches that meet at a node no other branch touches. */
function mergeThroughNodes(edges: Edge[]): Edge[] {
  let list = edges.slice();
  for (;;) {
    const ends = new Map<number, number[]>();
    list.forEach((e, k) => {
      if (e.closed) return;
      ends.set(e.a, [...(ends.get(e.a) ?? []), k]);
      ends.set(e.b, [...(ends.get(e.b) ?? []), k]);
    });
    const node = [...ends.entries()].find(([, ks]) => ks.length === 2);
    if (!node) return list;
    const [n, [k1, k2]] = node;
    const e1 = list[k1];
    if (k1 === k2) {
      // A branch that starts and ends here: it is a loop.
      list = list.map((e, k) => (k === k1 ? { ...e, closed: true, pts: e.pts.slice(0, -1) } : e));
      continue;
    }
    const e2 = list[k2];
    // Orient e1 to end at n and e2 to start at n, then concatenate.
    const p1 = e1.b === n ? e1.pts : e1.pts.slice().reverse();
    const a = e1.b === n ? e1.a : e1.b;
    const p2 = e2.a === n ? e2.pts : e2.pts.slice().reverse();
    const b = e2.a === n ? e2.b : e2.a;
    const joined: Edge = { a, b, pts: [...p1, ...p2.slice(1)], closed: false };
    list = [...list.filter((_, k) => k !== k1 && k !== k2), joined];
  }
}
