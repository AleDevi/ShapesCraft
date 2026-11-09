import { describe, expect, it } from 'vitest';
import { carve, measure } from '../src/scan3d/carve';
import { matById, type MatId } from '../src/scan3d/mat';
import { signedVolume, stl, surface } from '../src/scan3d/mesh';
import { snap } from '../src/scan3d/stereo';
import { shootColor, type Solid } from './synthetic3d';
import type { Vec3 } from '../src/scan3d/pose';

/** Frames from a video around the mat: rounds at a few heights, the way the app asks for. */
function circle(matId: MatId, solid: Solid) {
  const c = matById(matId).center;
  const views = [];
  // About 40 frames, like the app takes from a video, each round starting somewhere else.
  for (const [elev, n, dist, start] of [[30, 16, 400, 0.1], [55, 14, 440, 0.3], [70, 10, 450, 0.2]] as const)
    for (let k = 0; k < n; k++) {
      const a = ((k + start) / n) * 2 * Math.PI;
      const e = (elev * Math.PI) / 180;
      const cam: Vec3 = [c.x + dist * Math.cos(e) * Math.sin(a), c.y + dist * Math.cos(e) * Math.cos(a), -dist * Math.sin(e)];
      views.push(shootColor(cam, 0.85 * 640, 360, 640, matId, solid));
    }
  return views;
}

describe('3D model from silhouettes', () => {
  it('rebuilds a box at its real size', { timeout: 60000 }, async () => {
    const mat = matById('round');
    const box: Solid = { kind: 'box', x: mat.center.x, y: mat.center.y, w: 50, d: 36, h: 60, rgb: [40, 60, 160] };
    const vol = await carve(mat, circle('round', box));
    const m = measure(vol)!;
    // Silhouettes see a box's corners from a few directions only, and a flat top only
    // edge-on, so the shape comes out slightly bigger, with a low roof: never smaller.
    const near = (got: number, real: number, spare = 0.1) => {
      expect(got).toBeGreaterThan(real - 2);
      expect(got).toBeLessThan(real * (1 + spare) + 1);
    };
    near(m.width, 50);
    near(m.depth, 36);
    near(m.height, 60, 0.15);
    near(m.volumeMl, (50 * 36 * 60) / 1000);

    const mesh = surface(vol, mat.center);
    const v = signedVolume(mesh) / 1000;
    expect(v).toBeGreaterThan(m.volumeMl * 0.85);
    expect(v).toBeLessThan(m.volumeMl * 1.1);
    // Standing on the table, the right way up.
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      zmin = Math.min(zmin, mesh.positions[i]);
      zmax = Math.max(zmax, mesh.positions[i]);
    }
    expect(zmin).toBeCloseTo(0, 5);
    near(zmax, 60, 0.15);
    const file = stl(mesh);
    expect(file.byteLength).toBe(84 + 50 * (mesh.triangles.length / 3));
  });

  it('rebuilds a dark cup-sized cylinder', { timeout: 60000 }, async () => {
    const mat = matById('round-small');
    const cup: Solid = { kind: 'cylinder', x: mat.center.x, y: mat.center.y, r: 25, h: 45, rgb: [50, 40, 35] };
    const m = measure(await carve(mat, circle('round-small', cup)))!;
    expect(Math.abs(m.width - 50)).toBeLessThan(2);
    expect(Math.abs(m.depth - 50)).toBeLessThan(2);
    // The flat top is seen edge-on only: a shallow cone grows on it.
    expect(m.height).toBeGreaterThan(44);
    expect(m.height).toBeLessThan(45 + 12);
    const ideal = (Math.PI * 25 * 25 * 45) / 1000;
    expect(m.volumeMl).toBeGreaterThan(ideal * 0.97);
    expect(m.volumeMl).toBeLessThan(ideal * 1.15);
  });

  it('gives an empty result when nothing stands on the mat', { timeout: 60000 }, async () => {
    const mat = matById('round');
    const none: Solid = { kind: 'box', x: -500, y: -500, w: 1, d: 1, h: 1, rgb: [0, 0, 0] };
    expect(measure(await carve(mat, circle('round', none)))).toBeNull();
  });
});

describe('depth from several views', () => {
  it('flattens the top of a box with a printed pattern', { timeout: 120000 }, async () => {
    const mat = matById('round');
    const box: Solid = { kind: 'box', x: mat.center.x, y: mat.center.y, w: 50, d: 36, h: 30, rgb: [200, 160, 40], pattern: true };
    const views = circle('round', box);
    // Silhouettes alone leave a roof several millimetres high on the flat top.
    const hull = measure(await carve(mat, views, undefined, 2, false))!;
    expect(hull.height).toBeGreaterThan(34);
    const m = measure(await carve(mat, views))!;
    expect(m.height).toBeLessThan(32.5);
    expect(m.height).toBeGreaterThan(28);
    expect(m.width).toBeGreaterThan(48);
    expect(m.volumeMl).toBeGreaterThan((50 * 36 * 30) / 1000);
  });

  it('moves the surface onto the measured points', { timeout: 120000 }, async () => {
    const mat = matById('round');
    const box: Solid = { kind: 'box', x: mat.center.x, y: mat.center.y, w: 50, d: 36, h: 30, rgb: [200, 160, 40], pattern: true };
    const vol = await carve(mat, circle('round', box));
    expect(vol.points!.length).toBeGreaterThan(3000);
    // Distance of the vertices (off the base) from the real box, median.
    const off = (m: { positions: Float32Array }) => {
      const p = m.positions, e: number[] = [];
      for (let i = 0; i < p.length; i += 3) {
        if (p[i + 2] < 1) continue;
        const dx = Math.abs(p[i]) - 25, dy = Math.abs(p[i + 1]) - 18, dz = Math.abs(p[i + 2] - 15) - 15;
        e.push(Math.abs(Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0)));
      }
      return e.sort((a, b) => a - b)[e.length >> 1];
    };
    const mesh = surface(vol, mat.center);
    const snapped = snap(mesh, vol.points!, mat.center, vol.voxel);
    expect(off(snapped)).toBeLessThan(off(mesh) * 0.8);
    expect(snapped.triangles).toBe(mesh.triangles);
  });
});

describe('colour models', () => {
  it('tells two colour families apart', async () => {
    const { fit, logLikelihood } = await import('../src/scan3d/colors');
    const dark: number[] = [], red: number[] = [];
    for (let i = 0; i < 600; i++) {
      const n = () => (Math.sin(i * 12.9898) * 43758.5453) % 0.03;
      dark.push(0.15 + n(), 0.14 - n(), 0.13 + n());
      red.push(0.8 - n(), 0.2 + n(), 0.2 - n());
    }
    const a = fit(Float64Array.from(dark), 3), b = fit(Float64Array.from(red), 3);
    expect(logLikelihood(a, 0.15, 0.14, 0.13)).toBeGreaterThan(logLikelihood(b, 0.15, 0.14, 0.13) + 10);
    expect(logLikelihood(b, 0.8, 0.2, 0.2)).toBeGreaterThan(logLikelihood(a, 0.8, 0.2, 0.2) + 10);
  });
});
