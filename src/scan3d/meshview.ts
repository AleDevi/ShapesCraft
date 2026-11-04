import type { Mesh } from './mesh';

/** A small turntable view of the model: drag to turn it, flat shading, no libraries. */
export class MeshView {
  private yaw = 0.6;
  private pitch = 0.45;
  private mesh: Mesh | null = null;

  constructor(private canvas: HTMLCanvasElement, private colors: () => { fill: string; edge: string }) {
    let last: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      this.yaw += (e.clientX - last.x) * 0.01;
      this.pitch = Math.max(-0.3, Math.min(1.5, this.pitch + (e.clientY - last.y) * 0.01));
      last = { x: e.clientX, y: e.clientY };
      this.draw();
    });
    const end = () => (last = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  set(mesh: Mesh | null) {
    this.mesh = mesh;
    this.draw();
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const m = this.mesh;
    if (!m || !m.triangles.length) return;

    const p = m.positions;
    let zMax = 0, r = 1;
    for (let i = 0; i < p.length; i += 3) zMax = Math.max(zMax, p[i + 2]);
    for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 1], p[i + 2] - zMax / 2));
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const n = p.length / 3;
    // View space: X right, Y up, Z away from the viewer.
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2] - zMax / 2;
      const x1 = cy * x - sy * y;
      const y1 = sy * x + cy * y;
      X[i] = x1;
      Y[i] = cp * z + sp * y1;
      Z[i] = cp * y1 - sp * z;
    }
    const scale = (Math.min(w, h) / 2 / r) * 0.9;
    const t = m.triangles;
    const count = t.length / 3;
    const depth = new Float32Array(count);
    const order = new Uint32Array(count);
    for (let k = 0; k < count; k++) {
      depth[k] = Z[t[k * 3]] + Z[t[k * 3 + 1]] + Z[t[k * 3 + 2]];
      order[k] = k;
    }
    order.sort((a, b) => depth[b] - depth[a]);

    const { fill } = this.colors();
    const base = parseColor(fill);
    for (const k of order) {
      const a = t[k * 3], b = t[k * 3 + 1], c = t[k * 3 + 2];
      const ux = X[b] - X[a], uy = Y[b] - Y[a], uz = Z[b] - Z[a];
      const vx = X[c] - X[a], vy = Y[c] - Y[a], vz = Z[c] - Z[a];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      // View space is mirrored (Z points away), so the cross product comes out reversed.
      const l = -(Math.hypot(nx, ny, nz) || 1);
      nx /= l; ny /= l; nz /= l;
      // Facing away from the viewer: hidden by the front faces.
      if (nz > 0.05) continue;
      const light = 0.35 + 0.65 * Math.max(0, -0.35 * nx + 0.55 * ny - 0.75 * nz);
      ctx.fillStyle = `rgb(${base.map((v) => Math.round(v * light)).join(',')})`;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(w / 2 + X[a] * scale, h / 2 - Y[a] * scale);
      ctx.lineTo(w / 2 + X[b] * scale, h / 2 - Y[b] * scale);
      ctx.lineTo(w / 2 + X[c] * scale, h / 2 - Y[c] * scale);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

function parseColor(css: string): number[] {
  const hex = css.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = css.match(/\d+(\.\d+)?/g);
  return rgb && rgb.length >= 3 ? rgb.slice(0, 3).map(Number) : [31, 111, 235];
}
