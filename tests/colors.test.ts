import { describe, expect, it } from 'vitest';
import { frameById } from '../src/core/frame';
import { applyH, invert3 } from '../src/core/homography';
import { toGray, type Rgba } from '../src/core/image';
import { DEFAULT_TRACE, detectFrame, prepare, rectify, rectifyColor, trace } from '../src/core/pipeline';
import { exportSvg } from '../src/core/svg';
import { aciColor, exportDxf, exportPdf } from '../src/core/export';
import { renderPhoto } from './synthetic';

// Four inks on white paper: a black bar, a red disc, a blue square and a yellow disc,
// which is too light for the black-and-white threshold.
const inks: { name: string; rgb: [number, number, number]; at: (x: number, y: number) => boolean; centre: [number, number] }[] = [
  { name: 'black', rgb: [25, 25, 25], at: (x, y) => x >= 40 && x <= 170 && y >= 60 && y <= 70, centre: [105, 65] },
  { name: 'red', rgb: [210, 35, 40], at: (x, y) => Math.hypot(x - 70, y - 120) <= 20, centre: [70, 120] },
  { name: 'blue', rgb: [30, 70, 200], at: (x, y) => x >= 120 && x <= 160 && y >= 100 && y <= 140, centre: [140, 120] },
  { name: 'yellow', rgb: [250, 215, 10], at: (x, y) => Math.hypot(x - 105, y - 200) <= 18, centre: [105, 200] },
];
const size = { width: 2000, height: 2600 };
const corners = [
  { x: 200, y: 180 },
  { x: 1800, y: 240 },
  { x: 1900, y: 2450 },
  { x: 120, y: 2380 },
];

/** Colour photo: the grey synthetic photo, with the inks painted in where they are. */
function colourPhoto(): Rgba {
  const { photo, sheetToPhoto } = renderPhoto('a4', () => false, size, corners);
  const toSheet = invert3(sheetToPhoto);
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      const p = applyH(toSheet, { x: x + 0.5, y: y + 0.5 });
      const ink = inks.find((k) => k.at(p.x, p.y));
      const o = (y * size.width + x) * 4;
      const v = photo.data[y * size.width + x] * 255;
      const rgb = ink ? ink.rgb : [v, v * 0.97, v * 0.9]; // slightly warm light
      data.set([...rgb, 255], o);
    }
  return soften({ width: size.width, height: size.height, data });
}

/** A camera's blur and sensor noise, so edges blend as in real photos. */
function soften(img: Rgba): Rgba {
  const { width: w, height: h } = img;
  let src = Float32Array.from(img.data);
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              s += src[(yy * w + xx) * 4 + c];
              n++;
            }
          dst[(y * w + x) * 4 + c] = s / n;
        }
    src = dst;
  }
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 16;
  const data = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) data[i] = i % 4 === 3 ? 255 : src[i] + noise();
  return { width: w, height: h, data };
}

describe('colour mode', () => {
  const frame = frameById('a4');
  const rgba = colourPhoto();
  const photo = toGray(rgba);
  const det = detectFrame(photo, frame);
  const rect = rectify(photo, frame, det, 5);
  const prep = prepare(rect);
  const colour = rectifyColor(rgba, frame, det, 5);

  it('leaves black and white unchanged when off', { timeout: 60000 }, () => {
    const opts = { ...DEFAULT_TRACE, threshold: prep.autoThreshold };
    const bw = trace(prep, rect, opts);
    expect(bw.layers).toBeUndefined();
    expect(trace(prep, rect, opts, colour)).toEqual(bw);
    // The yellow disc is too light for black and white.
    expect(bw.polygons.some((poly) => poly.every((p) => Math.hypot(p.x - 105, p.y - 200) < 25))).toBe(false);
  });

  it('puts each ink on its own layer, in its colour', { timeout: 60000 }, () => {
    const out = trace(prep, rect, { ...DEFAULT_TRACE, threshold: prep.autoThreshold, colors: 4 }, colour);
    expect(out.layers).toHaveLength(4);
    for (const ink of inks) {
      const layer = out.layers!.find((l) =>
        l.polygons.some((poly) => {
          const xs = poly.map((p) => p.x);
          const ys = poly.map((p) => p.y);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          return Math.hypot(cx - ink.centre[0], cy - ink.centre[1]) < 3;
        }),
      );
      expect(layer, ink.name).toBeDefined();
      // One shape per layer: no slivers of other colours along the edges.
      expect(layer!.shapes.length, ink.name).toBe(1);
      const rgb = [1, 3, 5].map((i) => parseInt(layer!.color.slice(i, i + 2), 16));
      rgb.forEach((c, k) => expect(Math.abs(c - ink.rgb[k]), `${ink.name} ${layer!.color}`).toBeLessThan(45));
    }
    // Darkest first.
    expect(out.layers![0].polygons[0].every((p) => p.y > 55 && p.y < 75)).toBe(true);
    expect(out.shapes.length).toBe(4);
  });

  it('fewer colours than inks merges the closest ones', { timeout: 60000 }, () => {
    const out = trace(prep, rect, { ...DEFAULT_TRACE, threshold: prep.autoThreshold, colors: 2 }, colour);
    expect(out.layers).toHaveLength(2);
    expect(out.shapes.length).toBe(4);
  });

  it('writes layers into SVG, DXF and PDF', { timeout: 60000 }, () => {
    const out = trace(prep, rect, { ...DEFAULT_TRACE, threshold: prep.autoThreshold, colors: 4 }, colour);
    const svg = exportSvg(out.shapes, out.polygons, 2, true, out.layers);
    expect(svg.match(/inkscape:groupmode="layer"/g)).toHaveLength(4);
    for (const l of out.layers!) expect(svg).toContain(`fill="${l.color}"`);
    const dxf = exportDxf(out.shapes, out.polygons, 2, out.layers);
    expect(dxf).toContain('LAYER\r\n  2\r\nCOLOR_4');
    expect(dxf.match(/POLYLINE\r\n {2}8\r\nCOLOR_\d/g)).toHaveLength(4);
    const pdf = new TextDecoder().decode(exportPdf(out.shapes, out.polygons, 2, true, out.layers));
    expect(pdf.match(/ rg\n/g)).toHaveLength(4);
  });
});

describe('aciColor', () => {
  it('picks the nearest CAD colour', () => {
    expect(aciColor('#d22328')).toBe(1);
    expect(aciColor('#1e46c8')).toBe(5);
    expect(aciColor('#191919')).toBe(7);
    expect(aciColor('#fad70a')).toBe(2);
  });
});
