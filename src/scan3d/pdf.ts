import { drawingPdf } from '../core/pdf';
import type { Lang } from '../i18n';
import { translator3d } from './i18n';
import { uniqueCode } from '../core/markers';
import { matById, matDrawing, uniqueMat, type MatId } from './mat';

const TITLE = { rect: 'mat.rect', round: 'mat.round', 'round-a3': 'mat.round-a3', 'round-small': 'mat.round-small' } as const;

/** `ids`: unique marker ids, one per position, instead of the mat's fixed ones. */
export function matPdf(id: MatId, lang: Lang, ids?: readonly number[]): Uint8Array {
  const t = translator3d(lang);
  const mat = ids ? uniqueMat(matById(id), ids) : matById(id);
  const labels = {
    title: `ShapesCraft 3D · ${t(TITLE[id])}`,
    scale: t('pdf.scale'),
    place: t('pdf.place'),
    cut: t('pdf.cut'),
    code: ids ? t('pdf.unique', { code: uniqueCode(ids) }) : undefined,
    codeOnly: ids ? uniqueCode(ids) : undefined,
  };
  return drawingPdf(matDrawing(mat, labels), mat.width, mat.height);
}

const NAME: Record<MatId, Record<Lang, string>> = {
  rect: { it: 'tappetino-3d-shapescraft-a4', en: 'mat-3d-shapescraft-a4' },
  round: { it: 'tappetino-3d-tondo-shapescraft-a4', en: 'mat-3d-round-shapescraft-a4' },
  'round-a3': { it: 'tappetino-3d-tondo-shapescraft-a3', en: 'mat-3d-round-shapescraft-a3' },
  'round-small': { it: 'tappetino-3d-tondo-piccolo-shapescraft', en: 'mat-3d-round-small-shapescraft' },
};

export function matPdfName(id: MatId, lang: Lang, code?: string): string {
  return `${NAME[id][lang]}${code ? `-${code}` : ''}.pdf`;
}
