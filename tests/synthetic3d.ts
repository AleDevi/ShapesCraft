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
export function shoot(c: Vec3, f: number, width: number, height: number, matId: MatId = 'rect'): Gray {
  const mat = matById(matId);
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

