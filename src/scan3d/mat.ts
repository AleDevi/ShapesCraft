import { markerCells, type FrameOp, type Rect } from '../core/frame';
import type { Point } from '../core/homography';

/**
 * The 3D base mat: an A4 sheet lying flat on the table, with a ring of ArUco
 * markers along its edge and an empty area in the middle for the object. With
 * 30 markers, enough of them stay visible from any side even when the object
 * hides a few. Ids start at 10 so the mat is never mistaken for the 2D frame
 * (ids 0..3). All measures in millimetres, origin at the sheet's top-left.
 */
export const MAT = {
  id: 'a4',
  width: 210,
  height: 297,
  margin: 8,
  marker: 20,
  perRow: 7,
  perColumn: 10,
  firstId: 10,
} as const;

export interface MatMarker { id: number; corners: Point[] }

/** Evenly spaced positions of `count` squares of `size` between `from` and `to`. */
function spread(from: number, to: number, count: number, size: number): number[] {
  const gap = (to - from - count * size) / (count - 1);
  return Array.from({ length: count }, (_, i) => from + i * (size + gap));
}

/** Every marker of the mat with its corners, clockwise from the top-left of the sheet. */
export function matMarkers(): MatMarker[] {
  const { width, height, margin, marker: s, perRow, perColumn, firstId } = MAT;
  const xs = spread(margin, width - margin, perRow, s);
  const ys = spread(margin, height - margin, perColumn, s);
  const origins: Point[] = [
    ...xs.map((x) => ({ x, y: ys[0] })),
    ...ys.slice(1, -1).map((y) => ({ x: xs[xs.length - 1], y })),
    ...[...xs].reverse().map((x) => ({ x, y: ys[ys.length - 1] })),
    ...[...ys.slice(1, -1)].reverse().map((y) => ({ x: xs[0], y })),
  ];
  return origins.map(({ x, y }, i) => ({
    id: firstId + i,
    corners: [
      { x, y },
      { x: x + s, y },
      { x: x + s, y: y + s },
      { x, y: y + s },
    ],
  }));
}

/** Where the object goes: inside the ring of markers, with a little clearance. */
export function objectArea(): Rect {
  const inset = MAT.margin + MAT.marker + 6;
  return { x: inset, y: inset, w: MAT.width - 2 * inset, h: MAT.height - 2 * inset };
}

export function matCenter(): Point {
  return { x: MAT.width / 2, y: MAT.height / 2 };
}

/** The printable mat as drawing primitives, for the PDF. */
export function matDrawing(labels: { title: string; scale: string; place: string }): FrameOp[] {
  const ops: FrameOp[] = [];
  const s = MAT.marker;
  for (const m of matMarkers()) {
    const { x, y } = m.corners[0];
    const cells = markerCells(m.id);
    const cell = s / cells.length;
    ops.push({ kind: 'fill', rects: [{ x, y, w: s, h: s }], gray: 0 });
    const white: Rect[] = [];
    cells.forEach((row, cy) =>
      row.forEach((v, cx) => {
        if (v) white.push({ x: x + cx * cell, y: y + cy * cell, w: cell + 0.02, h: cell + 0.02 });
      }),
    );
    ops.push({ kind: 'fill', rects: white, gray: 1 });
  }

  // Thin outline of the object area and a small cross at the centre.
  const area = objectArea();
  ops.push({ kind: 'outline', rect: area, width: 0.2 });
  const c = matCenter();
  ops.push({ kind: 'line', x1: c.x - 5, y1: c.y, x2: c.x + 5, y2: c.y, width: 0.2 });
  ops.push({ kind: 'line', x1: c.x, y1: c.y - 5, x2: c.x, y2: c.y + 5, width: 0.2 });

  // 100 mm ruler and labels along the bottom of the object area, to check the print scale.
  const ry = area.y + area.h - 14;
  const rx = c.x - 50;
  ops.push({ kind: 'line', x1: rx, y1: ry, x2: rx + 100, y2: ry, width: 0.3 });
  for (let i = 0; i <= 10; i++) {
    const len = i % 5 === 0 ? 3 : 1.5;
    ops.push({ kind: 'line', x1: rx + i * 10, y1: ry, x2: rx + i * 10, y2: ry + len, width: 0.3 });
  }
  ops.push({ kind: 'text', x: c.x, y: ry + 8, size: 3, body: labels.scale });
  ops.push({ kind: 'text', x: c.x, y: area.y + 8, size: 3.2, body: labels.title });
  ops.push({ kind: 'text', x: c.x, y: c.y + 12, size: 2.8, body: labels.place });
  return ops;
}
