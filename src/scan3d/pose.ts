import { AR } from '../vendor/js-aruco2/aruco.js';
import { DICTIONARY } from '../core/frame';
import { applyH, findHomography, invert3, solve, type Mat3, type Point } from '../core/homography';
import { downscale, grayToRgba, type Gray } from '../core/image';
import { refineQuad } from '../core/pipeline';
import { MATS, matById, matOfMarker, type MatId } from './mat';

/** Marker corners found in one photo: mat millimetres and photo pixels, pair by pair. */
export interface MatDetection {
  width: number;
  height: number;
  /** Which mat was recognised: the one with the most markers in view. */
  matId: MatId;
  markerIds: number[];
  mat: Point[];
  px: Point[];
}

/** Fewer markers than needed were found to locate the mat. */
export class MatNotFoundError extends Error {
  /** `frame2d`: the markers of the 2D frame were seen instead, so the wrong sheet was printed. */
  constructor(readonly markersFound: number, readonly frame2d = false) {
    super(`Mat not found: ${markersFound} markers recognised.`);
    this.name = 'MatNotFoundError';
  }
}

const DETECT_MAX_SIDE = 2000;
const MIN_MARKERS = 4;

export function detectMat(photo: Gray): MatDetection {
  const factor = Math.max(1, Math.ceil(Math.max(photo.width, photo.height) / DETECT_MAX_SIDE));
  const small = downscale(photo, factor);
  const found = new AR.Detector({ dictionaryName: DICTIONARY }).detect(grayToRgba(small));
  // The mat with the most markers in view; markers of any other mat are ignored.
  const votes = new Map<MatId, number>();
  for (const m of found) {
    const id = matOfMarker(m.id);
    if (id) votes.set(id, (votes.get(id) ?? 0) + 1);
  }
  const matId = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? MATS[0].id;
  const byId = new Map(matById(matId).markers.map((m) => [m.id, m.corners]));

  let ids: number[] = [];
  let mat: Point[][] = [];
  let px: Point[][] = [];
  for (const [id, corners] of byId) {
    const best = found.filter((m) => m.id === id).sort((a, b) => a.hammingDistance - b.hammingDistance)[0];
    if (!best) continue;
    const rough = best.corners.map((c) => ({ x: (c.x + 0.5) * factor, y: (c.y + 0.5) * factor }));
    ids.push(id);
    mat.push(corners);
    px.push(refineQuad(photo, rough, 2 * factor + 2));
  }
  if (ids.length < MIN_MARKERS) throw new MatNotFoundError(ids.length, found.some((m) => m.id >= 0 && m.id <= 3));

  // A misread marker id lands far from where the others predict it: drop it and refit.
  // The mat is flat, so a homography predicts every corner exactly.
  for (let round = 0; round < 3 && ids.length > MIN_MARKERS; round++) {
    const h = findHomography(mat.flat(), px.flat());
    const errs = mat.map((cs, i) => Math.max(...cs.map((c, k) => dist(applyH(h, c), px[i][k]))));
    const worst = errs.indexOf(Math.max(...errs));
    const median = [...errs].sort((a, b) => a - b)[Math.floor(errs.length / 2)];
    if (errs[worst] < Math.max(4, 5 * median)) break;
    ids = ids.filter((_, i) => i !== worst);
    mat = mat.filter((_, i) => i !== worst);
    px = px.filter((_, i) => i !== worst);
  }
  return { width: photo.width, height: photo.height, matId, markerIds: ids, mat: mat.flat(), px: px.flat() };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------
// Camera model: pinhole, square pixels, principal point at the image centre, no
// lens distortion. Mat coordinates: x right and y down the sheet, z into the
// table, so a camera above the mat has a negative z.

export type Vec3 = [number, number, number];
/** Row-major 3×3 rotation, mat → camera. */
export type Rot = number[];

export interface Pose {
  R: Rot;
  t: Vec3;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

function mulRot(a: Rot, b: Rot): Rot {
  const r: Rot = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return r;
}

/** Rotation by the axis-angle vector `w` (Rodrigues). */
export function rodrigues(w: Vec3): Rot {
  const th = norm(w);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(w, 1 / th);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

export function project(pose: Pose, f: number, cx: number, cy: number, p: Point): Point {
  const { R, t } = pose;
  const X = R[0] * p.x + R[1] * p.y + t[0];
  const Y = R[3] * p.x + R[4] * p.y + t[1];
  const Z = R[6] * p.x + R[7] * p.y + t[2];
  return { x: (f * X) / Z + cx, y: (f * Y) / Z + cy };
}

/** Camera position in mat millimetres: −Rᵀt. */
export function cameraCenter(pose: Pose): Vec3 {
  const { R, t } = pose;
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/** Viewing direction (camera's optical axis) in mat coordinates: the third row of R. */
export function viewDirection(pose: Pose): Vec3 {
  return [pose.R[6], pose.R[7], pose.R[8]];
}

/** Homography mat → photo centred on the principal point. */
function centredHomography(d: MatDetection): Mat3 {
  const cx = d.width / 2;
  const cy = d.height / 2;
  return findHomography(d.mat, d.px.map((p) => ({ x: p.x - cx, y: p.y - cy })));
}

/**
 * Focal length in pixels from one view of a plane (Zhang): the first two
 * columns of K⁻¹H are orthogonal and of equal length. Undefined when the mat
 * is seen straight from above, where any focal length fits.
 */
export function focalFromHomography(d: MatDetection): number | null {
  const s = Math.max(d.width, d.height);
  const h = centredHomography(d);
  const [a1, a2, b1, b2, c1, c2] = [h[0] / s, h[1] / s, h[3] / s, h[4] / s, h[6], h[7]];
  const A = [a1 * a2 + b1 * b2, a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2];
  const B = [c1 * c2, c1 * c1 - c2 * c2];
  const den = A[0] * A[0] + A[1] * A[1];
  if (den === 0) return null;
  const u = -(A[0] * B[0] + A[1] * B[1]) / den; // 1 / f², in units of the photo's long side
  if (!(u > 0)) return null;
  const f = 1 / Math.sqrt(u);
  return f > 0.3 && f < 3 ? f * s : null;
}

/** First guess of the pose from the homography, for a known focal length. */
function initialPose(d: MatDetection, f: number): Pose {
  const h = centredHomography(d);
  const m1: Vec3 = [h[0] / f, h[3] / f, h[6]];
  const m2: Vec3 = [h[1] / f, h[4] / f, h[7]];
  const m3: Vec3 = [h[2] / f, h[5] / f, h[8]];
  let k = 2 / (norm(m1) + norm(m2));
  // The mat is in front of the camera.
  if (m3[2] * k < 0) k = -k;
  const r1 = scale(m1, k / Math.abs(k) / norm(m1));
  const r2 = scale(m2, k);
  const along = dot(r1, r2);
  const r2o: Vec3 = [r2[0] - along * r1[0], r2[1] - along * r1[1], r2[2] - along * r1[2]];
  const r2n = scale(r2o, 1 / norm(r2o));
  const r3 = cross(r1, r2n);
  return {
    R: [r1[0], r2n[0], r3[0], r1[1], r2n[1], r3[1], r1[2], r2n[2], r3[2]],
    t: scale(m3, k),
  };
}

function residuals(pose: Pose, f: number, d: MatDetection): number[] {
  const cx = d.width / 2;
  const cy = d.height / 2;
  const r: number[] = [];
  d.mat.forEach((p, i) => {
    const q = project(pose, f, cx, cy, p);
    r.push(q.x - d.px[i].x, q.y - d.px[i].y);
  });
  return r;
}

const sumSq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

/** Applies a small update: rotation by `x[0..2]` on top of R, then `x[3..5]` added to t. */
function step(pose: Pose, x: number[]): Pose {
  return {
    R: mulRot(rodrigues([x[0], x[1], x[2]]), pose.R),
    t: [pose.t[0] + x[3], pose.t[1] + x[4], pose.t[2] + x[5]],
  };
}

/** Levenberg–Marquardt on the six pose parameters, minimising the reprojection error. */
export function refinePose(start: Pose, f: number, d: MatDetection, iterations = 30): Pose {
  let pose = start;
  let r = residuals(pose, f, d);
  let cost = sumSq(r);
  let lambda = 1e-3;
  // Step sizes for the numeric Jacobian: radians and millimetres.
  const eps = [1e-6, 1e-6, 1e-6, 1e-4, 1e-4, 1e-4];
  for (let it = 0; it < iterations; it++) {
    const J: number[][] = eps.map((e, j) => {
      const dx = [0, 0, 0, 0, 0, 0];
      dx[j] = e;
      const rp = residuals(step(pose, dx), f, d);
      return rp.map((v, i) => (v - r[i]) / e);
    });
    const JtJ = J.map((a) => J.map((b) => a.reduce((s, v, i) => s + v * b[i], 0)));
    const Jtr = J.map((a) => a.reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      let x: number[];
      try {
        x = solve(A, Jtr.map((v) => -v));
      } catch {
        lambda *= 10;
        continue;
      }
      const cand = step(pose, x);
      const rc = residuals(cand, f, d);
      const cc = sumSq(rc);
      if (cc < cost) {
        const gain = (cost - cc) / cost;
        pose = cand;
        r = rc;
        cost = cc;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = gain > 1e-10;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return pose;
}

export interface SolvedPhoto {
  pose: Pose;
  /** Root mean square reprojection error of the marker corners, in pixels. */
  rmsPx: number;
  /** Mean distance between the measured and the true corner positions on the mat, in mm. */
  meanMm: number;
  /** Camera position in mat mm (z up, origin at the mat centre) and how it looks at the mat. */
  heightMm: number;
  distanceMm: number;
  elevationDeg: number;
  azimuthDeg: number;
}

export interface SolvedSession {
  /** Focal length in units of the photo's long side (≈ 0.75 for a typical phone main camera). */
  focal: number;
  focalFromData: boolean;
  photos: SolvedPhoto[];
}

/** Typical phone main camera (about 26 mm equivalent): used when the photos can't tell. */
const DEFAULT_FOCAL = 0.78;

function solvePhoto(d: MatDetection, focal: number): SolvedPhoto {
  const f = focal * Math.max(d.width, d.height);
  const pose = refinePose(initialPose(d, f), f, d);
  const r = residuals(pose, f, d);
  const rmsPx = Math.sqrt(sumSq(r) / d.mat.length);

  // Back-project each detected corner onto the mat plane with the refined pose.
  const R = pose.R;
  const cx = d.width / 2;
  const cy = d.height / 2;
  // Mat plane → photo for the refined pose: K·[r1 r2 t].
  const H: Mat3 = [f * R[0] + cx * R[6], f * R[1] + cx * R[7], f * pose.t[0] + cx * pose.t[2],
    f * R[3] + cy * R[6], f * R[4] + cy * R[7], f * pose.t[1] + cy * pose.t[2],
    R[6], R[7], pose.t[2]];
  let meanMm = 0;
  const Hinv = invert3(H);
  d.px.forEach((p, i) => (meanMm += dist(applyH(Hinv, p), d.mat[i])));
  meanMm /= d.px.length;

  const c = cameraCenter(pose);
  const centre = matById(d.matId).center;
  const dx = c[0] - centre.x;
  const dy = c[1] - centre.y;
  const heightMm = -c[2];
  const ground = Math.hypot(dx, dy);
  return {
    pose,
    rmsPx,
    meanMm,
    heightMm,
    distanceMm: Math.hypot(ground, heightMm),
    elevationDeg: (Math.atan2(heightMm, ground) * 180) / Math.PI,
    // 0° = looking from the bottom edge of the sheet (where the ruler is), clockwise seen from above.
    azimuthDeg: ((Math.atan2(-dx, dy) * 180) / Math.PI + 360) % 360,
  };
}

function totalCost(dets: MatDetection[], focal: number): number {
  return dets.reduce((s, d) => s + solvePhoto(d, focal).rmsPx ** 2 * d.mat.length, 0);
}

/**
 * Solves every photo with one shared focal length (all photos come from the same
 * camera without zoom): a first guess from each photo's homography, then a
 * golden-section search for the focal length with the lowest total reprojection error.
 */
export function solveSession(dets: MatDetection[]): SolvedSession {
  if (new Set(dets.map((d) => d.matId)).size > 1) throw new Error('All views must show the same mat');
  const guesses = dets.map(focalFromHomography).map((f, i) => (f ? f / Math.max(dets[i].width, dets[i].height) : null)).filter((f): f is number => f !== null);
  let focal = DEFAULT_FOCAL;
  let focalFromData = false;
  if (guesses.length) {
    guesses.sort((a, b) => a - b);
    focal = guesses[Math.floor(guesses.length / 2)];
  }
  // At least two oblique views are needed for the focal length to be measurable.
  if (dets.length >= 2 && guesses.length >= 1) {
    let lo = focal * 0.6;
    let hi = focal * 1.6;
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo);
    let x2 = lo + g * (hi - lo);
    let f1 = totalCost(dets, x1);
    let f2 = totalCost(dets, x2);
    for (let i = 0; i < 25; i++) {
      if (f1 < f2) {
        hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = totalCost(dets, x1);
      } else {
        lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = totalCost(dets, x2);
      }
    }
    focal = (lo + hi) / 2;
    focalFromData = true;
  }
  return { focal, focalFromData, photos: dets.map((d) => solvePhoto(d, focal)) };
}
