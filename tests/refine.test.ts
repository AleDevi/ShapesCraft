import { describe, expect, it } from 'vitest';
import { carve } from '../src/scan3d/carve';
import { matById } from '../src/scan3d/mat';
import { signedVolume, surface, type Mesh } from '../src/scan3d/mesh';
import { simplify, smooth } from '../src/scan3d/refine';
import { shootColor } from './synthetic3d';
import type { Vec3 } from '../src/scan3d/pose';

/** Every edge shared by exactly two triangles, in opposite directions: closed and consistently oriented. */
function closed(m: Mesh): boolean {
  const edges = new Map<string, number>();
  const t = m.triangles;
  for (let i = 0; i < t.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const key = `${t[i + k]},${t[i + ((k + 1) % 3)]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (const [key, n] of edges) {
    const [a, b] = key.split(',');
    if (n !== 1 || edges.get(`${b},${a}`) !== 1) return false;
  }
  return true;
}

/** Spread of the vertices' distance from the cylinder's axis, on its side: a measure of bumpiness. */
function roughness(m: Mesh, r: number): number {
  const p = m.positions;
  let s = 0, n = 0;
  for (let i = 0; i < p.length; i += 3)
    if (p[i + 2] > 10 && p[i + 2] < 35) {
      s += (Math.hypot(p[i], p[i + 1]) - r) ** 2;
      n++;
    }
  return Math.sqrt(s / n);
}

describe('smoothing and simplifying the model', async () => {
  const mat = matById('round');
  const c = mat.center;
  const views = [];
  for (const [elev, n, dist, start] of [[30, 16, 400, 0.1], [55, 14, 440, 0.3], [70, 10, 450, 0.2]] as const)
    for (let k = 0; k < n; k++) {
      const a = ((k + start) / n) * 2 * Math.PI, e = (elev * Math.PI) / 180;
      const cam: Vec3 = [c.x + dist * Math.cos(e) * Math.sin(a), c.y + dist * Math.cos(e) * Math.cos(a), -dist * Math.sin(e)];
      views.push(shootColor(cam, 0.85 * 640, 360, 640, 'round', { kind: 'cylinder', x: c.x, y: c.y, r: 28, h: 45, rgb: [150, 40, 40] }));
    }
  const mesh = surface(await carve(mat, views), mat.center);

  it('smooths bumps without shrinking the object', () => {
    const smoothed = smooth(mesh, 10);
    expect(closed(smoothed)).toBe(true);
    expect(roughness(smoothed, 28)).toBeLessThan(roughness(mesh, 28));
    expect(Math.abs(signedVolume(smoothed) / signedVolume(mesh) - 1)).toBeLessThan(0.02);
    let zmin = Infinity;
    for (let i = 2; i < smoothed.positions.length; i += 3) zmin = Math.min(zmin, smoothed.positions[i]);
    expect(zmin).toBe(0);
  });

  it('keeps the shape with a fraction of the triangles', () => {
    const before = mesh.triangles.length / 3;
    const fewer = simplify(smooth(mesh, 10), 3000);
    expect(fewer.triangles.length / 3).toBeLessThanOrEqual(3000);
    expect(fewer.triangles.length / 3).toBeGreaterThan(1500);
    expect(before).toBeGreaterThan(10000);
    expect(closed(fewer)).toBe(true);
    expect(Math.abs(signedVolume(fewer) / signedVolume(mesh) - 1)).toBeLessThan(0.03);
  });
});
