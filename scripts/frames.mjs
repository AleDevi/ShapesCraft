// Writes every printable PDF (2D frames and 3D mats) into frames/, so they can be downloaded
// straight from the repository. Run `npm run frames` after changing a frame or a mat.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const dir = new URL('../frames/', import.meta.url);
const server = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false } });
try {
  const { printables } = await server.ssrLoadModule('/src/printables.ts');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.pdf')) rmSync(new URL(f, dir));
  for (const { name, data } of printables()) writeFileSync(new URL(name, dir), data);
  console.log(`Wrote ${printables().length} PDFs to frames/`);
} finally {
  await server.close();
}
