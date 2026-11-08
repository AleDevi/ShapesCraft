import { describe, expect, it } from 'vitest';
import { UNIQUE_FIRST, isUniqueId, randomUniqueIds, uniqueCode, uniqueSlot, validUniqueIds } from '../src/core/markers';
import { detectFrame } from '../src/core/pipeline';
import { frameById, frameDrawing } from '../src/core/frame';
import { framePdf } from '../src/core/pdf';
import { detectMat, solveSession, cameraCenter, type Vec3 } from '../src/scan3d/pose';
import { MATS, matById, matDrawing, uniqueMat } from '../src/scan3d/mat';
import { matPdf } from '../src/scan3d/pdf';
import { renderPhoto } from './synthetic';
import { shoot } from './synthetic3d';

/** A seeded generator, so a failing test can be reproduced. */
function seeded(seed: number) {
  return (k: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * k);
  };
}

describe('unique marker ids', () => {
  it('put each id in its own position and never reuse the fixed ids', () => {
    for (const mat of [{ markers: { length: 4 } }, ...MATS]) {
      const n = mat.markers.length;
      for (let s = 1; s < 30; s++) {
        const ids = randomUniqueIds(n, seeded(s));
        expect(validUniqueIds(ids, n)).toBe(true);
        expect(ids.every(isUniqueId)).toBe(true);
        expect(ids.every((id, i) => id >= UNIQUE_FIRST && id < 250 && uniqueSlot(id, n) === i)).toBe(true);
      }
    }
  });

  it('give a code that is the same for the same ids and different otherwise', () => {
    const a = randomUniqueIds(4, seeded(1));
    const b = randomUniqueIds(4, seeded(2));
    expect(uniqueCode(a)).toBe(uniqueCode([...a]));
    expect(uniqueCode(a)).not.toBe(uniqueCode(b));
    expect(uniqueCode(a)).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
    const codes = new Set(Array.from({ length: 500 }, () => uniqueCode(randomUniqueIds(4))));
    expect(codes.size).toBeGreaterThan(490);
  });

  it('use the real random source by default', () => {
    expect(validUniqueIds(randomUniqueIds(20), 20)).toBe(true);
  });
});

describe('unique 2D frame', () => {
  const ids = randomUniqueIds(4, seeded(7));
  const corners = [{ x: 140, y: 110 }, { x: 1060, y: 150 }, { x: 1100, y: 1400 }, { x: 90, y: 1350 }];

  it('prints the project code on the sheet', () => {
    const texts = frameDrawing(frameById('a4'), 'it', ids).filter((op) => op.kind === 'text').map((op) => (op as { body: string }).body);
    expect(texts).toContain(`marker unici · codice ${uniqueCode(ids)}`);
    expect(framePdf(frameById('a4'), 'it', ids).length).toBeGreaterThan(1000);
    expect(frameDrawing(frameById('a4'), 'it').some((op) => op.kind === 'text' && op.body.includes('codice'))).toBe(false);
  });

  it('is found with its code, as precisely as the fixed frame', () => {
    const { photo, sheetToPhoto } = renderPhoto('a4', () => false, { width: 1200, height: 1500 }, corners, undefined, ids);
    const det = detectFrame(photo, frameById('a4'));
    expect(det.unique).toBe(true);
    expect(det.markerIds).toEqual(ids);
    expect(det.code).toBe(uniqueCode(ids));
    expect(det.errorPx).toBeLessThan(0.5);
    const p = { x: 105, y: 148.5 };
    const q = (h: number[]) => ({ x: (h[0] * p.x + h[1] * p.y + h[2]) / (h[6] * p.x + h[7] * p.y + h[8]), y: (h[3] * p.x + h[4] * p.y + h[5]) / (h[6] * p.x + h[7] * p.y + h[8]) });
    const a = q(det.sheetToPhoto), b = q(sheetToPhoto);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
  });

  it('is found with three markers, without a code', () => {
    // The bottom-left corner shows a marker of the fixed frame instead: it is ignored.
    const { photo } = renderPhoto('a4', () => false, { width: 1200, height: 1500 }, corners, undefined, [ids[0], ids[1], ids[2], 0]);
    const det = detectFrame(photo, frameById('a4'));
    expect(det.unique).toBe(true);
    expect(det.markerIds).toEqual(ids.slice(0, 3));
    expect(det.code).toBeUndefined();
  });

  it('still finds the fixed frame as before', () => {
    const { photo } = renderPhoto('a4', () => false, { width: 1200, height: 1500 }, corners);
    const det = detectFrame(photo, frameById('a4'));
    expect(det.unique).toBe(false);
    expect(det.markerIds).toEqual([0, 1, 2, 3]);
    expect(det.code).toBeUndefined();
  });
});

describe.each(['rect', 'round', 'round-small'] as const)('unique 3D mat %s', (matId) => {
  const base = matById(matId);
  const ids = randomUniqueIds(base.markers.length, seeded(11));
  const mat = uniqueMat(base, ids);
  const W = 1600, H = 1200, focal = 0.75;
  const c = base.center;
  const d = matId === 'rect' ? 400 : matId === 'round' ? 380 : 260;
  const cams: Vec3[] = [0, 1, 2].map((k) => {
    const a = (k / 3) * 2 * Math.PI + 0.4;
    return [c.x + d * Math.sin(a), c.y + d * Math.cos(a), (k % 2 ? -0.75 : -1.05) * d];
  });

  it('is recognised by its shape and gives the camera positions', { timeout: 60000 }, () => {
    const dets = cams.map((p) => detectMat(shoot(p, focal * W, W, H, mat)));
    for (const det of dets) {
      expect(det.matId).toBe(matId);
      expect(det.unique).toBe(true);
      expect(det.markerIds.length).toBeGreaterThanOrEqual(8);
      expect(det.markerIds.every((id) => ids.includes(id))).toBe(true);
    }
    const session = solveSession(dets);
    session.photos.forEach((p, i) => {
      const cc = cameraCenter(p.pose);
      expect(Math.hypot(cc[0] - cams[i][0], cc[1] - cams[i][1], cc[2] - cams[i][2])).toBeLessThan(0.015 * d);
    });
  });

  it('prints its code on the PDF', () => {
    const ops = matDrawing(mat, { title: 't', scale: 's', place: 'p', code: `codice ${uniqueCode(ids)}` });
    expect(ops.some((op) => op.kind === 'text' && op.body === `codice ${uniqueCode(ids)}`)).toBe(true);
    expect(matPdf(matId, 'it', ids).length).toBeGreaterThan(1000);
  });
});

it('a unique mat with unread markers draws them as black squares', () => {
  const base = matById('round');
  const mat = uniqueMat(base, [UNIQUE_FIRST]);
  expect(mat.markers[0].id).toBe(UNIQUE_FIRST);
  expect(mat.markers[1].id).toBe(-1);
  expect(() => matDrawing(mat, { title: 't', scale: 's', place: 'p' })).not.toThrow();
  expect(mat.key).not.toBe(uniqueMat(base, [UNIQUE_FIRST + 20]).key);
});
