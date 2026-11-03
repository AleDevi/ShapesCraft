import { MAT, matMarkers, objectArea } from './mat';
import { cameraCenter, type SolvedPhoto, type Vec3 } from './pose';

/** Mat millimetres → display space: origin at the mat centre, y up. */
function toDisplay(p: Vec3): Vec3 {
  return [p[0] - MAT.width / 2, -p[2], p[1] - MAT.height / 2];
}

export interface Colors { text: string; muted: string; accent: string; border: string; card: string; good: string; fair: string; poor: string }

export function quality(p: SolvedPhoto): 'good' | 'fair' | 'poor' {
  return p.meanMm < 0.5 ? 'good' : p.meanMm < 1.2 ? 'fair' : 'poor';
}

/** A small orbiting 3D view of the mat and of where each photo was taken. */
export class SceneView {
  private yaw = -0.5;
  private pitch = 0.6;
  private photos: SolvedPhoto[] = [];
  private photoSize = { width: 4, height: 3, focal: 0.78 };

  constructor(private canvas: HTMLCanvasElement, private colors: () => Colors) {
    let last: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      this.yaw += (e.clientX - last.x) * 0.01;
      this.pitch = Math.max(-0.1, Math.min(1.5, this.pitch + (e.clientY - last.y) * 0.01));
      last = { x: e.clientX, y: e.clientY };
      this.draw();
    });
    const end = () => (last = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  set(photos: SolvedPhoto[], photoSize: { width: number; height: number; focal: number }) {
    this.photos = photos;
    this.photoSize = photoSize;
    this.draw();
  }

  draw() {
    const c = this.colors();
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const centres = this.photos.map((p) => toDisplay(cameraCenter(p.pose)));
    const radius = Math.max(200, ...centres.map((q) => Math.hypot(...q))) * 1.1;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const eye = radius * 3;
    const zoom = (Math.min(w, h) / 2 / radius) * 0.95 * (eye / (eye - radius * 0.3));
    const proj = (p: Vec3) => {
      const x1 = cy * p[0] + sy * p[2];
      const z1 = -sy * p[0] + cy * p[2];
      const y2 = cp * p[1] - sp * z1;
      const z2 = sp * p[1] + cp * z1;
      const k = (eye / (eye + z2)) * zoom;
      return { x: w / 2 + x1 * k, y: h / 2 + 30 - y2 * k };
    };
    const poly = (pts: Vec3[], fill?: string, stroke?: string) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const q = proj(p);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    };
    const flat = (x: number, y: number): Vec3 => toDisplay([x, y, 0]);

    // The mat, its markers and the object area.
    poly([flat(0, 0), flat(MAT.width, 0), flat(MAT.width, MAT.height), flat(0, MAT.height)], c.card, c.border);
    for (const m of matMarkers()) poly(m.corners.map((q) => flat(q.x, q.y)), c.muted);
    const a = objectArea();
    ctx.setLineDash([4, 4]);
    poly([flat(a.x, a.y), flat(a.x + a.w, a.y), flat(a.x + a.w, a.y + a.h), flat(a.x, a.y + a.h)], undefined, c.muted);
    ctx.setLineDash([]);

    // Cameras, farthest first so nearer ones are drawn on top.
    const { width, height, focal } = this.photoSize;
    const long = Math.max(width, height);
    const half = { x: width / long / 2 / focal, y: height / long / 2 / focal };
    const depth = radius * 0.12;
    const order = this.photos.map((_, i) => i).sort((i, j) => depthOf(centres[j]) - depthOf(centres[i]));
    function depthOf(p: Vec3) {
      const z1 = -sy * p[0] + cy * p[2];
      return sp * p[1] + cp * z1;
    }
    ctx.lineWidth = 1.5;
    ctx.font = '12px system-ui, sans-serif';
    for (const i of order) {
      const p = this.photos[i];
      const R = p.pose.R;
      const centre = cameraCenter(p.pose);
      // Camera axes in mat coordinates are the rows of R.
      const ax: Vec3 = [R[0], R[1], R[2]];
      const ay: Vec3 = [R[3], R[4], R[5]];
      const az: Vec3 = [R[6], R[7], R[8]];
      const corner = (sx: number, sy2: number): Vec3 =>
        toDisplay([0, 1, 2].map((k) => centre[k] + depth * (az[k] + sx * half.x * ax[k] + sy2 * half.y * ay[k])) as Vec3);
      const color = c[quality(p)];
      const apex = toDisplay(centre);
      const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      for (const q of quad) poly([apex, q], undefined, color);
      poly(quad, undefined, color);
      // The top edge shows which way is up in the photo.
      poly([corner(-1, -1), corner(0, -1.6), corner(1, -1)], color);
      const label = proj(apex);
      ctx.fillStyle = c.text;
      ctx.fillText(String(i + 1), label.x + 6, label.y - 6);
    }
  }
}

/** Polar map of the viewing directions: azimuth around, elevation from the edge (0°) to the centre (90°). */
export function drawCoverage(canvas: HTMLCanvasElement, photos: SolvedPhoto[], c: Colors) {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const mid = size / 2;
  const R = mid - 14;
  const rings = [0, 30, 60, 90];
  const sectors = 12;
  const radius = (elev: number) => (R * (90 - elev)) / 90;
  // Seen from above with the sheet upright: azimuth 0° (the bottom edge of the sheet) points down.
  const angle = (az: number) => (az * Math.PI) / 180 + Math.PI / 2;

  for (let r = 0; r < 3; r++)
    for (let s = 0; s < sectors; s++) {
      const a0 = s * (360 / sectors);
      const covered = photos.some((p) => {
        const e = Math.max(0, Math.min(89.9, p.elevationDeg));
        return e >= rings[r] && e < rings[r + 1] && ((p.azimuthDeg - a0 + 360) % 360) < 360 / sectors;
      });
      ctx.beginPath();
      ctx.arc(mid, mid, radius(rings[r]), angle(a0), angle(a0 + 360 / sectors), false);
      ctx.arc(mid, mid, radius(rings[r + 1]), angle(a0 + 360 / sectors), angle(a0), true);
      ctx.closePath();
      ctx.fillStyle = covered ? c.accent : c.border;
      ctx.globalAlpha = covered ? 0.35 : 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.card;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  photos.forEach((p, i) => {
    const r = radius(Math.max(0, Math.min(90, p.elevationDeg)));
    const a = angle(p.azimuthDeg);
    const x = mid + r * Math.cos(a);
    const y = mid + r * Math.sin(a);
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, 2 * Math.PI);
    ctx.fillStyle = c[quality(p)];
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(String(i + 1), x, y + 0.5);
  });
}
