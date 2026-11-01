import type { Point } from './homography';
import type { PathShape } from './trace';

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
const pt = (p: Point) => `${fmt(p.x)} ${fmt(p.y)}`;

export function pathData(shape: PathShape, offset: Point = { x: 0, y: 0 }): string {
  const o = (p: Point) => pt({ x: p.x - offset.x, y: p.y - offset.y });
  const parts = [`M${o(shape.start)}`];
  for (const s of shape.segments) parts.push(s.kind === 'L' ? `L${o(s.to)}` : `C${o(s.c1)} ${o(s.c2)} ${o(s.to)}`);
  if (shape.closed) parts.push('Z');
  return parts.join(' ');
}

export function boundingBox(polygons: Point[][]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons)
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  return { minX, minY, maxX, maxY };
}

/**
 * SVG in real millimetres, cropped to the traced shapes plus `padding`.
 * Outlines are hairline strokes with no fill, the form laser and CNC software expects.
 * With `filled`, closed shapes become one solid black path whose even-odd rule
 * keeps holes open; open lines stay strokes, since they have no inside.
 */
export function exportSvg(shapes: PathShape[], polygons: Point[][], padding = 2, filled = false): string {
  const box = boundingBox(polygons);
  if (!polygons.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"/>';
  const origin = { x: box.minX - padding, y: box.minY - padding };
  const w = box.maxX - box.minX + 2 * padding;
  const h = box.maxY - box.minY + 2 * padding;
  const stroked = filled ? shapes.filter((s) => !s.closed) : shapes;
  const solid = filled ? shapes.filter((s) => s.closed) : [];
  const body: string[] = [];
  if (solid.length) body.push(`<path d="${solid.map((s) => pathData(s, origin)).join(' ')}" fill="#000" fill-rule="evenodd"/>`);
  if (stroked.length) {
    body.push(`<g fill="none" stroke="#000" stroke-width="0.1">`, ...stroked.map((s) => `  <path d="${pathData(s, origin)}"/>`), '</g>');
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">`,
    ...body,
    '</svg>',
  ].join('\n');
}
