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
    const W = Math.round(this.canvas.clientWidth * dpr);
    const H = Math.round(this.canvas.clientHeight * dpr);
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const m = this.mesh;
    if (!m || !m.triangles.length || !W || !H) return;

    // Turn about the middle of the model's bounding box.
    const p = m.positions;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[i + k]);
        hi[k] = Math.max(hi[k], p[i + k]);
      }
    const mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    const r = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const scale = (Math.min(W, H) / 2 / r) * 0.92;
    const n = p.length / 3;
    // Screen space in device pixels: X right, Y down, Z away from the viewer.
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = p[i * 3] - mid[0], y = p[i * 3 + 1] - mid[1], z = p[i * 3 + 2] - mid[2];
      const x1 = cy * x - sy * y;
      const y1 = sy * x + cy * y;
      X[i] = W / 2 + x1 * scale;
      Y[i] = H / 2 - (cp * z + sp * y1) * scale;
      Z[i] = cp * y1 - sp * z;
    }

    // Flat shading with a depth buffer, so big flat faces and thin walls never paint over each other.
    const image = ctx.createImageData(W, H);
    const px = image.data;
    const depth = new Float32Array(W * H).fill(Infinity);
    const base = parseColor(this.colors().fill);
    const t = m.triangles;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k], b = t[k + 1], c = t[k + 2];
      const ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy2 = Y[c];
      const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx - ax);
      // Screen y points down, so a triangle facing the viewer winds clockwise: area < 0.
      if (area >= 0) continue;
      // Normal in view space (y up) for the light.
      const ux = (bx - ax) / scale, uy = -(by - ay) / scale, uz = Z[b] - Z[a];
      const vx = (cx - ax) / scale, vy = -(cy2 - ay) / scale, vz = Z[c] - Z[a];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = -(Math.hypot(nx, ny, nz) || 1);
      nx /= l; ny /= l; nz /= l;
      const light = 0.35 + 0.65 * Math.max(0, -0.35 * nx + 0.55 * ny - 0.75 * nz);
      const cr = base[0] * light, cg = base[1] * light, cb = base[2] * light;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy2))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy2)));
      const inv = 1 / area;
      for (let y = y0; y <= y1; y++) {
        const qy = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const qx = x + 0.5;
          // Barycentric weights; all ≤ 0 inside (clockwise triangle, negative area).
          const wa = ((bx - qx) * (cy2 - qy) - (by - qy) * (cx - qx)) * inv;
          const wb = ((cx - qx) * (ay - qy) - (cy2 - qy) * (ax - qx)) * inv;
          const wc = 1 - wa - wb;
          if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
          const z = wa * Z[a] + wb * Z[b] + wc * Z[c];
          const i = y * W + x;
          if (z >= depth[i]) continue;
          depth[i] = z;
          px[i * 4] = cr;
          px[i * 4 + 1] = cg;
          px[i * 4 + 2] = cb;
          px[i * 4 + 3] = 255;
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  }
}

function parseColor(css: string): number[] {
  const hex = css.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = css.match(/\d+(\.\d+)?/g);
  return rgb && rgb.length >= 3 ? rgb.slice(0, 3).map(Number) : [31, 111, 235];
}
