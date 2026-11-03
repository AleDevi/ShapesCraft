import { describe, expect, it } from 'vitest';
import { MatNotFoundError, cameraCenter, detectMat, solveSession, type Vec3 } from '../src/scan3d/pose';
import { renderPhoto } from './synthetic';
import { shoot } from './synthetic3d';

describe('3D mat camera poses', () => {
  const W = 1600;
  const H = 1200;
  const focal = 0.75;
  const cams: Vec3[] = [
    [105, 148.5 + 380, -330],
    [105 + 360, 148.5, -300],
    [105 - 250, 148.5 - 250, -380],
    [105 + 200, 148.5 + 300, -220],
  ];
  const photos = cams.map((c) => shoot(c, focal * W, W, H));

  it('recognises the mat markers', () => {
    const d = detectMat(photos[0]);
    expect(d.markerIds.length).toBeGreaterThanOrEqual(15);
    expect(d.markerIds.every((id) => id >= 10 && id < 40)).toBe(true);
  });

  it('recovers the focal length and every camera position within 3 mm', () => {
    const session = solveSession(photos.map(detectMat));
    expect(session.focalFromData).toBe(true);
    expect(Math.abs(session.focal - focal) / focal).toBeLessThan(0.02);
    session.photos.forEach((p, i) => {
      const c = cameraCenter(p.pose);
      const err = Math.hypot(c[0] - cams[i][0], c[1] - cams[i][1], c[2] - cams[i][2]);
      expect(err).toBeLessThan(3);
      expect(p.rmsPx).toBeLessThan(1);
      expect(p.meanMm).toBeLessThan(0.5);
    });
  });
});

describe('wrong sheet', () => {
  it('tells when the 2D frame was printed instead of the 3D mat', () => {
    const { photo } = renderPhoto('a4', () => false, { width: 900, height: 1200 }, [
      { x: 100, y: 120 }, { x: 800, y: 100 }, { x: 820, y: 1100 }, { x: 90, y: 1080 },
    ]);
    let error: unknown;
    try {
      detectMat(photo);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MatNotFoundError);
    expect((error as MatNotFoundError).frame2d).toBe(true);
  });
});
