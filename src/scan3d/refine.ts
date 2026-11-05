import type { Mesh } from './mesh';

/**
 * Finishing touches on the carved model: smoothing away the small bumps that the
 * silhouettes leave, and fewer triangles where the surface is flat.
 */

/** Vertices joined by an edge to each vertex, in compressed rows. */
function neighbours(m: Mesh): { start: Int32Array; list: Int32Array } {
  const n = m.positions.length / 3;
  const t = m.triangles;
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < t.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = t[i + k], b = t[i + ((k + 1) % 3)];
      sets[a].add(b);
      sets[b].add(a);
    }
  const start = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) start[v + 1] = start[v] + sets[v].size;
  const list = new Int32Array(start[n]);
  for (let v = 0; v < n; v++) list.set([...sets[v]], start[v]);
  return { start, list };
}

/**
 * Taubin smoothing: each pass pulls every vertex towards the average of its neighbours,
 * then pushes it back a little further. Bumps flatten out while the object keeps its
 * size, which plain averaging would shrink. Vertices on the base stay on the table.
 */
export function smooth(m: Mesh, passes: number): Mesh {
  if (passes <= 0) return m;
  const { start, list } = neighbours(m);
  const n = m.positions.length / 3;
  let p: Float32Array = Float32Array.from(m.positions);
  let next: Float32Array = new Float32Array(p.length);
  const base = new Uint8Array(n);
  for (let v = 0; v < n; v++) base[v] = p[v * 3 + 2] < 1e-3 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++)
    for (const factor of [0.5, -0.53]) {
      for (let v = 0; v < n; v++) {
        let sx = 0, sy = 0, sz = 0;
        const count = start[v + 1] - start[v];
        for (let k = start[v]; k < start[v + 1]; k++) {
          const u = list[k] * 3;
          sx += p[u]; sy += p[u + 1]; sz += p[u + 2];
        }
        const o = v * 3;
        if (!count) {
          next[o] = p[o]; next[o + 1] = p[o + 1]; next[o + 2] = p[o + 2];
          continue;
        }
        next[o] = p[o] + factor * (sx / count - p[o]);
        next[o + 1] = p[o + 1] + factor * (sy / count - p[o + 1]);
        next[o + 2] = base[v] ? 0 : Math.max(0, p[o + 2] + factor * (sz / count - p[o + 2]));
      }
      [p, next] = [next, p];
    }
  return { positions: p, triangles: m.triangles };
}

/**
 * Fewer triangles with little change of shape (quadric error metrics, after Garland and
 * Heckbert): edges are collapsed one by one, cheapest first, where the cost of an edge
 * is how far its merged vertex would sit from the planes of the triangles around it.
 * Flat parts lose many triangles, curved ones few. Collapses that would fold a triangle
 * over are skipped, so the surface stays closed and facing outwards.
 */
export function simplify(m: Mesh, target: number): Mesh {
  let nt = m.triangles.length / 3;
  if (nt <= target) return m;
  const nv = m.positions.length / 3;
  const P = Float64Array.from(m.positions);
  let tri = Int32Array.from(m.triangles);
  let deleted = new Uint8Array(nt);
  let dirty = new Uint8Array(nt);
  let err = new Float64Array(nt * 4);
  let normal = new Float64Array(nt * 3);
  const Q = new Float64Array(nv * 10);
  const border = new Uint8Array(nv);
  // Triangles around each vertex, as (triangle, corner) pairs; rebuilt now and then.
  let refT: number[] = [], refC: number[] = [];
  const tstart = new Int32Array(nv), tcount = new Int32Array(nv);

  const setNormal = (t: number): boolean => {
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!l) return false;
    normal[t * 3] = nx / l; normal[t * 3 + 1] = ny / l; normal[t * 3 + 2] = nz / l;
    return true;
  };

  // Error of placing a vertex at (x, y, z) for the quadric starting at q[o].
  const qerr = (q: Float64Array, o: number, x: number, y: number, z: number) =>
    q[o] * x * x + 2 * q[o + 1] * x * y + 2 * q[o + 2] * x * z + 2 * q[o + 3] * x
    + q[o + 4] * y * y + 2 * q[o + 5] * y * z + 2 * q[o + 6] * y
    + q[o + 7] * z * z + 2 * q[o + 8] * z + q[o + 9];

  const sum = new Float64Array(10);
  const best = new Float64Array(3);
  /** Cost of merging vertices a and b; the merged position goes to `best`. */
  const edgeError = (a: number, b: number): number => {
    for (let k = 0; k < 10; k++) sum[k] = Q[a * 10 + k] + Q[b * 10 + k];
    const q = sum;
    const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
    if (Math.abs(det) > 1e-9 && !border[a] && !border[b]) {
      // Minimum of the quadric: solve A·x = −(q3, q6, q8).
      const bx = -q[3], by = -q[6], bz = -q[8];
      best[0] = (bx * (q[4] * q[7] - q[5] * q[5]) - q[1] * (by * q[7] - q[5] * bz) + q[2] * (by * q[5] - q[4] * bz)) / det;
      best[1] = (q[0] * (by * q[7] - bz * q[5]) - bx * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * bz - by * q[2])) / det;
      best[2] = (q[0] * (q[4] * bz - q[5] * by) - q[1] * (q[1] * bz - by * q[2]) + bx * (q[1] * q[5] - q[4] * q[2])) / det;
      // Far away means nearly flat around the edge: the ends or the middle do as well.
      const len = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
      const mx = (P[a * 3] + P[b * 3]) / 2, my = (P[a * 3 + 1] + P[b * 3 + 1]) / 2, mz = (P[a * 3 + 2] + P[b * 3 + 2]) / 2;
      if (Math.hypot(best[0] - mx, best[1] - my, best[2] - mz) < 2 * len + 1e-6) return qerr(q, 0, best[0], best[1], best[2]);
    }
    let e = Infinity;
    for (const [x, y, z] of [
      [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]],
      [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]],
      [(P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2],
    ]) {
      const v = qerr(q, 0, x, y, z);
      if (v < e) {
        e = v;
        best[0] = x; best[1] = y; best[2] = z;
      }
    }
    return e;
  };

  const setErrors = (t: number) => {
    for (let j = 0; j < 3; j++) err[t * 4 + j] = edgeError(tri[t * 3 + j], tri[t * 3 + ((j + 1) % 3)]);
    err[t * 4 + 3] = Math.min(err[t * 4], err[t * 4 + 1], err[t * 4 + 2]);
  };

  const rebuild = (first: boolean) => {
    if (!first) {
      // Drop deleted triangles.
      let k = 0;
      for (let t = 0; t < nt; t++)
        if (!deleted[t]) {
          if (k !== t) {
            tri.copyWithin(k * 3, t * 3, t * 3 + 3);
            err.copyWithin(k * 4, t * 4, t * 4 + 4);
            normal.copyWithin(k * 3, t * 3, t * 3 + 3);
          }
          k++;
        }
      nt = k;
      tri = tri.subarray(0, nt * 3);
      err = err.subarray(0, nt * 4);
      normal = normal.subarray(0, nt * 3);
      deleted = new Uint8Array(nt);
      dirty = new Uint8Array(nt);
    }
    tcount.fill(0);
    for (let i = 0; i < nt * 3; i++) tcount[tri[i]]++;
    let s = 0;
    for (let v = 0; v < nv; v++) {
      tstart[v] = s;
      s += tcount[v];
    }
    refT = new Array(nt * 3);
    refC = new Array(nt * 3);
    const fill = new Int32Array(nv);
    for (let t = 0; t < nt; t++)
      for (let j = 0; j < 3; j++) {
        const v = tri[t * 3 + j];
        const k = tstart[v] + fill[v]++;
        refT[k] = t;
        refC[k] = j;
      }
    if (first) {
      // Edges used by one triangle only are open borders: their vertices stay put.
      const seen = new Map<number, number>();
      for (let t = 0; t < nt; t++)
        for (let j = 0; j < 3; j++) {
          const a = tri[t * 3 + j], b = tri[t * 3 + ((j + 1) % 3)];
          const key = Math.min(a, b) * nv + Math.max(a, b);
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      for (const [key, count] of seen)
        if (count === 1) {
          border[Math.floor(key / nv)] = 1;
          border[key % nv] = 1;
        }
      for (let t = 0; t < nt; t++) {
        if (!setNormal(t)) normal.fill(0, t * 3, t * 3 + 3);
        const [x, y, z] = [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]];
        const a = tri[t * 3] * 3;
        const d = -(x * P[a] + y * P[a + 1] + z * P[a + 2]);
        const plane = [x * x, x * y, x * z, x * d, y * y, y * z, y * d, z * z, z * d, d * d];
        for (let j = 0; j < 3; j++) {
          const o = tri[t * 3 + j] * 10;
          for (let k = 0; k < 10; k++) Q[o + k] += plane[k];
        }
      }
      for (let t = 0; t < nt; t++) setErrors(t);
    }
  };

  /** Would moving vertex v (merging it with `other`) to `best` fold one of its triangles? */
  const flips = (v: number, other: number, gone: Uint8Array, x: number, y: number, z: number): boolean => {
    for (let k = 0; k < tcount[v]; k++) {
      const r = tstart[v] + k;
      const t = refT[r], c = refC[r];
      if (deleted[t]) continue;
      const a = tri[t * 3 + ((c + 1) % 3)], b = tri[t * 3 + ((c + 2) % 3)];
      if (a === other || b === other) {
        gone[k] = 1;
        continue;
      }
      gone[k] = 0;
      let ux = P[a * 3] - x, uy = P[a * 3 + 1] - y, uz = P[a * 3 + 2] - z;
      let vx = P[b * 3] - x, vy = P[b * 3 + 1] - y, vz = P[b * 3 + 2] - z;
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
      if (!lu || !lv) return true;
      ux /= lu; uy /= lu; uz /= lu; vx /= lv; vy /= lv; vz /= lv;
      if (Math.abs(ux * vx + uy * vy + uz * vz) > 0.999) return true;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ln = Math.hypot(nx, ny, nz);
      if ((nx * normal[t * 3] + ny * normal[t * 3 + 1] + nz * normal[t * 3 + 2]) / ln < 0.2) return true;
    }
    return false;
  };

  let alive = nt;
  /** Points the triangles of v at `to`; those that `gone` marks collapse with the edge. */
  const relink = (v: number, to: number, gone: Uint8Array) => {
    for (let k = 0; k < tcount[v]; k++) {
      const r = tstart[v] + k;
      const t = refT[r], c = refC[r];
      if (deleted[t]) continue;
      if (gone[k]) {
        deleted[t] = 1;
        alive--;
        continue;
      }
      tri[t * 3 + c] = to;
      dirty[t] = 1;
      setNormal(t);
      setErrors(t);
      refT.push(t);
      refC.push(c);
    }
  };

  let goneA = new Uint8Array(64), goneB = new Uint8Array(64);
  rebuild(true);
  for (let iter = 0; iter < 200 && alive > target; iter++) {
    if (iter % 5 === 0 && iter) rebuild(false);
    dirty.fill(0);
    // Ever larger errors are allowed as the passes go on: the cheapest edges go first.
    const threshold = 1e-9 * (iter + 3) ** 7;
    for (let t = 0; t < nt && alive > target; t++) {
      if (err[t * 4 + 3] > threshold || deleted[t] || dirty[t]) continue;
      for (let j = 0; j < 3; j++) {
        if (err[t * 4 + j] > threshold) continue;
        const a = tri[t * 3 + j], b = tri[t * 3 + ((j + 1) % 3)];
        if (border[a] || border[b]) continue;
        edgeError(a, b);
        const [x, y, z] = best;
        if (goneA.length < tcount[a]) goneA = new Uint8Array(tcount[a] * 2);
        if (goneB.length < tcount[b]) goneB = new Uint8Array(tcount[b] * 2);
        if (flips(a, b, goneA, x, y, z) || flips(b, a, goneB, x, y, z)) continue;
        // Merge b into a.
        P[a * 3] = x; P[a * 3 + 1] = y; P[a * 3 + 2] = z;
        for (let k = 0; k < 10; k++) Q[a * 10 + k] += Q[b * 10 + k];
        const first = refT.length;
        relink(a, a, goneA);
        relink(b, a, goneB);
        tstart[a] = first;
        tcount[a] = refT.length - first;
        tcount[b] = 0;
        break;
      }
    }
  }
  rebuild(false);

  // Keep only the vertices still in use.
  const index = new Int32Array(nv).fill(-1);
  const pos: number[] = [];
  const out = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) {
    const v = tri[i];
    if (index[v] < 0) {
      index[v] = pos.length / 3;
      pos.push(P[v * 3], P[v * 3 + 1], Math.max(0, P[v * 3 + 2]));
    }
    out[i] = index[v];
  }
  return { positions: Float32Array.from(pos), triangles: out };
}
