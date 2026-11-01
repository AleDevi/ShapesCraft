import { describe, expect, it } from 'vitest';
import { exportSvg } from '../src/core/svg';
import type { PathShape } from '../src/core/trace';

// The exported SVG is opened by other programs and browsers, so it must stay inert:
// only svg, g and path elements, and path data made of numbers and commands.
describe('exported SVG is inert', () => {
  const square: PathShape = {
    start: { x: 0, y: 0 },
    segments: [
      { kind: 'L', to: { x: 10, y: 0 } },
      { kind: 'C', c1: { x: 12, y: 2 }, c2: { x: 12, y: 8 }, to: { x: 10, y: 10 } },
      { kind: 'L', to: { x: 0, y: 10 } },
    ],
    closed: true,
  };
  const poly = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }];

  it('contains no scripts, links, styles or event handlers', () => {
    const svg = exportSvg([square], [poly]);
    expect(svg).not.toMatch(/<script|<style|<foreignObject|<a\b|href|\bon\w+=|javascript:/i);
    for (const tag of svg.match(/<\/?([a-zA-Z]+)/g) ?? []) expect(['<svg', '<g', '<path', '</g', '</svg']).toContain(tag);
  });

  it('path data can never break out of its attribute, even for broken coordinates', () => {
    const bad: PathShape = { start: { x: NaN, y: Infinity }, segments: [{ kind: 'L', to: { x: -1e21, y: 3 } }], closed: false };
    const svg = exportSvg([square, bad], [poly]);
    const ds = [...svg.matchAll(/<path d="([^"]*)"\/>/g)].map((m) => m[1]);
    expect(ds).toHaveLength(2);
    for (const d of ds) expect(d).toMatch(/^[MLCZ0-9eE.+\- NaIfinty]*$/);
  });
});
