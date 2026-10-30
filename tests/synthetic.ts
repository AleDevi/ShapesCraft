import { frameById, markerCells, markerCorners, type FrameLayout } from '../src/core/frame';
import { findHomography, invert3, applyH, type Mat3, type Point } from '../src/core/homography';
import type { Gray } from '../src/core/image';

export type Drawing = (x: number, y: number) => boolean;

/** Sheet intensity at a point in mm: markers plus a drawing in black on white. */
function sheetValue(frame: FrameLayout, drawing: Drawing, x: number, y: number): number {
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return 0.25; // table
  const corners = markerCorners(frame);
  for (let id = 0; id < 4; id++) {
    const o = corners[id][0];
    const s = frame.markerSize;
    if (x >= o.x && x < o.x + s && y >= o.y && y < o.y + s) {
      const cells = markerCells(id);
      const n = cells.length;
      return cells[Math.floor(((y - o.y) / s) * n)][Math.floor(((x - o.x) / s) * n)] ? 0.95 : 0.08;
    }
  }
  return drawing(x, y) ? 0.1 : 0.95;
}

/**
 * Renders a photo of the sheet seen in perspective. `sheetCornersPx` are where the
 * sheet's TL, TR, BR, BL corners land in the photo.
 */
export function renderPhoto(
  frameId: string,
  drawing: Drawing,
  size: { width: number; height: number },
  sheetCornersPx: Point[],
  light = (_x: number, _y: number) => 1,
): { photo: Gray; sheetToPhoto: Mat3 } {
  const frame = frameById(frameId);
  const sheet = [
    { x: 0, y: 0 },
    { x: frame.width, y: 0 },
    { x: frame.width, y: frame.height },
    { x: 0, y: frame.height },
  ];
  const sheetToPhoto = findHomography(sheet, sheetCornersPx);
  const photoToSheet = invert3(sheetToPhoto);
  const data = new Float32Array(size.width * size.height);
  const ss = [0.25, 0.75];
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      let v = 0;
      for (const sy of ss)
        for (const sx of ss) {
          const p = applyH(photoToSheet, { x: x + sx, y: y + sy });
          v += sheetValue(frame, drawing, p.x, p.y);
        }
      data[y * size.width + x] = (v / 4) * light(x / size.width, y / size.height);
    }
  return { photo: { width: size.width, height: size.height, data }, sheetToPhoto };
}
