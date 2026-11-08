import { FRAMES } from './core/frame';
import { framePdf, framePdfName } from './core/pdf';
import { MATS } from './scan3d/mat';
import { matPdf, matPdfName } from './scan3d/pdf';

export interface Printable { name: string; data: Uint8Array }

/** Every printable PDF (2D frames and 3D mats, in English and Italian), as the app makes them. */
export function printables(): Printable[] {
  const out: Printable[] = [];
  for (const lang of ['en', 'it'] as const) {
    for (const frame of FRAMES) out.push({ name: framePdfName(frame, lang), data: framePdf(frame, lang) });
    for (const { id } of MATS) out.push({ name: matPdfName(id, lang), data: matPdf(id, lang) });
  }
  return out;
}
