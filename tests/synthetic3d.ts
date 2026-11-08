import { markerCells } from '../src/core/frame';
import { invert3, applyH, type Mat3 } from '../src/core/homography';
import type { Gray } from '../src/core/image';
import { matById, type MatId, type MatLayout } from '../src/scan3d/mat';
import type { Vec3 } from '../src/scan3d/pose';

/** Brightness of a printed mat at a point in mm, lying on a darker table. */
function matValue(mat: MatLayout, x: number, y: number): number {
  if (x < 0 || y < 0 || x > mat.width || y > mat.height) return 0.3;
  for (const m of mat.markers) {
    const [c0, c1, , c3] = m.corners;
    // Position inside the (possibly rotated) marker square, as fractions of its sides.
    const ux = c1.x - c0.x, uy = c1.y - c0.y, vx = c3.x - c0.x, vy = c3.y - c0.y;
    const s2 = ux * ux + uy * uy;
    const a = ((x - c0.x) * ux + (y - c0.y) * uy) / s2;
    const b = ((x - c0.x) * vx + (y - c0.y) * vy) / s2;
    if (a >= 0 && a < 1 && b >= 0 && b < 1) {
      const cells = markerCells(m.id);
      const n = cells.length;
      return cells[Math.floor(b * n)][Math.floor(a * n)] ? 0.95 : 0.08;
    }
  }
  return 0.95;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** A camera at `c` (mat mm, z into the table) looking at the mat centre, and its photo. */
export function shoot(c: Vec3, f: number, width: number, height: number, matId: MatId | MatLayout = 'rect'): Gray {
  const mat = typeof matId === 'string' ? matById(matId) : matId;
  const target: Vec3 = [mat.center.x, mat.center.y, 0];
  const z = unit(sub(target, c));
  const x = unit(cross(z, [0, 0, -1]));
  const y = cross(z, x);
  const R = [...x, ...y, ...z];
  const t: Vec3 = [-(x[0] * c[0] + x[1] * c[1] + x[2] * c[2]), -(y[0] * c[0] + y[1] * c[1] + y[2] * c[2]), -(z[0] * c[0] + z[1] * c[1] + z[2] * c[2])];
  const cx = width / 2;
  const cy = height / 2;
  const H: Mat3 = [f * R[0] + cx * R[6], f * R[1] + cx * R[7], f * t[0] + cx * t[2],
    f * R[3] + cy * R[6], f * R[4] + cy * R[7], f * t[1] + cy * t[2],
    R[6], R[7], t[2]];
  const back = invert3(H);
  const data = new Float32Array(width * height);
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      let v = 0;
      for (const sy of [0.25, 0.75])
        for (const sx of [0.25, 0.75]) {
          const p = applyH(back, { x: px + sx, y: py + sy });
          v += matValue(mat, p.x, p.y);
        }
      data[py * width + px] = v / 4;
    }
  return { width, height, data };
}


/** An object standing on the mat: an upright box or cylinder, in mat mm (height up from the table). */
export type Solid =
  | { kind: 'box'; x: number; y: number; w: number; d: number; h: number; rgb: [number, number, number] }
  | { kind: 'cylinder'; x: number; y: number; r: number; h: number; rgb: [number, number, number] };

/** Distance along the ray o + s·d to the solid, or Infinity. Mat coordinates: z into the table. */
function hit(o: Vec3, d: Vec3, s: Solid): number {
  // Slab test on z (height h above the table means z from −h to 0).
  const slab = (o0: number, d0: number, lo: number, hi: number): [number, number] => {
    if (Math.abs(d0) < 1e-12) return o0 >= lo && o0 <= hi ? [-Infinity, Infinity] : [Infinity, -Infinity];
    const a = (lo - o0) / d0, b = (hi - o0) / d0;
    return a < b ? [a, b] : [b, a];
  };
  let [t0, t1] = slab(o[2], d[2], -s.h, 0);
  if (s.kind === 'box') {
    const [a0, a1] = slab(o[0], d[0], s.x - s.w / 2, s.x + s.w / 2);
    const [b0, b1] = slab(o[1], d[1], s.y - s.d / 2, s.y + s.d / 2);
    t0 = Math.max(t0, a0, b0);
    t1 = Math.min(t1, a1, b1);
  } else {
    const ox = o[0] - s.x, oy = o[1] - s.y;
    const A = d[0] * d[0] + d[1] * d[1], B = 2 * (ox * d[0] + oy * d[1]), C = ox * ox + oy * oy - s.r * s.r;
    const disc = B * B - 4 * A * C;
    if (A < 1e-12 || disc < 0) return Infinity;
    const q = Math.sqrt(disc);
    t0 = Math.max(t0, (-B - q) / (2 * A));
    t1 = Math.min(t1, (-B + q) / (2 * A));
  }
  return t0 <= t1 && t0 > 0 ? t0 : Infinity;
}

/** A colour frame of `solid` on the mat from camera `c`, with its exact pose and focal length in pixels. */
export function shootColor(c: Vec3, f: number, width: number, height: number, matId: MatId, solid: Solid) {
  const mat = matById(matId);
  const target: Vec3 = [mat.center.x, mat.center.y, -20];
  const z = unit(sub(target, c));
  const x = unit(cross(z, [0, 0, -1]));
  const y = cross(z, x);
  const R = [...x, ...y, ...z];
  const t: Vec3 = [-(x[0] * c[0] + x[1] * c[1] + x[2] * c[2]), -(y[0] * c[0] + y[1] * c[1] + y[2] * c[2]), -(z[0] * c[0] + z[1] * c[1] + z[2] * c[2])];
  const data = new Uint8ClampedArray(width * height * 4);
  // Paper slightly warm, as under indoor light; a brown table around it.
  const paper = [235, 228, 215];
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      const u = (px + 0.5 - width / 2) / f, v = (py + 0.5 - height / 2) / f;
      const d = unit([x[0] * u + y[0] * v + z[0], x[1] * u + y[1] * v + z[1], x[2] * u + y[2] * v + z[2]]);
      const s = hit(c, d, solid);
      let rgb: number[];
      if (s < Infinity) {
        // A little shading so the faces differ.
        const shade = 0.75 + 0.25 * Math.abs(d[0]);
        rgb = solid.rgb.map((k) => k * shade);
      } else {
        const k = -c[2] / d[2];
        const mx = c[0] + k * d[0], my = c[1] + k * d[1];
        const off = mat.round ? Math.hypot(mx - mat.center.x, my - mat.center.y) > mat.round.cut : mx < 0 || my < 0 || mx > mat.width || my > mat.height;
        if (off) rgb = [120, 85, 60];
        else {
          const value = matValue(mat, mx, my);
          rgb = paper.map((p) => p * value / 0.95);
        }
      }
      const o = (py * width + px) * 4;
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
    }
  return { image: { width, height, data }, pose: { R, t }, focal: f };
}
