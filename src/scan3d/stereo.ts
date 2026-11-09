import type { Volume } from './carve';
import { hullMask } from './colors';
import { projection, type View } from './silhouette';

/**
 * Depth from several views ("multi-view stereo"). The camera of every frame is known
 * from the markers, so for each pixel of a frame the app tries a range of distances
 * along its ray: at the right one, the little patch around the pixel looks the same
 * in the neighbouring frames (compared by normalised correlation, so a change in light
 * doesn't matter). Only distances inside the carved shape are tried.
 *
 * The depths that two frames agree on then dig into the carved shape: anything seen
 * through, in front of a measured surface, is empty. That flattens the "roof" that
 * silhouettes leave on a flat top, and opens hollows that the silhouettes can't see,
 * such as the inside of a cup. It needs surfaces with some detail (print, grain,
 * scratches, pattern): on a plain, even surface no depth is found, and the shape stays
 * as the silhouettes made it.
 */

/** Neighbouring frames compared with each frame, and how far round they may be. */
const NEIGHBOURS = 4;
const MIN_ANGLE = 4;
const MAX_ANGLE = 40;
/** Patch compared: (2·R + 1)² pixels. */
const R = 3;
/** Correlation needed to trust a depth, and how far it must beat any other depth. */
const MIN_SCORE = 0.5;
const MARGIN = 0.05;
/** Least contrast of a patch (grey 0..1, standard deviation) for it to be matched. */
const MIN_CONTRAST = 0.012;
/** Depth steps, at most. */
const MAX_STEPS = 160;
/** Votes of "seen through" a cube needs to be carved. */
const FREE_VOTES = 2;

interface Cam {
  P: Float64Array;
  /** Rotation mat → camera, translation, camera centre in mat mm. */
  R: number[];
  t: number[];
  C: number[];
  f: number;
  w: number;
  h: number;
  gray: Float32Array;
}

export function camera(v: View): Cam {
  const { R: rot, t } = v.pose;
  const C = [0, 1, 2].map((i) => -(rot[i] * t[0] + rot[3 + i] * t[1] + rot[6 + i] * t[2]));
  const { width: w, height: h, data } = v.image;
  const gray = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) gray[k] = (0.299 * data[k * 4] + 0.587 * data[k * 4 + 1] + 0.114 * data[k * 4 + 2]) / 255;
  return { P: projection(v), R: rot, t: [...t], C, f: v.focal, w, h, gray };
}

/** A depth map: distance along the camera's axis (mm) per pixel, NaN where unknown. */
export interface DepthMap { depth: Float32Array; w: number; h: number }

/**
 * Carves away what the frames see through. Returns the carved volume (a new one);
 * `onProgress` gets 0..1.
 */
export async function carveByDepth(views: View[], vol: Volume, onProgress: (done: number) => Promise<void> | void = () => undefined): Promise<Volume> {
  const cams = views.map(camera);
  const inside = grown(vol);
  const maps: (DepthMap | null)[] = [];
  const near = neighbours(cams, vol);
  for (let r = 0; r < cams.length; r++) {
    maps.push(near[r].length >= 2 ? depthMap(cams[r], near[r].map((j) => cams[j]), hullMask(views[r], vol), vol, inside) : null);
    await onProgress((0.85 * (r + 1)) / cams.length);
  }
  const checked = maps.map((m, r) => (m ? consistent(cams, maps, r, near[r], vol.voxel) : null));
  const out = seeThrough(cams, checked, vol);
  await onProgress(1);
  return out;
}

/** For each frame, the frames looking from a bit to the side of it. */
export function neighbours(cams: Cam[], vol: Volume): number[][] {
  const mid = centroid(vol);
  const dirs = cams.map((c) => {
    const d = [c.C[0] - mid[0], c.C[1] - mid[1], c.C[2] - mid[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return d.map((x) => x / l);
  });
  return cams.map((_, r) => {
    const cand: { j: number; a: number }[] = [];
    for (let j = 0; j < cams.length; j++) {
      if (j === r) continue;
      const a = (Math.acos(Math.max(-1, Math.min(1, dirs[r][0] * dirs[j][0] + dirs[r][1] * dirs[j][1] + dirs[r][2] * dirs[j][2]))) * 180) / Math.PI;
      if (a >= MIN_ANGLE && a <= MAX_ANGLE) cand.push({ j, a });
    }
    cand.sort((p, q) => p.a - q.a);
    return cand.slice(0, NEIGHBOURS).map((c) => c.j);
  });
}

function centroid(vol: Volume): number[] {
  const { nx, ny, nz, voxel, origin, data } = vol;
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (data[i + nx * (j + ny * k)]) {
          sx += i; sy += j; sz += k; n++;
        }
  n = n || 1;
  return [origin.x + (sx / n) * voxel, origin.y + (sy / n) * voxel, origin.z - (sz / n) * voxel];
}

/** The carved cubes grown by one cube all round: where the surface may be. */
export function grown(vol: Volume): Uint8Array {
  const { nx, ny, nz, data } = vol;
  const out = new Uint8Array(data.length);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!data[i + nx * (j + ny * k)]) continue;
        for (let c = -1; c <= 1; c++)
          for (let b = -1; b <= 1; b++)
            for (let a = -1; a <= 1; a++) {
              const I = i + a, J = j + b, K = k + c;
              if (I >= 0 && J >= 0 && K >= 0 && I < nx && J < ny && K < nz) out[I + nx * (J + ny * K)] = 1;
            }
      }
  return out;
}

function voxelAt(vol: Volume, x: number, y: number, z: number): number {
  const i = Math.round((x - vol.origin.x) / vol.voxel), j = Math.round((y - vol.origin.y) / vol.voxel), k = Math.round((vol.origin.z - z) / vol.voxel);
  return i < 0 || j < 0 || k < 0 || i >= vol.nx || j >= vol.ny || k >= vol.nz ? -1 : i + vol.nx * (j + vol.ny * k);
}

/** Depth along the camera axis of a mat point. */
function camDepth(c: Cam, x: number, y: number, z: number): number {
  return c.R[6] * x + c.R[7] * y + c.R[8] * z + c.t[2];
}

/** Plane sweep: depth of every pixel of `ref` inside the shape's outline. */
export function depthMap(ref: Cam, others: Cam[], hull: Uint8Array, vol: Volume, inside: Uint8Array): DepthMap {
  const { w, h } = ref;
  const depth = new Float32Array(w * h).fill(NaN);
  // The outline's box, and the depth range of the shape for this camera.
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (hull[y * w + x]) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  if (x1 < 0) return { depth, w, h };
  x0 = Math.max(0, x0 - R); y0 = Math.max(0, y0 - R); x1 = Math.min(w - 1, x1 + R); y1 = Math.min(h - 1, y1 + R);
  let zmin = Infinity, zmax = -Infinity;
  const { nx, ny, nz, voxel, origin, data } = vol;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (data[i + nx * (j + ny * k)]) {
          const d = camDepth(ref, origin.x + i * voxel, origin.y + j * voxel, origin.z - k * voxel);
          zmin = Math.min(zmin, d); zmax = Math.max(zmax, d);
        }
  zmin = Math.max(1, zmin - voxel); zmax += voxel;
  const steps = Math.max(2, Math.min(MAX_STEPS, Math.ceil((zmax - zmin) / (voxel * 0.5))));
  const dz = (zmax - zmin) / (steps - 1);

  const W = x1 - x0 + 1, H = y1 - y0 + 1, N = W * H;
  // Each pixel's ray, in mat mm: X(d) = A + d·B, d the depth along the camera axis.
  const A = ref.C;
  const B = new Float64Array(N * 3);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = (x0 + x + 0.5 - cx) / ref.f, v = (y0 + y + 0.5 - cy) / ref.f;
      const q = (y * W + x) * 3;
      // Rᵀ · (u, v, 1)
      for (let a = 0; a < 3; a++) B[q + a] = ref.R[a] * u + ref.R[3 + a] * v + ref.R[6 + a];
    }

  // Reference patches: mean and spread.
  const I = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) I[y * W + x] = ref.gray[(y0 + y) * w + x0 + x];
  const sI = box(I, W, H), sII = box(sq(I), W, H);
  const area = (2 * R + 1) ** 2;
  // Patches with some detail, all inside the outline: at the outline the patch also holds
  // the background, which differs from frame to frame.
  const within = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) within[y * W + x] = hull[(y0 + y) * w + x0 + x];
  const sH = box(within, W, H);
  const textured = new Uint8Array(N);
  for (let q = 0; q < N; q++) {
    const m = sI[q] / area;
    textured[q] = sH[q] >= area - 0.5 && sII[q] / area - m * m >= MIN_CONTRAST * MIN_CONTRAST ? 1 : 0;
  }

  const scores = new Float32Array(N * steps).fill(-2);
  const warped = new Float32Array(N), valid = new Float32Array(N);
  const perView = others.map(() => new Float32Array(N));
  const okView = others.map(() => new Float32Array(N));
  for (let s = 0; s < steps; s++) {
    const d = zmin + s * dz;
    others.forEach((o, n) => {
      const P = o.P;
      for (let q = 0; q < N; q++) {
        const X = A[0] + d * B[q * 3], Y = A[1] + d * B[q * 3 + 1], Z = A[2] + d * B[q * 3 + 2];
        const zz = P[8] * X + P[9] * Y + P[10] * Z + P[11];
        const u = (P[0] * X + P[1] * Y + P[2] * Z + P[3]) / zz - 0.5, v = (P[4] * X + P[5] * Y + P[6] * Z + P[7]) / zz - 0.5;
        if (zz <= 0 || u < 0 || v < 0 || u >= o.w - 1 || v >= o.h - 1) {
          warped[q] = 0;
          valid[q] = 1;
          continue;
        }
        const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv, k = iv * o.w + iu;
        const g = o.gray;
        warped[q] = (g[k] * (1 - fu) + g[k + 1] * fu) * (1 - fv) + (g[k + o.w] * (1 - fu) + g[k + o.w + 1] * fu) * fv;
        valid[q] = 0;
      }
      const sW = box(warped, W, H), sWW = box(sq(warped), W, H), sIW = box(mul(I, warped), W, H), bad = box(valid, W, H);
      const z = perView[n], ok = okView[n];
      for (let q = 0; q < N; q++) {
        ok[q] = bad[q] > 0 ? 0 : 1;
        const mI = sI[q] / area, mW = sW[q] / area;
        const vI = sII[q] / area - mI * mI, vW = sWW[q] / area - mW * mW;
        z[q] = vW > 1e-7 && vI > 1e-7 ? (sIW[q] / area - mI * mW) / Math.sqrt(vI * vW) : -1;
      }
    });
    for (let q = 0; q < N; q++) {
      const y = Math.floor(q / W), x = q - y * W;
      if (!textured[q] || !hull[(y0 + y) * w + x0 + x]) continue;
      // Only depths inside the carved shape.
      const X = A[0] + d * B[q * 3], Y = A[1] + d * B[q * 3 + 1], Z = A[2] + d * B[q * 3 + 2];
      const cell = voxelAt(vol, X, Y, Z);
      if (cell < 0 || !inside[cell]) continue;
      // The two best-matching neighbours: one may not see this point.
      let b1 = -2, b2 = -2;
      for (let n = 0; n < others.length; n++) {
        if (!okView[n][q]) continue;
        const c = perView[n][q];
        if (c > b1) { b2 = b1; b1 = c; } else if (c > b2) b2 = c;
      }
      if (b2 <= -2) continue;
      const sc = (b1 + b2) / 2;
      scores[q * steps + s] = sc;
    }
  }
  for (let q = 0; q < N; q++) {
    const row = q * steps;
    let bi = -1, bv = -2;
    for (let s = 0; s < steps; s++) if (scores[row + s] > bv) { bv = scores[row + s]; bi = s; }
    if (bi < 0 || bv < MIN_SCORE) continue;
    // The best other peak: a repeated pattern or a plain stretch gives several.
    let sv = -2;
    for (let s = 0; s < steps; s++) {
      const v = scores[row + s];
      if (s === bi || v <= sv) continue;
      if ((s > 0 && scores[row + s - 1] > v) || (s < steps - 1 && scores[row + s + 1] >= v)) continue;
      sv = v;
    }
    if (sv > bv - MARGIN) continue;
    // Sub-step refinement on a parabola through the neighbours.
    let off = 0;
    if (bi > 0 && bi < steps - 1 && scores[row + bi - 1] > -2 && scores[row + bi + 1] > -2) {
      const a = scores[row + bi - 1], c = scores[row + bi + 1];
      const den = a - 2 * bv + c;
      if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    const y = Math.floor(q / W), x = q - y * W;
    depth[(y0 + y) * w + x0 + x] = zmin + (bi + off) * dz;
  }
  return { depth, w, h };
}

/** Keeps the depths that at least one neighbouring frame's depths agree with. */
function consistent(cams: Cam[], maps: (DepthMap | null)[], r: number, near: number[], voxel: number): DepthMap {
  const ref = cams[r], m = maps[r]!;
  const out = new Float32Array(m.depth.length).fill(NaN);
  const cx = ref.w / 2, cy = ref.h / 2;
  for (let y = 0; y < ref.h; y++)
    for (let x = 0; x < ref.w; x++) {
      const d = m.depth[y * ref.w + x];
      if (!(d > 0)) continue;
      const u = (x + 0.5 - cx) / ref.f, v = (y + 0.5 - cy) / ref.f;
      const X = [0, 1, 2].map((a) => ref.C[a] + d * (ref.R[a] * u + ref.R[3 + a] * v + ref.R[6 + a]));
      for (const j of near) {
        const o = cams[j], om = maps[j];
        if (!om) continue;
        const P = o.P;
        const zz = P[8] * X[0] + P[9] * X[1] + P[10] * X[2] + P[11];
        if (zz <= 0) continue;
        const pu = Math.floor((P[0] * X[0] + P[1] * X[1] + P[2] * X[2] + P[3]) / zz), pv = Math.floor((P[4] * X[0] + P[5] * X[1] + P[6] * X[2] + P[7]) / zz);
        if (pu < 0 || pv < 0 || pu >= o.w || pv >= o.h) continue;
        const od = om.depth[pv * o.w + pu];
        if (od > 0 && Math.abs(od - zz) <= tolerance(voxel, zz)) {
          out[y * ref.w + x] = d;
          break;
        }
      }
    }
  return { depth: out, w: m.w, h: m.h };
}

function tolerance(voxel: number, depth: number): number {
  return Math.max(1.2 * voxel, 0.004 * depth);
}

/** Carves the cubes that frames see through: in front of a measured surface. */
function seeThrough(cams: Cam[], maps: (DepthMap | null)[], vol: Volume): Volume {
  const { nx, ny, nz, voxel, origin, data } = vol;
  const free = new Uint8Array(data.length), surface = new Uint8Array(data.length);
  cams.forEach((c, n) => {
    const m = maps[n];
    if (!m) return;
    const P = c.P;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const q = i + nx * (j + ny * k);
          if (!data[q]) continue;
          const x = origin.x + i * voxel, y = origin.y + j * voxel, z = origin.z - k * voxel;
          const zz = P[8] * x + P[9] * y + P[10] * z + P[11];
          if (zz <= 0) continue;
          const u = Math.floor((P[0] * x + P[1] * y + P[2] * z + P[3]) / zz), v = Math.floor((P[4] * x + P[5] * y + P[6] * z + P[7]) / zz);
          if (u < 0 || v < 0 || u >= c.w || v >= c.h) continue;
          const d = m.depth[v * c.w + u];
          if (!(d > 0)) continue;
          const tol = tolerance(voxel, zz);
          if (zz < d - tol) free[q] = Math.min(255, free[q] + 1);
          else if (zz <= d + tol) surface[q] = Math.min(255, surface[q] + 1);
        }
  });
  const seen = new Uint8Array(data.length);
  for (let q = 0; q < data.length; q++) if (data[q] && free[q] >= FREE_VOTES && free[q] > surface[q]) seen[q] = 1;
  return { ...vol, data: dig(vol, seen) };
}

/**
 * Takes away the cubes seen through, but only as digging from the outside: a pocket
 * inside the shape that no seen-through path reaches is a mismatch, and stays. Single
 * cubes left standing alone in the dug space, or dug alone in the solid, follow their
 * neighbours, so the surface stays whole.
 */
function dig(vol: Volume, seen: Uint8Array): Uint8Array {
  const { nx, ny, nz, data } = vol;
  const n = data.length;
  const out = Uint8Array.from(data);
  // Empty space (or seen-through cubes) reachable from outside the grid or from empty cubes.
  const open = new Uint8Array(n);
  const stack: number[] = [];
  for (let q = 0; q < n; q++) if (!data[q]) { open[q] = 1; stack.push(q); }
  while (stack.length) {
    const q = stack.pop()!;
    const i = q % nx, j = Math.floor(q / nx) % ny, k = Math.floor(q / (nx * ny));
    const step = (r: number) => {
      if (!open[r] && seen[r]) { open[r] = 1; stack.push(r); }
    };
    if (i > 0) step(q - 1);
    if (i < nx - 1) step(q + 1);
    if (j > 0) step(q - nx);
    if (j < ny - 1) step(q + nx);
    if (k > 0) step(q - nx * ny);
    if (k < nz - 1) step(q + nx * ny);
  }
  for (let q = 0; q < n; q++) if (data[q] && open[q]) out[q] = 0;
  // Majority of the 26 neighbours, twice, for the cubes near what was dug.
  for (let pass = 0; pass < 3; pass++) {
    const src = Uint8Array.from(out);
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++)
        for (let i = 1; i < nx - 1; i++) {
          const q = i + nx * (j + ny * k);
          if (!data[q] || !(seen[q] || open[q] || near(seen, q, nx, ny))) continue;
          let s = 0;
          for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) s += src[q + a + nx * (b + ny * c)];
          s -= src[q];
          if (src[q] && s < 13) out[q] = 0;
          else if (!src[q] && s > 13) out[q] = 1;
        }
  }
  return out;
}

function near(m: Uint8Array, q: number, nx: number, ny: number): boolean {
  return !!(m[q - 1] || m[q + 1] || m[q - nx] || m[q + nx] || m[q - nx * ny] || m[q + nx * ny]);
}

/** Sum over the (2R+1)² square around each pixel (cut at the edges). */
function box(a: Float32Array, W: number, H: number): Float32Array {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < H; y++) {
    let s = 0;
    const row = y * W;
    for (let x = 0; x < Math.min(R, W); x++) s += a[row + x];
    for (let x = 0; x < W; x++) {
      if (x + R < W) s += a[row + x + R];
      if (x - R - 1 >= 0) s -= a[row + x - R - 1];
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < Math.min(R, H); y++) s += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + R < H) s += tmp[(y + R) * W + x];
      if (y - R - 1 >= 0) s -= tmp[(y - R - 1) * W + x];
      out[y * W + x] = s;
    }
  }
  return out;
}

function sq(a: Float32Array): Float32Array {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] * a[i];
  return o;
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i];
  return o;
}
