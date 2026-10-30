import { AR } from '../vendor/js-aruco2/aruco.js';
import type { Point } from './homography';

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * A printable reference sheet: four ArUco markers (ids 0..3, clockwise from
 * the top-left) sit in the corners. All measures are in millimetres, with the
 * origin at the top-left corner of the sheet.
 */
export interface FrameLayout {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Distance of the markers (and of the work area) from the sheet edge. */
  margin: number;
  /** Side of the black marker square, border included. */
  markerSize: number;
  /** White padding around markers and labels that is never traced. */
  keepOut: number;
}

export const DICTIONARY = 'ARUCO_MIP_36h12';
export const MARKER_IDS = [0, 1, 2, 3] as const;

export const FRAMES: FrameLayout[] = [
  { id: 'a3', name: 'A3 (297 × 420 mm)', width: 297, height: 420, margin: 12, markerSize: 32, keepOut: 4 },
  { id: 'a2', name: 'A2 (420 × 594 mm)', width: 420, height: 594, margin: 14, markerSize: 44, keepOut: 5 },
];

export function frameById(id: string): FrameLayout {
  const frame = FRAMES.find((f) => f.id === id);
  if (!frame) throw new Error(`Cornice sconosciuta: ${id}`);
  return frame;
}

/** Top-left corner of each marker square, indexed by marker id. */
function markerOrigins(f: FrameLayout): Point[] {
  const far = { x: f.width - f.margin - f.markerSize, y: f.height - f.margin - f.markerSize };
  return [
    { x: f.margin, y: f.margin },
    { x: far.x, y: f.margin },
    { x: far.x, y: far.y },
    { x: f.margin, y: far.y },
  ];
}

/**
 * Sheet coordinates of the four corners of each marker, in the order the
 * detector reports them (top-left, top-right, bottom-right, bottom-left of the
 * upright marker).
 */
export function markerCorners(f: FrameLayout): Point[][] {
  const s = f.markerSize;
  return markerOrigins(f).map(({ x, y }) => [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ]);
}

export function workArea(f: FrameLayout): Rect {
  return { x: f.margin, y: f.margin, w: f.width - 2 * f.margin, h: f.height - 2 * f.margin };
}

/** Box at the bottom centre holding the scale ruler and the label. */
export function labelBox(f: FrameLayout): Rect {
  const w = 120;
  const h = 16;
  return { x: (f.width - w) / 2, y: f.height - f.margin - h, w, h };
}

/** Regions inside the work area that belong to the frame, not to the drawing. */
export function keepOutZones(f: FrameLayout): Rect[] {
  const k = f.keepOut;
  const markers = markerOrigins(f).map(({ x, y }) => ({
    x: x - k,
    y: y - k,
    w: f.markerSize + 2 * k,
    h: f.markerSize + 2 * k,
  }));
  const l = labelBox(f);
  return [...markers, { x: l.x - k, y: l.y - k, w: l.w + 2 * k, h: l.h + 2 * k }];
}

/** Marker bit matrix (1 = white cell), border included: markSize × markSize. */
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

/** Printable SVG of the sheet at real size. */
export function frameSvg(f: FrameLayout): string {
  const parts: string[] = [];
  const origins = markerOrigins(f);
  for (const id of MARKER_IDS) {
    const cells = markerCells(id);
    const cell = f.markerSize / cells.length;
    const { x, y } = origins[id];
    parts.push(`<rect x="${x}" y="${y}" width="${f.markerSize}" height="${f.markerSize}" fill="#000"/>`);
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

  const l = labelBox(f);
  const rx = l.x + 10;
  const ry = l.y + 4;
  parts.push(`<line x1="${rx}" y1="${ry}" x2="${rx + 100}" y2="${ry}" stroke="#000" stroke-width="0.3"/>`);
  for (let i = 0; i <= 10; i++) {
    const len = i % 5 === 0 ? 3 : 1.5;
    parts.push(`<line x1="${rx + i * 10}" y1="${ry}" x2="${rx + i * 10}" y2="${ry + len}" stroke="#000" stroke-width="0.3"/>`);
  }
  parts.push(
    `<text x="${l.x + l.w / 2}" y="${l.y + 13}" font-family="sans-serif" font-size="3.2" text-anchor="middle">` +
      `ShapesCraft ${f.id.toUpperCase()} · stampa al 100%: la linea = 100 mm</text>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}mm" height="${f.height}mm" viewBox="0 0 ${f.width} ${f.height}">`,
    `<rect width="${f.width}" height="${f.height}" fill="#fff"/>`,
    ...parts,
    '</svg>',
  ].join('\n');
}
