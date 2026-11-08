import type { Point } from './homography';
import { pdfDocument, pdfMmTransform } from './pdf';
import { exportArea } from './svg';
import type { PathShape } from './trace';

/** File formats the traced vector can be saved as. */
export const FORMATS = ['svg', 'dxf', 'pdf', 'png'] as const;
export type Format = (typeof FORMATS)[number];

export const MIME: Record<Format, string> = {
  svg: 'image/svg+xml',
  dxf: 'image/vnd.dxf',
  pdf: 'application/pdf',
  png: 'image/png',
};

/** Finite numbers only, rounded to 0.001 mm: broken coordinates can't produce broken files. */
const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0');

/**
 * The shape as a polyline, with curves split into straight pieces that stay
 * within `tolerance` mm of the curve. Formats without Bézier curves need this.
 */
export function flatten(shape: PathShape, tolerance = 0.02): Point[] {
  const out: Point[] = [shape.start];
  let p0 = shape.start;
  for (const s of shape.segments) {
    if (s.kind === 'C') {
      // Uniform steps keep a cubic within 3/4·max(second difference)/n² of its chord.
      const dd = Math.max(
        Math.hypot(p0.x - 2 * s.c1.x + s.c2.x, p0.y - 2 * s.c1.y + s.c2.y),
        Math.hypot(s.c1.x - 2 * s.c2.x + s.to.x, s.c1.y - 2 * s.c2.y + s.to.y),
      );
      const steps = Math.min(200, Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / tolerance)) || 1));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        out.push({ x: a * p0.x + b * s.c1.x + c * s.c2.x + d * s.to.x, y: a * p0.y + b * s.c1.y + c * s.c2.y + d * s.to.y });
      }
    }
    out.push(s.to);
    p0 = s.to;
  }
  // A closed DXF polyline joins its ends itself.
  if (shape.closed && out.length > 1) {
    const first = out[0], last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) out.pop();
  }
  return out;
}

/**
 * DXF R12 in millimetres, the version every CAD, CAM and laser program reads.
 * Each shape is one POLYLINE (closed ones flagged closed) on layer 0, with y
 * pointing up as CAD expects, and the drawing's corner at the origin.
 */
export function exportDxf(shapes: PathShape[], polygons: Point[][], padding = 2): string {
  const { origin, w, h } = exportArea(polygons, padding);
  const out: (string | number)[] = [];
  const add = (...pairs: (string | number)[]) => out.push(...pairs);
  add(0, 'SECTION', 2, 'HEADER');
  add(9, '$ACADVER', 1, 'AC1009');
  // 4 = millimetres; read by most programs even in R12 files. $MEASUREMENT 1 = metric.
  add(9, '$INSUNITS', 70, 4, 9, '$MEASUREMENT', 70, 1);
  add(9, '$EXTMIN', 10, 0, 20, 0, 30, 0, 9, '$EXTMAX', 10, num(w), 20, num(h), 30, 0);
  add(0, 'ENDSEC');
  add(0, 'SECTION', 2, 'ENTITIES');
  for (const shape of shapes) {
    const pts = flatten(shape);
    if (pts.length < 2) continue;
    add(0, 'POLYLINE', 8, '0', 66, 1, 10, 0, 20, 0, 30, 0, 70, shape.closed ? 1 : 0);
    for (const p of pts) add(0, 'VERTEX', 8, '0', 10, num(p.x - origin.x), 20, num(h - (p.y - origin.y)), 30, 0);
    add(0, 'SEQEND', 8, '0');
  }
  add(0, 'ENDSEC', 0, 'EOF');
  const lines: string[] = [];
  for (let i = 0; i < out.length; i += 2) lines.push(String(out[i]).padStart(3, ' '), String(out[i + 1]));
  return lines.join('\r\n') + '\r\n';
}

function pdfPath(shape: PathShape, origin: Point): string {
  const p = (q: Point) => `${num(q.x - origin.x)} ${num(q.y - origin.y)}`;
  const ops = [`${p(shape.start)} m`];
  for (const s of shape.segments) ops.push(s.kind === 'L' ? `${p(s.to)} l` : `${p(s.c1)} ${p(s.c2)} ${p(s.to)} c`);
  if (shape.closed) ops.push('h');
  return ops.join(' ');
}

/**
 * A PDF page exactly the size of the drawing, in real millimetres: print it at
 * 100% ("actual size") or import it into cutting and design software.
 * Same look as the SVG: hairline outlines, or solid shapes with `filled`.
 */
export function exportPdf(shapes: PathShape[], polygons: Point[][], padding = 2, filled = false): Uint8Array {
  const { origin, w, h } = exportArea(polygons, padding);
  const content = [pdfMmTransform(h), '1 J 1 j'];
  const solid = filled ? shapes.filter((s) => s.closed) : [];
  const stroked = filled ? shapes.filter((s) => !s.closed) : shapes;
  if (solid.length) content.push('0 g', ...solid.map((s) => pdfPath(s, origin)), 'f*');
  if (stroked.length) content.push('0 G 0.1 w', ...stroked.map((s) => `${pdfPath(s, origin)} S`));
  return pdfDocument(w, h, content.join('\n'));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Writes the resolution into a PNG (a pHYs chunk right after IHDR), so
 * printing and engraving programs open it at its real size.
 */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array {
  const IHDR_END = 8 + 25; // signature + IHDR chunk (length, type, 13 bytes, crc)
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  const perMetre = Math.round(dpi / 0.0254);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, perMetre);
  view.setUint32(12, perMetre);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Drop any pHYs the encoder already wrote, so there is only one.
  const rest: Uint8Array[] = [];
  let i = IHDR_END;
  while (i + 8 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset + i).getUint32(0);
    const type = String.fromCharCode(...png.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (type !== 'pHYs') rest.push(png.subarray(i, end));
    i = end;
  }
  const parts = [png.subarray(0, IHDR_END), chunk, ...rest];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** PNG resolution: 300 dpi, lowered for big drawings so phones can still draw the canvas. */
export function pngDpi(widthMm: number, heightMm: number, maxPixels = 16_000_000): number {
  const dpi = 300;
  const px = (widthMm / 25.4) * dpi * ((heightMm / 25.4) * dpi);
  return px <= maxPixels ? dpi : Math.floor(dpi * Math.sqrt(maxPixels / px));
}

/** File name for an export, with a timestamp so repeated downloads don't overwrite each other. */
/** File name of an export; `code`, the project code of a unique frame, keeps the files of one project together. */
export function exportName(format: Format, date = new Date(), code?: string): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return `shapescraft-${code ? `${code}-` : ''}${local.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.${format}`;
}
