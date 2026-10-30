import { describe, expect, it } from 'vitest';
import { frameById, frameSvg } from '../src/core/frame';
import { applyH, findHomography } from '../src/core/homography';
import { detectFrame, prepare, rectify, trace, DEFAULT_TRACE } from '../src/core/pipeline';
import { exportSvg } from '../src/core/svg';
import { renderPhoto } from './synthetic';

describe('homography', () => {
  it('recovers a known perspective mapping', () => {
    const src = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }, { x: 30, y: 20 },
    ];
    const truth = findHomography(src.slice(0, 4), [
      { x: 10, y: 20 }, { x: 300, y: 40 }, { x: 280, y: 200 }, { x: 5, y: 170 },
    ]);
    const dst = src.map((p) => applyH(truth, p));
    const h = findHomography(src, dst);
    for (const p of src) {
      const a = applyH(h, p);
      const b = applyH(truth, p);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
    }
  });
});

describe('frame', () => {
  it('prints at real size', () => {
    const svg = frameSvg(frameById('a3'));
    expect(svg).toContain('width="297mm" height="420mm"');
  });
});

describe('pipeline on a synthetic photo', () => {
  // A circle of radius 40 mm and a 60×30 mm rectangle with a 20×10 mm hole.
  const circle = { x: 150, y: 220, r: 40 };
  const drawing = (x: number, y: number) =>
    Math.hypot(x - circle.x, y - circle.y) <= circle.r ||
    (x >= 60 && x <= 120 && y >= 80 && y <= 110 && !(x >= 80 && x <= 100 && y >= 90 && y <= 100));

  const { photo, sheetToPhoto } = renderPhoto(
    'a3',
    drawing,
    { width: 2400, height: 3000 },
    [
      { x: 330, y: 260 },
      { x: 2050, y: 330 },
      { x: 2250, y: 2800 },
      { x: 150, y: 2700 },
    ],
    (x, y) => 0.75 + 0.25 * x - 0.1 * y,
  );
  const frame = frameById('a3');

  it('finds all four markers and the right geometry', { timeout: 60000 }, () => {
    const det = detectFrame(photo, frame);
    expect(det.markerIds).toEqual([0, 1, 2, 3]);
    for (const p of [{ x: 0, y: 0 }, { x: 297, y: 420 }, { x: 150, y: 220 }]) {
      const a = applyH(det.sheetToPhoto, p);
      const b = applyH(sheetToPhoto, p);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.5);
    }
  });

  it('traces shapes at real scale', { timeout: 60000 }, () => {
    const det = detectFrame(photo, frame);
    const rect = rectify(photo, frame, det, 4);
    const prep = prepare(rect);
    const out = trace(prep, rect, { ...DEFAULT_TRACE, threshold: prep.autoThreshold });
    expect(out.polygons.length).toBe(3);

    const radii = out.polygons
      .map((poly) => poly.map((p) => Math.hypot(p.x - circle.x, p.y - circle.y)))
      .find((r) => r.every((d) => d < circle.r + 3))!;
    const meanR = radii.reduce((s, d) => s + d, 0) / radii.length;
    expect(Math.abs(meanR - circle.r)).toBeLessThan(0.4);
    expect(Math.max(...radii.map((d) => Math.abs(d - circle.r)))).toBeLessThan(0.8);

    const outer = out.polygons.find((poly) => poly.some((p) => p.x < 70))!;
    const xs = outer.map((p) => p.x);
    const ys = outer.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(30, 0);
    expect(Math.min(...xs)).toBeCloseTo(60, 0);

    const svg = exportSvg(out.shapes, out.polygons);
    // Bounding box: rectangle at x=60 to circle edge at x=190, plus 2 mm padding per side.
    expect(svg).toMatch(/width="13[34]\.\d+mm"/);
    expect(svg.match(/<path /g)).toHaveLength(3);

    // Curves must not overshoot the rectangle: every control point stays inside it.
    const rectPath = out.shapes[out.polygons.indexOf(outer)];
    for (const s of rectPath.segments) {
      for (const p of s.kind === 'C' ? [s.c1, s.c2, s.to] : [s.to]) {
        expect(p.x).toBeGreaterThan(59.5);
        expect(p.x).toBeLessThan(120.5);
        expect(p.y).toBeGreaterThan(79.5);
        expect(p.y).toBeLessThan(110.5);
      }
    }
  });
});
