import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { printables } from '../src/printables';

const dir = new URL('../frames/', import.meta.url);

// The PDFs in frames/ are linked from the README for download without the app: they must match it.
describe('frames/ in the repository', () => {
  it('holds exactly the PDFs the app makes', () => {
    const committed = readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();
    expect(committed).toEqual(printables().map((p) => p.name).sort());
  });

  it.each(printables().map((p) => [p.name, p.data] as const))('%s is up to date (run `npm run frames`)', (name, data) => {
    expect(new Uint8Array(readFileSync(new URL(name, dir)))).toEqual(data);
  });
});
