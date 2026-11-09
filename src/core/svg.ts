import type { Point } from './homography';
import type { PathShape } from './trace';

/** The shapes of one colour (colour mode). */
export interface Layer { color: string; shapes: PathShape[] }

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

/** The area every export covers: the traced shapes plus `padding` mm on each side. */
export function exportArea(polygons: Point[][], padding: number) {
  const box = boundingBox(polygons);
  if (!polygons.length) return { origin: { x: 0, y: 0 }, w: 10, h: 10 };
  return {
    origin: { x: box.minX - padding, y: box.minY - padding },
    w: box.maxX - box.minX + 2 * padding,
    h: box.maxY - box.minY + 2 * padding,
  };
}

/**
 * SVG in real millimetres, cropped to the traced shapes plus `padding`.
 * Outlines are hairline strokes with no fill, the form laser and CNC software expects.
 * With `filled`, closed shapes become one solid black path whose even-odd rule
 * keeps holes open; open lines stay strokes, since they have no inside.
 * With `layers` (colour mode) each colour is its own group, drawn in its colour
 * and marked as a layer for Inkscape; Illustrator and laser software read the
 * groups (or the colours) as layers too.
 */
export function exportSvg(shapes: PathShape[], polygons: Point[][], padding = 2, filled = false, layers?: Layer[]): string {
  if (!polygons.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"/>';
  const { origin, w, h } = exportArea(polygons, padding);
  const draw = (list: PathShape[], color: string, indent: string) => {
    const stroked = filled ? list.filter((s) => !s.closed) : list;
    const solid = filled ? list.filter((s) => s.closed) : [];
    const out: string[] = [];
    if (solid.length) out.push(`${indent}<path d="${solid.map((s) => pathData(s, origin)).join(' ')}" fill="${color}" fill-rule="evenodd"/>`);
    if (stroked.length) {
      out.push(
        `${indent}<g fill="none" stroke="${color}" stroke-width="0.1">`,
        ...stroked.map((s) => `${indent}  <path d="${pathData(s, origin)}"/>`),
        `${indent}</g>`,
      );
    }
    return out;
  };
  const body: string[] = [];
  if (layers) {
    layers.forEach((l, i) => {
      const name = `${i + 1} ${l.color}`;
      body.push(`<g id="color-${i + 1}" inkscape:groupmode="layer" inkscape:label="${name}">`, ...draw(l.shapes, l.color, '  '), '</g>');
    });
  } else body.push(...draw(shapes, '#000', ''));
  const ns = layers ? ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"' : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg"${ns} width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">`,
    ...body,
    '</svg>',
  ].join('\n');
}
