import { markerCells, type FrameOp } from '../core/frame';
import type { Point } from '../core/homography';

/**
 * The 3D base mats, printed on A4 and laid flat on the table, with the object in
 * the middle and ArUco markers all around it, so enough of them stay visible from
 * any side even when the object hides a few. Each mat has its own marker ids, so
 * the app recognises which one is in the video, and none uses the 2D frame's ids
 * (0..3). All measures in millimetres, origin at the sheet's top-left corner.
 *
 * - `rect`: 30 markers along the edge of the sheet.
 * - `round`: 20 markers on a circle, the same from every side. It can be cut out and
 *   put on a turntable: the phone then stays still and the object turns.
 */
export type MatId = 'rect' | 'round';

export interface MatMarker { id: number; corners: Point[] }

export interface MatLayout {
  id: MatId;
  /** Printed sheet. */
  width: number;
  height: number;
  /** Centre of the object area, where the object goes and the cameras look. */
  center: Point;
  markers: MatMarker[];
  /** Outline of the mat (the sheet, or the circle to cut out). */
  outline: Point[];
  /** Outline of the area for the object. */
  area: Point[];
}

const A4 = { width: 210, height: 297 };

/** Evenly spaced positions of `count` squares of `size` between `from` and `to`. */
function spread(from: number, to: number, count: number, size: number): number[] {
  const gap = (to - from - count * size) / (count - 1);
  return Array.from({ length: count }, (_, i) => from + i * (size + gap));
}

function rectangle(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function circle(c: Point, r: number, segments = 96): Point[] {
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * 2 * Math.PI;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

function rectMat(): MatLayout {
  const margin = 8;
  const s = 20;
  const xs = spread(margin, A4.width - margin, 7, s);
  const ys = spread(margin, A4.height - margin, 10, s);
  const origins: Point[] = [
    ...xs.map((x) => ({ x, y: ys[0] })),
    ...ys.slice(1, -1).map((y) => ({ x: xs[xs.length - 1], y })),
    ...[...xs].reverse().map((x) => ({ x, y: ys[ys.length - 1] })),
    ...[...ys.slice(1, -1)].reverse().map((y) => ({ x: xs[0], y })),
  ];
  const inset = margin + s + 6;
  return {
    id: 'rect',
    ...A4,
    center: { x: A4.width / 2, y: A4.height / 2 },
    markers: origins.map(({ x, y }, i) => ({ id: 10 + i, corners: rectangle(x, y, s, s) })),
    outline: rectangle(0, 0, A4.width, A4.height),
    area: rectangle(inset, inset, A4.width - 2 * inset, A4.height - 2 * inset),
  };
}

/** Radius of the round mat's cut line, of the ring of marker centres, and of the object area. */
export const ROUND = { center: { x: 105, y: 135 }, cut: 98, ring: 82, area: 60, marker: 18, count: 20 } as const;

function roundMat(): MatLayout {
  const { center: c, ring, marker: s, count } = ROUND;
  const markers = Array.from({ length: count }, (_, i) => {
    // Clockwise from the top; each marker upright when seen from outside the circle.
    const phi = -Math.PI / 2 + (i / count) * 2 * Math.PI;
    const u = { x: Math.cos(phi), y: Math.sin(phi) };
    const ey = { x: -u.x, y: -u.y };
    const ex = { x: ey.y, y: -ey.x };
    const p = { x: c.x + ring * u.x, y: c.y + ring * u.y };
    const o = { x: p.x - (s / 2) * (ex.x + ey.x), y: p.y - (s / 2) * (ex.y + ey.y) };
    const at = (a: number, b: number) => ({ x: o.x + a * ex.x + b * ey.x, y: o.y + a * ex.y + b * ey.y });
    return { id: 40 + i, corners: [at(0, 0), at(s, 0), at(s, s), at(0, s)] };
  });
  return {
    id: 'round',
    ...A4,
    center: c,
    markers,
    outline: circle(c, ROUND.cut),
    area: circle(c, ROUND.area),
  };
}

export const MATS: MatLayout[] = [rectMat(), roundMat()];

export function matById(id: MatId): MatLayout {
  return MATS.find((m) => m.id === id)!;
}

/** The mat a marker id belongs to, if any. */
export function matOfMarker(id: number): MatId | null {
  return MATS.find((m) => m.markers.some((k) => k.id === id))?.id ?? null;
}

/** Point at fractions (a, b) of a marker square, from its first corner along its two sides. */
export function markerPoint(corners: Point[], a: number, b: number): Point {
  const [c0, c1, , c3] = corners;
  return { x: c0.x + a * (c1.x - c0.x) + b * (c3.x - c0.x), y: c0.y + a * (c1.y - c0.y) + b * (c3.y - c0.y) };
}

function outlineOps(points: Point[], width: number): FrameOp[] {
  return points.map((p, i) => {
    const q = points[(i + 1) % points.length];
    return { kind: 'line', x1: p.x, y1: p.y, x2: q.x, y2: q.y, width };
  });
}

export interface MatLabels { title: string; scale: string; place: string; cut?: string }

/** The printable mat as drawing primitives, for the PDF. */
export function matDrawing(mat: MatLayout, labels: MatLabels): FrameOp[] {
  const ops: FrameOp[] = [];
  for (const m of mat.markers) {
    const cells = markerCells(m.id);
    const n = cells.length;
    ops.push({ kind: 'poly', points: m.corners, gray: 0 });
    cells.forEach((row, cy) =>
      row.forEach((v, cx) => {
        if (!v) return;
        // Slight overlap avoids hairline seams between adjacent white cells.
        const e = 0.02 / 20;
        ops.push({
          kind: 'poly',
          gray: 1,
          points: [
            markerPoint(m.corners, cx / n, cy / n),
            markerPoint(m.corners, (cx + 1) / n + e, cy / n),
            markerPoint(m.corners, (cx + 1) / n + e, (cy + 1) / n + e),
            markerPoint(m.corners, cx / n, (cy + 1) / n + e),
          ],
        });
      }),
    );
  }

  // Object area, a small cross at the centre, and the cut line of the round mat.
  ops.push(...outlineOps(mat.area, 0.2));
  if (mat.id === 'round') ops.push(...outlineOps(mat.outline, 0.3));
  const c = mat.center;
  ops.push({ kind: 'line', x1: c.x - 5, y1: c.y, x2: c.x + 5, y2: c.y, width: 0.2 });
  ops.push({ kind: 'line', x1: c.x, y1: c.y - 5, x2: c.x, y2: c.y + 5, width: 0.2 });
  ops.push({ kind: 'text', x: c.x, y: c.y + 12, size: 2.8, body: labels.place });

  // 100 mm ruler, to check the print scale: inside the area of the sheet mat, below the circle of the round one.
  const areaBottom = Math.max(...mat.area.map((p) => p.y));
  const ry = mat.id === 'rect' ? areaBottom - 14 : c.y + ROUND.cut + 20;
  const rx = A4.width / 2 - 50;
  ops.push({ kind: 'line', x1: rx, y1: ry, x2: rx + 100, y2: ry, width: 0.3 });
  for (let i = 0; i <= 10; i++) {
    const len = i % 5 === 0 ? 3 : 1.5;
    ops.push({ kind: 'line', x1: rx + i * 10, y1: ry, x2: rx + i * 10, y2: ry + len, width: 0.3 });
  }
  ops.push({ kind: 'text', x: A4.width / 2, y: ry + 8, size: 3, body: labels.scale });
  const titleY = mat.id === 'rect' ? Math.min(...mat.area.map((p) => p.y)) + 8 : c.y - ROUND.cut - 10;
  ops.push({ kind: 'text', x: A4.width / 2, y: titleY, size: 3.2, body: labels.title });
  if (mat.id === 'round' && labels.cut) ops.push({ kind: 'text', x: A4.width / 2, y: ry + 15, size: 2.8, body: labels.cut });
  return ops;
}
