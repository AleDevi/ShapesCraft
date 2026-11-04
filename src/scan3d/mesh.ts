import type { Volume } from './carve';

/**
 * Triangle mesh in millimetres for printing: origin at the centre of the object area on
 * the mat, x to the right of the sheet, y towards its top edge, z up. The object stands
 * on z = 0.
 */
export interface Mesh {
  positions: Float32Array;
  triangles: Uint32Array;
}

/**
 * The surface of the carved cubes, smoothed: the cubes are blurred into a soft field and
 * the surface passes where the field is one half ("surface nets": one vertex per cell
 * that the surface crosses, one quad per crossed edge). The mesh is closed, flat at the
 * base, and its triangles face outwards.
 * `step` > 1 averages step³ cubes into one first, for a lighter preview.
 */
export function surface(v: Volume, center: { x: number; y: number }, step = 1): Mesh {
  // Soft field on a grid padded with one empty layer all round, so the mesh closes.
  const sx = Math.ceil(v.nx / step), sy = Math.ceil(v.ny / step), sz = Math.ceil(v.nz / step);
  const NX = sx + 2, NY = sy + 2, NZ = sz + 2;
  let field: Float32Array = new Float32Array(NX * NY * NZ);
  for (let k = 0; k < v.nz; k++)
    for (let j = 0; j < v.ny; j++)
      for (let i = 0; i < v.nx; i++)
        if (v.data[i + v.nx * (j + v.ny * k)]) {
          const I = Math.floor(i / step) + 1, J = Math.floor(j / step) + 1, K = Math.floor(k / step) + 1;
          field[I + NX * (J + NY * K)] += 1 / step ** 3;
        }
  field = blur(field, NX, NY, NZ);
  // The base stays flat: the field keeps full strength right down to the table.
  for (let J = 0; J < NY; J++)
    for (let I = 0; I < NX; I++) {
      const above = field[I + NX * (J + NY * 2)];
      field[I + NX * (J + NY * 1)] = Math.max(field[I + NX * (J + NY * 1)], above);
    }

  const iso = 0.5;
  const at = (I: number, J: number, K: number) => field[I + NX * (J + NY * K)];
  const cell = new Int32Array(NX * NY * NZ).fill(-1);
  const pos: number[] = [];
  const voxel = v.voxel * step;
  // Grid sample (I, J, K) → output mm. Sample 1 is the centre of the first (merged) cube.
  const x0 = v.origin.x - v.voxel / 2 + voxel / 2 - voxel - center.x;
  const y0 = v.origin.y - v.voxel / 2 + voxel / 2 - voxel - center.y;
  // Cubes span 0..voxel in height: sample K sits at height (K − 1/2)·voxel; the base plane
  // between K = 0 and K = 1 (the field there jumps from 0 to ≥ 1) lands at height 0.
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const corner = new Float64Array(8);
  for (let K = 0; K < NZ - 1; K++)
    for (let J = 0; J < NY - 1; J++)
      for (let I = 0; I < NX - 1; I++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          corner[c] = at(I + (c & 1), J + ((c >> 1) & 1), K + ((c >> 2) & 1));
          if (corner[c] > iso) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let px = 0, py = 0, pz = 0, count = 0;
        for (const [a, b] of edges) {
          const ia = corner[a] > iso, ib = corner[b] > iso;
          if (ia === ib) continue;
          const s = (iso - corner[a]) / (corner[b] - corner[a]);
          px += (a & 1) + s * ((b & 1) - (a & 1));
          py += ((a >> 1) & 1) + s * (((b >> 1) & 1) - ((a >> 1) & 1));
          pz += ((a >> 2) & 1) + s * (((b >> 2) & 1) - ((a >> 2) & 1));
          count++;
        }
        cell[I + NX * (J + NY * K)] = pos.length / 3;
        const gx = I + px / count, gy = J + py / count, gz = K + pz / count;
        pos.push(x0 + gx * voxel, -(y0 + gy * voxel), Math.max(0, (gz - 0.5) * voxel));
      }

  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, c, b, a, d, c);
    else tris.push(a, b, c, a, c, d);
  };
  const C = (I: number, J: number, K: number) => (I < 0 || J < 0 || K < 0 ? -1 : cell[I + NX * (J + NY * K)]);
  for (let K = 0; K < NZ - 1; K++)
    for (let J = 0; J < NY - 1; J++)
      for (let I = 0; I < NX - 1; I++) {
        const inside = at(I, J, K) > iso;
        if (inside !== at(I + 1, J, K) > iso) quad(C(I, J - 1, K - 1), C(I, J, K - 1), C(I, J, K), C(I, J - 1, K), !inside);
        if (inside !== at(I, J + 1, K) > iso) quad(C(I - 1, J, K - 1), C(I - 1, J, K), C(I, J, K), C(I, J, K - 1), !inside);
        if (inside !== at(I, J, K + 1) > iso) quad(C(I - 1, J - 1, K), C(I, J - 1, K), C(I, J, K), C(I - 1, J, K), !inside);
      }

  const mesh = { positions: Float32Array.from(pos), triangles: Uint32Array.from(tris) };
  // The y axis was turned round for printing: make sure the triangles face outwards.
  if (signedVolume(mesh) < 0) {
    const t = mesh.triangles;
    for (let i = 0; i < t.length; i += 3) [t[i + 1], t[i + 2]] = [t[i + 2], t[i + 1]];
  }
  return mesh;
}

/** 3×3×3 box blur, once along each axis. */
function blur(f: Float32Array, NX: number, NY: number, NZ: number): Float32Array {
  let src = f;
  for (const [stride, n] of [[1, NX], [NX, NY], [NX * NY, NZ]]) {
    const dst = new Float32Array(src.length);
    for (let q = 0; q < src.length; q++) {
      const i = Math.floor(q / stride) % n;
      let s = src[q];
      if (i > 0) s += src[q - stride];
      if (i < n - 1) s += src[q + stride];
      dst[q] = s / 3;
    }
    src = dst;
  }
  return src;
}

/** Volume enclosed by the mesh, mm³: positive when the triangles face outwards. */
export function signedVolume(m: Mesh): number {
  const p = m.positions, t = m.triangles;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** Binary STL, the common format of 3D-printing software. Units: millimetres. */
export function stl(m: Mesh, name = 'ShapesCraft 3D'): ArrayBuffer {
  const count = m.triangles.length / 3;
  const buf = new ArrayBuffer(84 + 50 * count);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < Math.min(80, name.length); i++) bytes[i] = name.charCodeAt(i) & 0x7f;
  const view = new DataView(buf);
  view.setUint32(80, count, true);
  const p = m.positions, t = m.triangles;
  let o = 84;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const value of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
      view.setFloat32(o, value, true);
      o += 4;
    }
    o += 2;
  }
  return buf;
}
