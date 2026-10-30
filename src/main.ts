import './style.css';
import { FRAMES, frameById, frameSvg } from './core/frame';
import { grayToRgba, toGray } from './core/image';
import {
  DEFAULT_TRACE,
  detectFrame,
  prepare,
  rectify,
  trace,
  type Detection,
  type Prepared,
  type Rectified,
  type TraceOptions,
  type Traced,
} from './core/pipeline';
import { boundingBox, exportSvg, pathData } from './core/svg';

/** Resolution of the straightened image: 0.2 mm per pixel. */
const PX_PER_MM = 5;
/** Photos are downscaled to this longest side to keep memory in check on phones. */
const MAX_PHOTO_SIDE = 4000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const frameSelect = $<HTMLSelectElement>('frame');
const status = $<HTMLParagraphElement>('status');
const result = $<HTMLElement>('result');
const preview = $<HTMLDivElement>('preview');
const summary = $<HTMLParagraphElement>('summary');

const controls = {
  threshold: $<HTMLInputElement>('threshold'),
  tolerance: $<HTMLInputElement>('tolerance'),
  minarea: $<HTMLInputElement>('minarea'),
  blur: $<HTMLInputElement>('blur'),
  invert: $<HTMLInputElement>('invert'),
  showPhoto: $<HTMLInputElement>('show-photo'),
};

interface Session {
  rectified: Rectified;
  prepared: Prepared;
  detection: Detection;
  photoUrl: string;
  traced?: Traced;
}
let session: Session | null = null;

for (const f of FRAMES) frameSelect.add(new Option(f.name, f.id));
frameSelect.value = localStorageGet('frame') ?? 'a3';
frameSelect.addEventListener('change', () => localStorageSet('frame', frameSelect.value));

controls.tolerance.value = String(DEFAULT_TRACE.toleranceMm);
controls.minarea.value = String(DEFAULT_TRACE.minAreaMm2);
controls.blur.value = String(DEFAULT_TRACE.blurMm);
controls.invert.checked = DEFAULT_TRACE.invert;

$('print-frame').addEventListener('click', () => {
  const frame = frameById(frameSelect.value);
  const blob = new Blob([frameSvg(frame)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  // Opening the SVG on its own lets the browser print it at its real size in mm.
  if (!window.open(url, '_blank')) download(blob, `cornice-shapescraft-${frame.id}.svg`);
});

for (const id of ['camera', 'upload']) {
  $<HTMLInputElement>(id).addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await processPhoto(file);
  });
}

let pending = 0;
for (const el of [controls.threshold, controls.tolerance, controls.minarea, controls.blur, controls.invert]) {
  el.addEventListener('input', () => {
    updateOutputs();
    // Coalesce slider drags into one re-trace per frame.
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(retrace);
  });
}
controls.showPhoto.addEventListener('change', render);
$('threshold-auto').addEventListener('click', () => {
  if (!session) return;
  controls.threshold.value = session.prepared.autoThreshold.toFixed(2);
  updateOutputs();
  retrace();
});

$('download').addEventListener('click', () => {
  if (!session?.traced) return;
  const svg = exportSvg(session.traced.shapes, session.traced.polygons);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  download(new Blob([svg], { type: 'image/svg+xml' }), `shapescraft-${stamp}.svg`);
});

updateOutputs();

async function processPhoto(file: File) {
  const frame = frameById(frameSelect.value);
  try {
    setStatus('Carico la foto…');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const photo = toGray(ctx.getImageData(0, 0, w, h));

    setStatus('Cerco la cornice…');
    await nextFrame();
    const detection = detectFrame(photo, frame);

    setStatus('Raddrizzo la prospettiva…');
    await nextFrame();
    const rectified = rectify(photo, frame, detection, PX_PER_MM);
    const prepared = prepare(rectified);

    if (session) URL.revokeObjectURL(session.photoUrl);
    session = { rectified, prepared, detection, photoUrl: await grayUrl(rectified) };
    controls.threshold.value = prepared.autoThreshold.toFixed(2);
    updateOutputs();
    result.hidden = false;
    retrace();
    const missing = 4 - detection.markerIds.length;
    setStatus(
      missing
        ? `Cornice trovata con ${detection.markerIds.length} marker su 4: la scala potrebbe essere meno precisa.`
        : 'Cornice trovata.',
    );
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function options(): TraceOptions {
  return {
    ...DEFAULT_TRACE,
    threshold: Number(controls.threshold.value),
    toleranceMm: Number(controls.tolerance.value),
    minAreaMm2: Number(controls.minarea.value),
    blurMm: Number(controls.blur.value),
    invert: controls.invert.checked,
  };
}

function retrace() {
  if (!session) return;
  session.traced = trace(session.prepared, session.rectified, options());
  render();
}

function render() {
  if (!session?.traced) return;
  const r = session.rectified;
  const area = { x: r.origin.x, y: r.origin.y, w: r.gray.width / r.pxPerMm, h: r.gray.height / r.pxPerMm };
  const { shapes, polygons } = session.traced;
  const paths = shapes.map((s) => `<path d="${pathData(s)}"/>`).join('');
  const image = controls.showPhoto.checked
    ? `<image href="${session.photoUrl}" x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}" opacity="0.55"/>`
    : '';
  preview.innerHTML =
    `<svg viewBox="${area.x} ${area.y} ${area.w} ${area.h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}" fill="#fff"/>${image}` +
    `<g fill="rgba(31,111,235,0.12)" fill-rule="evenodd" stroke="#1f6feb" stroke-width="0.6" vector-effect="non-scaling-stroke">` +
    `<path d="${shapes.map((s) => pathData(s)).join(' ')}" stroke="none"/>${paths}</g></svg>`;

  if (!polygons.length) {
    summary.textContent = 'Nessuna forma trovata: prova ad alzare la soglia.';
    return;
  }
  const box = boundingBox(polygons);
  summary.textContent =
    `${polygons.length} ${polygons.length === 1 ? 'forma' : 'forme'} · ` +
    `${(box.maxX - box.minX).toFixed(1)} × ${(box.maxY - box.minY).toFixed(1)} mm`;
}

function updateOutputs() {
  $<HTMLOutputElement>('threshold-out').value = Number(controls.threshold.value || 0).toFixed(2);
  $<HTMLOutputElement>('tolerance-out').value = `${controls.tolerance.value} mm`;
  $<HTMLOutputElement>('minarea-out').value = `${controls.minarea.value} mm²`;
  $<HTMLOutputElement>('blur-out').value = `${controls.blur.value} mm`;
}

async function grayUrl(r: Rectified): Promise<string> {
  const { width, height } = r.gray;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  img.data.set(grayToRgba(r.gray).data);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.85));
  return URL.createObjectURL(blob);
}

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function nextFrame() {
  return new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(`shapescraft.${key}`);
  } catch {
    return null;
  }
}

function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(`shapescraft.${key}`, value);
  } catch {
    // Storage may be unavailable (private mode); the preference just isn't remembered.
  }
}
