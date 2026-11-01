import { AR } from '../vendor/js-aruco2/aruco.js';
import type { Point } from './homography';
import { translator, type Lang } from '../i18n';

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * A printable frame: a band around a central window, with four ArUco markers
 * (ids 0..3, clockwise from the top-left) in the corners of the band. It can be
 * glued to card or thin plastic and cut out along its outer and inner edges,
 * then laid over the drawing or object. All measures are in millimetres, with
 * the origin at the top-left corner of the printed sheet.
 */
export interface FrameLayout {
  id: string;
  name: string;
  /** Printed sheet size. */
  width: number;
  height: number;
  /** Distance of the outer cut line from the sheet edge (printer margin). */
  margin: number;
  /** Width of the band between the outer and inner cut lines. */
  band: number;
  /** White quiet zone between a marker and the band edges. */
  markerPad: number;
}

export const DICTIONARY = 'ARUCO_MIP_36h12';
export const MARKER_IDS = [0, 1, 2, 3] as const;

/** Shadows and paper fibres along the cut edge of the window are not traced. */
const WINDOW_INSET = 2;

export const FRAMES: FrameLayout[] = [
  { id: 'a4', name: 'A4 (210 × 297 mm)', width: 210, height: 297, margin: 6, band: 26, markerPad: 4 },
  { id: 'a3', name: 'A3 (297 × 420 mm)', width: 297, height: 420, margin: 7, band: 34, markerPad: 4 },
];

export function frameById(id: string): FrameLayout {
  const frame = FRAMES.find((f) => f.id === id);
  if (!frame) throw new Error(`Unknown frame: ${id}`);
  return frame;
}

export function markerSize(f: FrameLayout): number {
  return f.band - 2 * f.markerPad;
}

export function outerRect(f: FrameLayout): Rect {
  return { x: f.margin, y: f.margin, w: f.width - 2 * f.margin, h: f.height - 2 * f.margin };
}

/** The opening in the middle of the frame. */
export function windowRect(f: FrameLayout): Rect {
  const o = f.margin + f.band;
  return { x: o, y: o, w: f.width - 2 * o, h: f.height - 2 * o };
}

/** Top-left corner of each marker square, indexed by marker id. */
function markerOrigins(f: FrameLayout): Point[] {
  const near = f.margin + f.markerPad;
  const s = markerSize(f);
  const far = { x: f.width - near - s, y: f.height - near - s };
  return [
    { x: near, y: near },
    { x: far.x, y: near },
    { x: far.x, y: far.y },
    { x: near, y: far.y },
  ];
}

/**
 * Sheet coordinates of the four corners of each marker, in the order the
 * detector reports them (top-left, top-right, bottom-right, bottom-left of the
 * upright marker).
 */
export function markerCorners(f: FrameLayout): Point[][] {
  const s = markerSize(f);
  return markerOrigins(f).map(({ x, y }) => [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ]);
}

/** The traced region: the window, slightly inset. */
export function workArea(f: FrameLayout): Rect {
  const w = windowRect(f);
  return { x: w.x + WINDOW_INSET, y: w.y + WINDOW_INSET, w: w.w - 2 * WINDOW_INSET, h: w.h - 2 * WINDOW_INSET };
}

const cellCache = new Map<number, number[][]>();

export function markerCells(id: number): number[][] {
  const cached = cellCache.get(id);
  if (cached) return cached;
  const dict = new AR.Dictionary(DICTIONARY);
  const n = dict.markSize;
  const code = dict.codeList[id];
  const cells: number[][] = [];
  for (let y = 0; y < n; y++) {
    const row: number[] = [];
    for (let x = 0; x < n; x++) {
      const border = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      row.push(border ? 0 : Number(code[(y - 1) * (n - 2) + (x - 1)]));
    }
    cells.push(row);
  }
  cellCache.set(id, cells);
  return cells;
}

/** One drawing primitive of the printable frame, in sheet millimetres. */
export type FrameOp =
  /** Filled rectangles; with `evenOdd`, later rectangles punch holes in the first. */
  | { kind: 'fill'; rects: Rect[]; gray: number; evenOdd?: boolean }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width: number }
  | { kind: 'outline'; rect: Rect; width: number }
  /** Text centred on x, with y on the baseline. */
  | { kind: 'text'; x: number; y: number; size: number; body: string };

/** The printable frame as drawing primitives, shared by the SVG and PDF output. */
export function frameDrawing(f: FrameLayout, lang: Lang = 'en'): FrameOp[] {
  const t = translator(lang);
  const ops: FrameOp[] = [];
  const outer = outerRect(f);
  const win = windowRect(f);
  const s = markerSize(f);

  // Grey band with the window punched out, so the frame reads as a frame.
  ops.push({ kind: 'fill', rects: [outer, win], gray: 0.85, evenOdd: true });

  const origins = markerOrigins(f);
  for (const id of MARKER_IDS) {
    const cells = markerCells(id);
    const cell = s / cells.length;
    const { x, y } = origins[id];
    // White quiet zone: the detector needs contrast all around the marker.
    const pad = f.markerPad - 1;
    ops.push({ kind: 'fill', rects: [{ x: x - pad, y: y - pad, w: s + 2 * pad, h: s + 2 * pad }], gray: 1 });
    ops.push({ kind: 'fill', rects: [{ x, y, w: s, h: s }], gray: 0 });
    const white: Rect[] = [];
    cells.forEach((row, cy) =>
      row.forEach((v, cx) => {
        // Slight overlap avoids hairline seams between adjacent white cells.
        if (v) white.push({ x: x + cx * cell, y: y + cy * cell, w: cell + 0.02, h: cell + 0.02 });
      }),
    );
    ops.push({ kind: 'fill', rects: white, gray: 1 });
  }

  // Scale ruler and label on the bottom band, between the markers.
  const cx = f.width / 2;
  const bandTop = f.height - f.margin - f.band;
  const rx = cx - 50;
  const ry = bandTop + f.band * 0.35;
  ops.push({ kind: 'line', x1: rx, y1: ry, x2: rx + 100, y2: ry, width: 0.3 });
  for (let i = 0; i <= 10; i++) {
    const len = i % 5 === 0 ? 3 : 1.5;
    ops.push({ kind: 'line', x1: rx + i * 10, y1: ry, x2: rx + i * 10, y2: ry + len, width: 0.3 });
  }
  ops.push({ kind: 'text', x: cx, y: ry + 8, size: 3, body: `ShapesCraft ${f.id.toUpperCase()} · ${t('sheet.scale')}` });
  ops.push({ kind: 'text', x: cx, y: f.margin + f.band / 2 - 1, size: 2.8, body: t('sheet.glue1') });
  ops.push({ kind: 'text', x: cx, y: f.margin + f.band / 2 + 3, size: 2.8, body: t('sheet.glue2') });

  // Cut lines.
  for (const r of [outer, win]) ops.push({ kind: 'outline', rect: r, width: 0.3 });
  return ops;
}

/** Printable SVG of the frame at real size. */
export function frameSvg(f: FrameLayout, lang: Lang = 'en'): string {
  const hex = (g: number) => `#${Math.round(g * 255).toString(16).padStart(2, '0').repeat(3)}`;
  const rectPath = (r: Rect) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`;
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const parts = frameDrawing(f, lang).map((op) => {
    switch (op.kind) {
      case 'fill':
        return `<path d="${op.rects.map(rectPath).join(' ')}" fill="${hex(op.gray)}"${op.evenOdd ? ' fill-rule="evenodd"' : ''}/>`;
      case 'line':
        return `<line x1="${op.x1}" y1="${op.y1}" x2="${op.x2}" y2="${op.y2}" stroke="#000" stroke-width="${op.width}"/>`;
      case 'outline':
        return `<rect x="${op.rect.x}" y="${op.rect.y}" width="${op.rect.w}" height="${op.rect.h}" fill="none" stroke="#000" stroke-width="${op.width}"/>`;
      case 'text':
        return `<text x="${op.x}" y="${op.y}" font-family="Helvetica, Arial, sans-serif" font-size="${op.size}" text-anchor="middle">${escape(op.body)}</text>`;
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}mm" height="${f.height}mm" viewBox="0 0 ${f.width} ${f.height}">`,
    `<rect width="${f.width}" height="${f.height}" fill="#fff"/>`,
    ...parts,
    '</svg>',
  ].join('\n');
}
