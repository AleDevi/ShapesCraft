import { describe, expect, it } from 'vitest';
import { frameById, frameSvg } from '../src/core/frame';
import { applyH, findHomography } from '../src/core/homography';
import { detectFrame, prepare, rectify, trace, DEFAULT_TRACE } from '../src/core/pipeline';
import { exportSvg } from '../src/core/svg';
import { smoothContour, smoothPath } from '../src/core/trace';
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
    expect(frameSvg(frameById('a4'))).toContain('width="210mm" height="297mm"');
    expect(frameSvg(frameById('a3'))).toContain('width="297mm" height="420mm"');
    expect(frameSvg(frameById('a4'))).toContain('the line = 100 mm');
    expect(frameSvg(frameById('a4'), 'it')).toContain('la linea = 100 mm');
  });
});

describe.each(['a4', 'a3'])('pipeline on a synthetic photo of the %s frame', (frameId) => {
  // A circle of radius 40 mm and a 60×30 mm rectangle with a 20×10 mm hole, inside both windows.
  const circle = { x: 105, y: 190, r: 40 };
  const drawing = (x: number, y: number) =>
    Math.hypot(x - circle.x, y - circle.y) <= circle.r ||
    (x >= 60 && x <= 120 && y >= 80 && y <= 110 && !(x >= 80 && x <= 100 && y >= 90 && y <= 100));

  const { photo, sheetToPhoto } = renderPhoto(
    frameId,
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
  const frame = frameById(frameId);

  it('finds all four markers and the right geometry', { timeout: 60000 }, () => {
    const det = detectFrame(photo, frame);
    expect(det.markerIds).toEqual([0, 1, 2, 3]);
    for (const p of [{ x: 0, y: 0 }, { x: frame.width, y: frame.height }, { x: 105, y: 190 }]) {
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
    // Bounding box: rectangle at x=60 to circle edge at x=145, plus 2 mm padding per side.
    expect(svg).toMatch(/width="8[89]\.\d+mm"/);
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

describe('smoothPath', () => {
  // Simplified polygon of a circle (R 40 mm) at the coarsest straightening setting.
  const R = 40;
  const tol = 3;
  const step = 2 * Math.acos(1 - tol / R);
  const n = Math.ceil((2 * Math.PI) / step);
  const circle = Array.from({ length: n }, (_, i) => ({
    x: R * Math.cos((i * 2 * Math.PI) / n),
    y: R * Math.sin((i * 2 * Math.PI) / n),
  }));

  it('keeps a coarse circle smooth', () => {
    const path = smoothPath(circle, 50, 1, tol);
    expect(path.segments.every((s) => s.kind === 'C')).toBe(true);
  });

  it('keeps a gentle bend between long straight sides sharp', () => {
    // Wall and roof of a house: the 35° bend at (0, 0) must not become a bulge.
    const house = [
      { x: 0, y: 60 }, { x: 0, y: 0 }, { x: 28.7, y: -41 }, { x: 60, y: 0 }, { x: 60, y: 60 },
    ];
    const path = smoothPath(house, 50, 1, 1.5);
    const wall = path.segments[0];
    expect(wall.kind).toBe('L');
  });
});

describe('smoothContour', () => {
  it('removes bumps from a circle without shrinking it', () => {
    const R = 200;
    const bumpy = Array.from({ length: 1200 }, (_, i) => {
      const a = (i / 1200) * 2 * Math.PI;
      const r = R + 3 * Math.sin(a * 60) + 1.5 * Math.sin(a * 137);
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    });
    const out = smoothContour(bumpy, 40, 50);
    const radii = out.map((p) => Math.hypot(p.x, p.y));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(Math.abs(mean - R)).toBeLessThan(1);
    expect(Math.max(...radii.map((r) => Math.abs(r - R)))).toBeLessThan(1.2);
  });

  it('keeps the corners of a noisy square', () => {
    const side = 400;
    const pts = [];
    for (let k = 0; k < 4; k++)
      for (let i = 0; i < 400; i++) {
        const t = i / 400;
        const noise = 2 * Math.sin(i * 0.9);
        const p = [
          { x: t * side, y: noise },
          { x: side + noise, y: t * side },
          { x: side - t * side, y: side + noise },
          { x: noise, y: side - t * side },
        ][k];
        pts.push(p);
      }
    const out = smoothContour(pts, 40, 50);
    for (const c of [{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side }]) {
      const nearest = Math.min(...out.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
      expect(nearest).toBeLessThan(3);
    }
    // Away from the (pinned, noisy) corners, sides are flattened to within half the noise.
    const inner = out.filter((p) => Math.min(p.x, side - p.x) > 20 || Math.min(p.y, side - p.y) > 20);
    const offSide = inner.map((p) => Math.min(Math.abs(p.y), Math.abs(p.x - side), Math.abs(p.y - side), Math.abs(p.x)));
    expect(Math.max(...offSide)).toBeLessThan(1);
  });
});

describe('single-line (centreline) tracing', () => {
  // A ring of radius 30 mm and a straight 80 mm stroke, both drawn with a ~2.5 mm pen.
  const ring = { x: 105, y: 110, r: 30 };
  const drawing = (x: number, y: number) =>
    Math.abs(Math.hypot(x - ring.x, y - ring.y) - ring.r) <= 1.25 ||
    (x >= 60 && x <= 140 && Math.abs(y - 200) <= 1.25);
  const { photo } = renderPhoto(
    'a4',
    drawing,
    { width: 2000, height: 2600 },
    [
      { x: 200, y: 180 },
      { x: 1800, y: 240 },
      { x: 1900, y: 2450 },
      { x: 120, y: 2380 },
    ],
  );
  const frame = frameById('a4');

  it('traces each stroke as one line along its centre', { timeout: 60000 }, () => {
    const det = detectFrame(photo, frame);
    const rect = rectify(photo, frame, det, 5);
    const prep = prepare(rect);
    const out = trace(prep, rect, { ...DEFAULT_TRACE, threshold: prep.autoThreshold, centerline: true });
    expect(out.shapes.length).toBe(2);

    const loopIdx = out.shapes.findIndex((s) => s.closed);
    expect(loopIdx).toBeGreaterThanOrEqual(0);
    const radii = out.polygons[loopIdx].map((p) => Math.hypot(p.x - ring.x, p.y - ring.y));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(Math.abs(mean - ring.r)).toBeLessThan(0.3);

    const line = out.polygons[1 - loopIdx];
    expect(out.shapes[1 - loopIdx].closed).toBe(false);
    const xs = line.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(60, 0);
    expect(xs[xs.length - 1]).toBeCloseTo(140, 0);
    expect(Math.max(...line.map((p) => Math.abs(p.y - 200)))).toBeLessThan(0.3);

    expect(exportSvg(out.shapes, out.polygons)).not.toMatch(/Z"\/>[\s\S]*Z"\/>/);
  });
});
