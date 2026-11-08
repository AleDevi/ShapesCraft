import { frameDrawing, type FrameLayout, type FrameOp } from './frame';
import type { Lang } from '../i18n';

const PT_PER_MM = 72 / 25.4;

/** Helvetica advance widths (1/1000 em) for ASCII 32..126, from the standard AFM. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

function charWidth(code: number): number {
  if (code >= 32 && code <= 126) return HELVETICA[code - 32];
  if (code === 0xb7) return 278; // middle dot
  return 556; // accented vowels (à è é ì ò ù) share their base letter's width
}

/** Encodes text as a PDF string in WinAnsi, which covers the Latin-1 letters used here. */
function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code > 0xff) out += '?';
    else if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.charCodeAt(0));
  return (w / 1000) * size;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * The printable frame as a one-page vector PDF at real size. PDFs print at
 * 100% more reliably than SVGs and can be shared from a phone to any printer.
 */
export function framePdf(f: FrameLayout, lang: Lang = 'en', ids?: readonly number[]): Uint8Array {
  const paper = f.paper ?? { width: f.width, height: f.height };
  const offset = { x: (paper.width - f.width) / 2, y: (paper.height - f.height) / 2 };
  return drawingPdf(frameDrawing(f, lang, ids), paper.width, paper.height, offset);
}

/**
 * Any printable drawing as a one-page vector PDF, with a page of `width` × `height` mm.
 * `offset` shifts the drawing on the page, to centre a small drawing on a standard sheet.
 */
export function drawingPdf(ops: FrameOp[], width: number, height: number, offset = { x: 0, y: 0 }): Uint8Array {
  // Draw in millimetres with the origin at the top-left, like the SVG.
  const content: string[] = [pdfMmTransform(height)];
  if (offset.x || offset.y) content.push(`1 0 0 1 ${n(offset.x)} ${n(offset.y)} cm`);
  for (const op of ops) {
    switch (op.kind) {
      case 'fill':
        content.push(`${n(op.gray)} g`);
        for (const r of op.rects) content.push(`${n(r.x)} ${n(r.y)} ${n(r.w)} ${n(r.h)} re`);
        content.push(op.evenOdd ? 'f*' : 'f');
        break;
      case 'line':
        content.push(`0 G ${n(op.width)} w ${n(op.x1)} ${n(op.y1)} m ${n(op.x2)} ${n(op.y2)} l S`);
        break;
      case 'outline':
        content.push(`0 G ${n(op.width)} w ${n(op.rect.x)} ${n(op.rect.y)} ${n(op.rect.w)} ${n(op.rect.h)} re S`);
        break;
      case 'poly':
        content.push(`${n(op.gray)} g ${op.points.map((p, i) => `${n(p.x)} ${n(p.y)} ${i ? 'l' : 'm'}`).join(' ')} h f`);
        break;
      case 'text': {
        const x = op.x - textWidth(op.body, op.size) / 2;
        // The page is flipped, so the text matrix flips the glyphs back upright.
        content.push(`0 g BT /F1 ${n(op.size)} Tf 1 0 0 -1 ${n(x)} ${n(op.y)} Tm ${pdfString(op.body)} Tj ET`);
        break;
      }
    }
  }
  return pdfDocument(width, height, content.join('\n'), true);
}

/**
 * A one-page PDF of `widthMm` × `heightMm`. Everything in `stream` must be ASCII,
 * so string offsets are byte offsets. `font` adds Helvetica as /F1.
 */
export function pdfDocument(widthMm: number, heightMm: number, stream: string, font = false): Uint8Array {
  const w = n(widthMm * PT_PER_MM);
  const h = n(heightMm * PT_PER_MM);
  const resources = font ? '/Resources << /Font << /F1 5 0 R >> >> ' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ${resources}/Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  if (font) objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** Millimetres to points, flipping y so drawing commands use the SVG's top-left origin. */
export function pdfMmTransform(heightMm: number): string {
  return `${n(PT_PER_MM)} 0 0 ${n(-PT_PER_MM)} 0 ${n(heightMm * PT_PER_MM)} cm`;
}

/** File name of the frame PDF, in the language of its text. */
export function framePdfName(f: FrameLayout, lang: Lang, code?: string): string {
  return `${lang === 'it' ? 'cornice' : 'frame'}-shapescraft-${f.id}${code ? `-${code}` : ''}.pdf`;
}
