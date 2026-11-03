import { describe, expect, it } from 'vitest';
import { exportDxf, exportName, exportPdf, flatten, pngDpi, pngWithDpi } from '../src/core/export';
import type { PathShape } from '../src/core/trace';

// A 20×10 mm rectangle at (10, 20) with a rounded right side, and an open line.
const rect: PathShape = {
  start: { x: 10, y: 20 },
  segments: [
    { kind: 'L', to: { x: 30, y: 20 } },
    { kind: 'C', c1: { x: 35, y: 20 }, c2: { x: 35, y: 30 }, to: { x: 30, y: 30 } },
    { kind: 'L', to: { x: 10, y: 30 } },
    { kind: 'L', to: { x: 10, y: 20 } },
  ],
  closed: true,
};
const line: PathShape = { start: { x: 12, y: 22 }, segments: [{ kind: 'L', to: { x: 20, y: 28 } }], closed: false };
const polygons = [[{ x: 10, y: 20 }, { x: 33.75, y: 20 }, { x: 33.75, y: 30 }, { x: 10, y: 30 }]];

describe('flatten', () => {
  it('stays close to the curve and keeps the end points', () => {
    const pts = flatten(rect, 0.02);
    expect(pts[0]).toEqual({ x: 10, y: 20 });
    // The duplicate closing point is dropped: closed polylines join their ends.
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 30 });
    const bulge = Math.max(...pts.map((p) => p.x));
    expect(bulge).toBeGreaterThan(33.7); // the curve's apex is at x = 33.75
    expect(bulge).toBeLessThanOrEqual(33.75 + 1e-9);
    expect(pts.length).toBeGreaterThan(8);
  });
});

describe('DXF', () => {
  const dxf = exportDxf([rect, line], polygons, 2);
  const pairs = dxf.split('\r\n').slice(0, -1);
  const groups: [number, string][] = [];
  for (let i = 0; i < pairs.length; i += 2) groups.push([Number(pairs[i]), pairs[i + 1]]);

  it('is a well-formed R12 file in millimetres', () => {
    expect(pairs.length % 2).toBe(0);
    expect(groups[0]).toEqual([0, 'SECTION']);
    expect(groups.at(-1)).toEqual([0, 'EOF']);
    expect(dxf).toContain('$ACADVER\r\n  1\r\nAC1009');
    expect(dxf).toContain('$INSUNITS\r\n 70\r\n4');
  });

  it('has one polyline per shape, closed only for closed shapes', () => {
    const flags = groups.filter(([c], i) => c === 70 && groups.slice(0, i).reverse().find(([k]) => k === 0)?.[1] === 'POLYLINE');
    expect(flags.map(([, v]) => v)).toEqual(['1', '0']);
    expect(groups.filter(([c, v]) => c === 0 && v === 'SEQEND')).toHaveLength(2);
  });

  it('puts the drawing at the origin with y pointing up', () => {
    const xs: number[] = [], ys: number[] = [];
    groups.forEach(([c, v], i) => {
      if (c === 0 && v === 'VERTEX') {
        xs.push(Number(groups[i + 2][1]));
        ys.push(Number(groups[i + 3][1]));
      }
    });
    // Bounding box 23.75 × 10 mm plus 2 mm padding.
    expect(Math.min(...xs)).toBeCloseTo(2);
    expect(Math.max(...xs)).toBeCloseTo(25.75, 1);
    expect(Math.min(...ys)).toBeCloseTo(2);
    expect(Math.max(...ys)).toBeCloseTo(12);
    // The rectangle's top-left corner in the photo (10, 20) is its top-left in CAD: (2, 12).
    expect([xs[0], ys[0]]).toEqual([2, 12]);
  });

  it('never writes non-numbers as coordinates', () => {
    const bad: PathShape = { start: { x: NaN, y: Infinity }, segments: [{ kind: 'L', to: { x: 1, y: 1 } }], closed: false };
    const out = exportDxf([bad], polygons);
    expect(out).not.toMatch(/NaN|Infinity/);
  });
});

describe('PDF', () => {
  it('is one page as big as the drawing, with a valid cross-reference table', () => {
    const pdf = new TextDecoder().decode(exportPdf([rect, line], polygons, 2));
    // 27.75 × 14 mm in points.
    expect(pdf).toContain('/MediaBox [0 0 78.661 39.685]');
    expect(pdf).toContain(' c ');
    expect(pdf).toContain('S');
    expect(pdf).not.toContain('/Font');
    const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(4);
    offsets.forEach((o, i) => expect(pdf.slice(o)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    const stream = pdf.match(/stream\n([\s\S]*)\nendstream/)![1];
    expect(Number(pdf.match(/\/Length (\d+)/)![1])).toBe(stream.length);
  });

  it('fills closed shapes with the even-odd rule when filled', () => {
    const pdf = new TextDecoder().decode(exportPdf([rect, line], polygons, 2, true));
    expect(pdf).toMatch(/h\nf\*/);
    // The open line is still a stroke.
    expect(pdf).toMatch(/0 G 0\.1 w\n.* l S/);
  });
});

describe('PNG', () => {
  // 1×1 white PNG.
  const tiny = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  );

  it('records the resolution in a pHYs chunk with a valid CRC', () => {
    const out = pngWithDpi(tiny, 300);
    expect(out.length).toBe(tiny.length + 21);
    const view = new DataView(out.buffer);
    expect(String.fromCharCode(...out.subarray(37, 41))).toBe('pHYs');
    expect(view.getUint32(41)).toBe(11811); // 300 dpi in pixels per metre
    expect(view.getUint32(45)).toBe(11811);
    expect(out[49]).toBe(1);
    // Known CRC of this exact pHYs chunk.
    expect(view.getUint32(50)).toBe(0x78a53f76);
    // The rest of the file is untouched, and applying it twice keeps a single pHYs.
    expect(out.subarray(54)).toEqual(tiny.subarray(33));
    expect(pngWithDpi(out, 150).length).toBe(out.length);
  });

  it('lowers the resolution only for drawings too big for a phone canvas', () => {
    expect(pngDpi(100, 100)).toBe(300);
    const dpi = pngDpi(400, 500);
    expect(dpi).toBeLessThan(300);
    expect(((400 / 25.4) * dpi) * ((500 / 25.4) * dpi)).toBeLessThanOrEqual(16_000_000);
  });
});

describe('file names', () => {
  it('carry the format extension', () => {
    expect(exportName('dxf')).toMatch(/^shapescraft-\d{12}\.dxf$/);
  });
});
