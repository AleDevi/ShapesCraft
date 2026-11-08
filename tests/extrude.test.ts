import { describe, expect, it } from 'vitest';
import { extrude } from '../src/core/extrude';
import { signedVolume as volume, type Mesh } from '../src/scan3d/mesh';
import type { Point } from '../src/core/homography';

const rect = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const circle = (cx: number, cy: number, r: number, n = 90): Point[] =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));

/** Every edge is shared by exactly two triangles that run along it in opposite directions. */
function expectClosed(m: Mesh) {
  const edges = new Map<string, number>();
  const t = m.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = t[i + k], b = t[i + ((k + 1) % 3)];
      const key = `${a},${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [key, n] of edges) {
    const [a, b] = key.split(',');
    if (n !== 1 || edges.get(`${b},${a}`) !== 1) bad++;
  }
  expect(bad).toBe(0);
}

function bounds(m: Mesh) {
  const p = m.positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
  return { lo, hi };
}

describe('extrude', () => {
  it('turns a square into a closed block of the chosen thickness', () => {
    const m = extrude([rect(10, 10, 20, 20)], { thicknessMm: 3, roundMm: 0 });
    expectClosed(m);
    expect(volume(m)).toBeCloseTo(1200, -1);
    const { lo, hi } = bounds(m);
    expect(lo[2]).toBe(0);
    expect(hi[2]).toBeCloseTo(3, 5);
    expect(hi[0] - lo[0]).toBeCloseTo(20, 0);
    expect(lo[0]).toBeCloseTo(-10, 0);
  });

  it('keeps holes open', () => {
    const m = extrude([circle(30, 30, 20), circle(30, 30, 10)], { thicknessMm: 2, roundMm: 0 });
    expectClosed(m);
    expect(volume(m)).toBeCloseTo(Math.PI * (400 - 100) * 2, -1);
  });

  it('rounds the top edge with a quarter circle', () => {
    const r = 1.5, T = 4, R = 20;
    const m = extrude([circle(0, 0, R, 180)], { thicknessMm: T, roundMm: r });
    expectClosed(m);
    // A disc minus the ring the fillet cuts off: area r²(1 − π/4) swept around radius ≈ R − r·0.777.
    const cut = r * r * (1 - Math.PI / 4) * 2 * Math.PI * (R - 0.7766 * r);
    expect(volume(m)).toBeGreaterThan((Math.PI * R * R * T - cut) * 0.99);
    expect(volume(m)).toBeLessThan((Math.PI * R * R * T - cut) * 1.01);
    expect(bounds(m).hi[2]).toBeCloseTo(T, 5);
  });

  it('stays closed when the rounding is as big as the thickness and parts are thinner than it', () => {
    // A thin bar joined to a square, letters with holes, and lettering-sized details.
    const m = extrude([rect(0, 0, 30, 30), rect(5, 5, 20, 20), rect(30, 14, 30, 1.2), circle(70, 15, 4)], { thicknessMm: 2, roundMm: 2 });
    expectClosed(m);
    expect(volume(m)).toBeGreaterThan(0);
    expect(bounds(m).hi[2]).toBeCloseTo(2, 5);
  });

  it('keeps the outline exactly as traced', () => {
    const star = Array.from({ length: 10 }, (_, i) => {
      const a = (i * Math.PI) / 5, r = i % 2 ? 8 : 20;
      return { x: 25 + r * Math.cos(a), y: 25 + r * Math.sin(a) };
    });
    for (const roundMm of [0, 1.5]) {
      const m = extrude([star], { thicknessMm: 3, roundMm });
      const p = m.positions;
      const xs = star.map((q) => q.x), ys = star.map((q) => q.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      // Every tip and inner corner of the star is a vertex of the base, at its exact place (centred, y up).
      for (const q of star) {
        let best = Infinity;
        for (let i = 0; i < p.length; i += 3) if (p[i + 2] === 0) best = Math.min(best, Math.hypot(p[i] - (q.x - cx), p[i + 1] + (q.y - cy)));
        expect(best).toBeLessThan(1e-3);
      }
    }
  });

  it('builds the rounded edge without folds: every face above the base looks up or sideways', () => {
    const star = Array.from({ length: 10 }, (_, i) => {
      const a = (i * Math.PI) / 5, r = i % 2 ? 8 : 20;
      return { x: 25 + r * Math.cos(a), y: 25 + r * Math.sin(a) };
    });
    const m = extrude([star, circle(25, 25, 3)], { thicknessMm: 4, roundMm: 2.5 });
    expectClosed(m);
    const p = m.positions, t = m.triangles;
    let folded = 0;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
      if (p[a + 2] === 0 && p[b + 2] === 0 && p[c + 2] === 0) continue;
      const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      if (nz < -1e-4) { folded++; console.log(nz, [a, b, c].map((v) => [p[v], p[v + 1], p[v + 2]].map((x) => x.toFixed(3)).join(' '))); }
    }
    expect(folded).toBe(0);
  });

  it('gives an empty mesh without shapes', () => {
    expect(extrude([], { thicknessMm: 3, roundMm: 0 }).triangles.length).toBe(0);
  });
});
