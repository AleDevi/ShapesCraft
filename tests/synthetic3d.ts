import { markerCells } from '../src/core/frame';
import { invert3, applyH, type Mat3 } from '../src/core/homography';
import type { Gray } from '../src/core/image';
import { MAT, matMarkers } from '../src/scan3d/mat';
import type { Vec3 } from '../src/scan3d/pose';

const markers = matMarkers();

/** Brightness of the printed mat at a point in mm, lying on a darker table. */
function matValue(x: number, y: number): number {
  if (x < 0 || y < 0 || x > MAT.width || y > MAT.height) return 0.3;
  for (const m of markers) {
    const o = m.corners[0];
    const s = MAT.marker;
    if (x >= o.x && x < o.x + s && y >= o.y && y < o.y + s) {
      const cells = markerCells(m.id);
      const n = cells.length;
      return cells[Math.floor(((y - o.y) / s) * n)][Math.floor(((x - o.x) / s) * n)] ? 0.95 : 0.08;
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
export function shoot(c: Vec3, f: number, width: number, height: number): Gray {
  const target: Vec3 = [MAT.width / 2, MAT.height / 2, 0];
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
          v += matValue(p.x, p.y);
        }
      data[py * width + px] = v / 4;
    }
  return { width, height, data };
}

