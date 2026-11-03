import { drawingPdf } from '../core/pdf';
import type { Lang } from '../i18n';
import { translator3d } from './i18n';
import { matById, matDrawing, type MatId } from './mat';

const TITLE = { rect: 'mat.rect', round: 'mat.round', 'round-a3': 'mat.round-a3', 'round-small': 'mat.round-small' } as const;

export function matPdf(id: MatId, lang: Lang): Uint8Array {
  const t = translator3d(lang);
  const mat = matById(id);
  const labels = {
    title: `ShapesCraft 3D · ${t(TITLE[id])}`,
    scale: t('pdf.scale'),
    place: t('pdf.place'),
    cut: t('pdf.cut'),
  };
  return drawingPdf(matDrawing(mat, labels), mat.width, mat.height);
}

const NAME: Record<MatId, Record<Lang, string>> = {
  rect: { it: 'tappetino-3d-shapescraft-a4', en: 'mat-3d-shapescraft-a4' },
  round: { it: 'tappetino-3d-tondo-shapescraft-a4', en: 'mat-3d-round-shapescraft-a4' },
  'round-a3': { it: 'tappetino-3d-tondo-shapescraft-a3', en: 'mat-3d-round-shapescraft-a3' },
  'round-small': { it: 'tappetino-3d-tondo-piccolo-shapescraft', en: 'mat-3d-round-small-shapescraft' },
};

export function matPdfName(id: MatId, lang: Lang): string {
  return `${NAME[id][lang]}.pdf`;
}
