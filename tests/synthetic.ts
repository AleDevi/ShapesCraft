import { frameById, markerCells, markerCorners, markerSize, outerRect, windowRect, type FrameLayout, type Rect } from '../src/core/frame';
import { findHomography, invert3, applyH, type Mat3, type Point } from '../src/core/homography';
import type { Gray } from '../src/core/image';

export type Drawing = (x: number, y: number) => boolean;

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * Intensity at a point in mm of a cut-out frame lying on a sheet of paper with
 * a drawing in black: the window shows the paper, the band is grey with markers.
 */
function sheetValue(frame: FrameLayout, drawing: Drawing, x: number, y: number, ids: readonly number[]): number {
  if (inside(windowRect(frame), x, y)) return drawing(x, y) ? 0.1 : 0.95;
  if (!inside(outerRect(frame), x, y)) return x < -20 || y < -20 || x > frame.width + 20 || y > frame.height + 20 ? 0.25 : 0.95;
  const corners = markerCorners(frame);
  const s = markerSize(frame);
  for (let id = 0; id < 4; id++) {
    const o = corners[id][0];
    if (x >= o.x && x < o.x + s && y >= o.y && y < o.y + s) {
      const cells = markerCells(ids[id]);
      const n = cells.length;
      return cells[Math.floor(((y - o.y) / s) * n)][Math.floor(((x - o.x) / s) * n)] ? 0.95 : 0.08;
    }
    const quiet = frame.markerPad - 1;
    if (x >= o.x - quiet && x < o.x + s + quiet && y >= o.y - quiet && y < o.y + s + quiet) return 0.95;
  }
  return 0.82;
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
  ids: readonly number[] = [0, 1, 2, 3],
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
          v += sheetValue(frame, drawing, p.x, p.y, ids);
        }
      data[y * size.width + x] = (v / 4) * light(x / size.width, y / size.height);
    }
  return { photo: { width: size.width, height: size.height, data }, sheetToPhoto };
}
