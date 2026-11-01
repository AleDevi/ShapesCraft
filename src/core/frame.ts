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

/** Printable SVG of the frame at real size. */
export function frameSvg(f: FrameLayout, lang: Lang = 'en'): string {
  const t = translator(lang);
  const parts: string[] = [];
  const outer = outerRect(f);
  const win = windowRect(f);
  const s = markerSize(f);

  // Grey band with the window punched out (even-odd), so the frame reads as a frame.
  const rectPath = (r: Rect) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`;
  parts.push(`<path d="${rectPath(outer)} ${rectPath(win)}" fill="#d9d9d9" fill-rule="evenodd"/>`);

  const origins = markerOrigins(f);
  for (const id of MARKER_IDS) {
    const cells = markerCells(id);
    const cell = s / cells.length;
    const { x, y } = origins[id];
    // White quiet zone: the detector needs contrast all around the marker.
    parts.push(`<rect x="${x - f.markerPad + 1}" y="${y - f.markerPad + 1}" width="${s + 2 * f.markerPad - 2}" height="${s + 2 * f.markerPad - 2}" fill="#fff"/>`);
    parts.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="#000"/>`);
    cells.forEach((row, cy) =>
      row.forEach((v, cx) => {
        if (v) {
          // Slight overlap avoids hairline seams between adjacent white cells.
          parts.push(
            `<rect x="${x + cx * cell}" y="${y + cy * cell}" width="${cell + 0.02}" height="${cell + 0.02}" fill="#fff"/>`,
          );
        }
      }),
    );
  }

  // Scale ruler and label on the bottom band, between the markers.
  const cx = f.width / 2;
  const bandTop = f.height - f.margin - f.band;
  const rx = cx - 50;
  const ry = bandTop + f.band * 0.35;
  parts.push(`<line x1="${rx}" y1="${ry}" x2="${rx + 100}" y2="${ry}" stroke="#000" stroke-width="0.3"/>`);
  for (let i = 0; i <= 10; i++) {
    const len = i % 5 === 0 ? 3 : 1.5;
    parts.push(`<line x1="${rx + i * 10}" y1="${ry}" x2="${rx + i * 10}" y2="${ry + len}" stroke="#000" stroke-width="0.3"/>`);
  }
  const text = (y: number, size: number, body: string) =>
    `<text x="${cx}" y="${y}" font-family="sans-serif" font-size="${size}" text-anchor="middle">${body}</text>`;
  parts.push(text(ry + 8, 3, `ShapesCraft ${f.id.toUpperCase()} · ${t('sheet.scale')}`));
  parts.push(text(f.margin + f.band / 2 - 1, 2.8, t('sheet.glue1')));
  parts.push(text(f.margin + f.band / 2 + 3, 2.8, t('sheet.glue2')));

  // Cut lines.
  for (const r of [outer, win]) {
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#000" stroke-width="0.3"/>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}mm" height="${f.height}mm" viewBox="0 0 ${f.width} ${f.height}">`,
    `<rect width="${f.width}" height="${f.height}" fill="#fff"/>`,
    ...parts,
    '</svg>',
  ].join('\n');
}
