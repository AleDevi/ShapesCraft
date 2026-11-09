import type { MatLayout } from './mat';
import { colorMasks } from './colors';
import { carveByDepth } from './stereo';
import { OBJECT, PAPER, paperMap, projection, silhouettes, type Backdrop, type View } from './silhouette';

/**
 * Shape from silhouettes ("voxel carving"): the space above the object area is split
 * into small cubes, and each cube is kept only if the frames that can see it agree it
 * is inside the object. A cube that in several frames lies in front of plain paper is
 * empty space and is carved away. What's left is the object's outer shell (its visual
 * hull): exact for convex and boxy objects, filled in for hollows such as the inside
 * of a cup.
 *
 * Coordinates are mat millimetres: x right and y down the sheet, z into the table.
 */
export interface Volume {
  nx: number;
  ny: number;
  nz: number;
  /** Cube side, mm. */
  voxel: number;
  /** Centre of cube (0, 0, 0) in mat mm; cube k is at z = origin.z − k·voxel (upwards). */
  origin: { x: number; y: number; z: number };
  /** 1 = object. Index i + nx·(j + ny·k). */
  data: Uint8Array;
  /** Surface points measured from depth (mat mm, x y z triples), when there are any. */
  points?: Float32Array;
}

/** Above this many cubes the carving gets slow on phones: the cube grows instead. */
const MAX_VOXELS = 2_500_000;
/**
 * A cube seen in front of plain background by this many frames is carved away. One
 * frame alone could be a misread pixel; two that agree are not.
 */
const PAPER_VOTES = 2;
/** The lowest millimetres carry printed ink and shadows: they follow the column above. */
const BASE_MM = 3;

export async function carve(mat: MatLayout, views: View[], onProgress: (done: number) => Promise<void> | void = () => undefined, passes = COLOR_PASSES, depth = true): Promise<Volume> {
  // The object area, and as high as twice its smaller half-width.
  const xs = mat.area.map((p) => p.x), ys = mat.area.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const height = Math.min(x1 - x0, y1 - y0);
  const voxel = Math.max(0.5, Math.ceil(Math.cbrt(((x1 - x0) * (y1 - y0) * height) / MAX_VOXELS) * 10) / 10);
  const nx = Math.ceil((x1 - x0) / voxel), ny = Math.ceil((y1 - y0) / voxel), nz = Math.ceil(height / voxel);
  const origin = { x: x0 + voxel / 2, y: y0 + voxel / 2, z: -voxel / 2 };

  // Only cubes standing on the object area count (a circle on the round mats).
  const inArea = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) inArea[j * nx + i] = insidePolygon(origin.x + i * voxel, origin.y + j * voxel, mat.area) ? 1 : 0;

  const radius = Math.max(...mat.area.map((p) => Math.hypot(p.x - mat.center.x, p.y - mat.center.y)));
  const reach = { x: mat.center.x, y: mat.center.y, radius, height };
  const grid = { nx, ny, nz, voxel, origin, inArea };
  await onProgress(0);
  const backdrops: Backdrop[] = [];
  let masks = silhouettes(views, paperMap(mat), reach, backdrops);
  await onProgress(0.1);
  let volume = await vote(grid, views, masks, (d) => onProgress(0.1 + 0.3 * d));
  // Then again, with the colours learnt from the first shape.
  for (let pass = 0; pass < passes && measure(volume); pass++) {
    const span = 0.3 / Math.max(1, passes), start = 0.4 + pass * span;
    masks = colorMasks(views, backdrops, masks, volume);
    await onProgress(start + span * 0.3);
    volume = await vote(grid, views, masks, (d) => onProgress(start + span * (0.3 + 0.7 * d)));
  }
  // Last, what the frames see through, from the depths they agree on.
  if (depth && measure(volume)) {
    volume = await carveByDepth(views, volume, (d) => onProgress(0.7 + 0.3 * d));
    keepLargest(volume);
  }
  await onProgress(1);
  return volume;
}

/** How many times the colours are learnt again from the shape so far. */
const COLOR_PASSES = 2;

interface Grid { nx: number; ny: number; nz: number; voxel: number; origin: Volume['origin']; inArea: Uint8Array }

/** Carves the cubes with the frames' silhouette masks. */
async function vote(grid: Grid, views: View[], masks: Uint8Array[], onProgress: (done: number) => Promise<void> | void): Promise<Volume> {
  const { nx, ny, nz, voxel, origin, inArea } = grid;
  const n = nx * ny * nz;
  const paper = new Uint16Array(n);
  const object = new Uint16Array(n);
  for (let vi = 0; vi < views.length; vi++) {
    const v = views[vi];
    const mask = masks[vi];
    const P = projection(v);
    const w = v.image.width, h = v.image.height;
    for (let k = 0; k < nz; k++) {
      const z = origin.z - k * voxel;
      for (let j = 0; j < ny; j++) {
        const y = origin.y + j * voxel;
        // Projection is linear in x along a row: start values and steps.
        let X = P[0] * origin.x + P[1] * y + P[2] * z + P[3];
        let Y = P[4] * origin.x + P[5] * y + P[6] * z + P[7];
        let Z = P[8] * origin.x + P[9] * y + P[10] * z + P[11];
        const dX = P[0] * voxel, dY = P[4] * voxel, dZ = P[8] * voxel;
        const row = nx * (j + ny * k);
        for (let i = 0; i < nx; i++, X += dX, Y += dY, Z += dZ) {
          if (!inArea[j * nx + i] || Z <= 0) continue;
          const u = Math.floor(X / Z), vv = Math.floor(Y / Z);
          if (u < 0 || vv < 0 || u >= w || vv >= h) continue;
          const m = mask[vv * w + u];
          if (m === PAPER) paper[row + i]++;
          else if (m === OBJECT) object[row + i]++;
        }
      }
    }
    await onProgress((vi + 1) / views.length);
  }

  const data = new Uint8Array(n);
  for (let q = 0; q < n; q++) {
    data[q] = object[q] > 0 && paper[q] < PAPER_VOTES ? 1 : 0;
  }

  // Printed ink and shadows right on the paper would leave a thin skirt: the bottom
  // cubes keep whatever the column decides just above them.
  const base = Math.min(nz - 1, Math.ceil(BASE_MM / voxel));
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const above = data[i + nx * (j + ny * base)];
      for (let k = 0; k < base; k++) data[i + nx * (j + ny * k)] = above;
    }

  const volume = { nx, ny, nz, voxel, origin, data };
  keepLargest(volume);
  return volume;
}

function insidePolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Keeps only the biggest connected piece: specks from misread pixels go. */
function keepLargest(v: Volume) {
  const { nx, ny, nz, data } = v;
  const label = new Int32Array(data.length);
  const stack = new Int32Array(data.length);
  let best = 0, bestSize = 0, next = 0;
  for (let s = 0; s < data.length; s++) {
    if (!data[s] || label[s]) continue;
    next++;
    let size = 0, top = 0;
    stack[top++] = s;
    label[s] = next;
    while (top) {
      const q = stack[--top];
      size++;
      const i = q % nx, j = Math.floor(q / nx) % ny, k = Math.floor(q / (nx * ny));
      const visit = (r: number) => {
        if (data[r] && !label[r]) {
          label[r] = next;
          stack[top++] = r;
        }
      };
      if (i > 0) visit(q - 1);
      if (i < nx - 1) visit(q + 1);
      if (j > 0) visit(q - nx);
      if (j < ny - 1) visit(q + nx);
      if (k > 0) visit(q - nx * ny);
      if (k < nz - 1) visit(q + nx * ny);
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  for (let s = 0; s < data.length; s++) if (data[s] && label[s] !== best) data[s] = 0;
}

/** Size of the object (bounding box) and its volume. */
export function measure(v: Volume): { width: number; depth: number; height: number; volumeMl: number } | null {
  let i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1, k1 = -1, count = 0;
  for (let k = 0; k < v.nz; k++)
    for (let j = 0; j < v.ny; j++)
      for (let i = 0; i < v.nx; i++)
        if (v.data[i + v.nx * (j + v.ny * k)]) {
          count++;
          i0 = Math.min(i0, i); i1 = Math.max(i1, i);
          j0 = Math.min(j0, j); j1 = Math.max(j1, j);
          k1 = Math.max(k1, k);
        }
  if (!count) return null;
  return {
    width: (i1 - i0 + 1) * v.voxel,
    depth: (j1 - j0 + 1) * v.voxel,
    height: (k1 + 1) * v.voxel,
    volumeMl: (count * v.voxel ** 3) / 1000,
  };
}
