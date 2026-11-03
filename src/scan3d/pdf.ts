import { drawingPdf } from '../core/pdf';
import type { Lang } from '../i18n';
import { translator3d } from './i18n';
import { MAT, matDrawing } from './mat';

export function matPdf(lang: Lang): Uint8Array {
  const t = translator3d(lang);
  return drawingPdf(matDrawing({ title: t('pdf.title'), scale: t('pdf.scale'), place: t('pdf.place') }), MAT.width, MAT.height);
}

export function matPdfName(lang: Lang): string {
  return `${lang === 'it' ? 'tappetino' : 'mat'}-3d-shapescraft-a4.pdf`;
}
