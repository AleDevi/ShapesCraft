import { drawingPdf } from '../core/pdf';
import type { Lang } from '../i18n';
import { translator3d } from './i18n';
import { matById, matDrawing, type MatId } from './mat';

export function matPdf(id: MatId, lang: Lang): Uint8Array {
  const t = translator3d(lang);
  const mat = matById(id);
  const labels = {
    title: t(id === 'round' ? 'pdf.title.round' : 'pdf.title'),
    scale: t('pdf.scale'),
    place: t('pdf.place'),
    cut: t('pdf.cut'),
  };
  return drawingPdf(matDrawing(mat, labels), mat.width, mat.height);
}

export function matPdfName(id: MatId, lang: Lang): string {
  const shape = id === 'round' ? (lang === 'it' ? 'tondo-' : 'round-') : '';
  return `${lang === 'it' ? 'tappetino' : 'mat'}-3d-${shape}shapescraft-a4.pdf`;
}
