import './style.css';
import { FRAMES, frameById } from './core/frame';
import { framePdf, framePdfName } from './core/pdf';
import { defaultLang, translator, type Lang, type Translate } from './i18n';
import { grayToRgba, toGray } from './core/image';
import {
  DEFAULT_TRACE,
  FrameNotFoundError,
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
  smooth: $<HTMLInputElement>('smooth'),
  invert: $<HTMLInputElement>('invert'),
  centerline: $<HTMLInputElement>('centerline'),
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

const langSelect = $<HTMLSelectElement>('lang');
const savedLang = localStorageGet('lang');
let lang: Lang = savedLang === 'it' || savedLang === 'en' ? savedLang : defaultLang(navigator.languages ?? [navigator.language]);
let t: Translate = translator(lang);
/** Re-renders the current status line in a new language. */
let statusMessage: (() => string) | null = null;
let statusIsError = false;
langSelect.value = lang;
langSelect.addEventListener('change', () => {
  lang = langSelect.value as Lang;
  localStorageSet('lang', lang);
  applyLang();
});
applyLang();

for (const f of FRAMES) frameSelect.add(new Option(f.name, f.id));
const savedFrame = localStorageGet('frame');
frameSelect.value = FRAMES.some((f) => f.id === savedFrame) ? savedFrame! : 'a4';
frameSelect.addEventListener('change', () => localStorageSet('frame', frameSelect.value));

controls.tolerance.value = String(DEFAULT_TRACE.toleranceMm);
controls.minarea.value = String(DEFAULT_TRACE.minAreaMm2);
controls.smooth.value = String(DEFAULT_TRACE.smoothMm);
controls.invert.checked = DEFAULT_TRACE.invert;
controls.centerline.checked = DEFAULT_TRACE.centerline;

// Welcome page and tool are two views; the hash lets the phone's back button return to the welcome page.
const welcome = $('welcome');
const app = $('app');
const help = $('help');
function showView() {
  const inApp = location.hash === '#app';
  welcome.hidden = inApp;
  app.hidden = !inApp;
  help.hidden = !inApp;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', showView);
$('start').addEventListener('click', () => (location.hash = 'app'));
help.addEventListener('click', () => (location.hash = ''));
showView();

/** Where the published site serves ready-made frame PDFs, so a computer can open them by link. */
const SITE_URL = 'https://aledevi.github.io/ShapesCraft/';
const frameStatus = $<HTMLParagraphElement>('frame-status');
const shareButton = $<HTMLButtonElement>('share-frame');

function frameFile(): File {
  const frame = frameById(frameSelect.value);
  return new File([framePdf(frame, lang) as BlobPart], framePdfName(frame, lang), { type: 'application/pdf' });
}

// Sharing files (email, chat apps, Drive, a printer app) is the easiest way to print from a phone.
shareButton.hidden = !navigator.canShare?.({ files: [frameFile()] });
// Without sharing, downloading becomes the main action.
$('download-frame').classList.toggle('secondary', !shareButton.hidden);
shareButton.addEventListener('click', async () => {
  const file = frameFile();
  try {
    await navigator.share({ files: [file], title: 'ShapesCraft' });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') await download(file, file.name);
  }
});
$('download-frame').addEventListener('click', () => {
  const file = frameFile();
  void download(file, file.name);
});
$('link-frame').addEventListener('click', async () => {
  const url = `${SITE_URL}frames/${framePdfName(frameById(frameSelect.value), lang)}`;
  const link = document.createElement('a');
  link.href = url;
  link.textContent = url;
  link.target = '_blank';
  link.rel = 'noopener';
  // The link is always shown, since clipboard access can be refused (embedded pages, old browsers).
  frameStatus.replaceChildren(t('frame.linkShow', { url: '' }), link);
  try {
    await navigator.clipboard.writeText(url);
    frameStatus.replaceChildren(`${t('frame.linkCopied')} `, link);
  } catch {
    // Keep the visible link.
  }
});
frameSelect.addEventListener('change', () => (frameStatus.textContent = ''));

for (const id of ['camera', 'upload']) {
  $<HTMLInputElement>(id).addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await processPhoto(file);
  });
}

let pending = 0;
for (const el of [controls.threshold, controls.tolerance, controls.minarea, controls.smooth, controls.invert, controls.centerline]) {
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
  void download(new Blob([svg], { type: 'image/svg+xml' }), `shapescraft-${stamp}.svg`);
});

updateOutputs();

async function processPhoto(file: File) {
  const frame = frameById(frameSelect.value);
  try {
    setStatus(() => t('status.loading'));
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

    setStatus(() => t('status.detecting'));
    await nextFrame();
    const detection = detectFrame(photo, frame);

    setStatus(() => t('status.rectifying'));
    await nextFrame();
    const rectified = rectify(photo, frame, detection, PX_PER_MM);
    const prepared = prepare(rectified);

    if (session) URL.revokeObjectURL(session.photoUrl);
    session = { rectified, prepared, detection, photoUrl: await grayUrl(rectified) };
    controls.threshold.value = prepared.autoThreshold.toFixed(2);
    updateOutputs();
    result.hidden = false;
    retrace();
    const found = detection.markerIds.length;
    setStatus(() => (found < 4 ? t('status.partial', { n: found }) : t('status.found')));
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    if (err instanceof FrameNotFoundError) setStatus(() => t('status.notFound', { n: err.markersFound }), true);
    else setStatus(() => (err instanceof Error ? err.message : String(err)), true);
  }
}

function options(): TraceOptions {
  return {
    ...DEFAULT_TRACE,
    threshold: Number(controls.threshold.value),
    toleranceMm: Number(controls.tolerance.value),
    minAreaMm2: Number(controls.minarea.value),
    smoothMm: Number(controls.smooth.value),
    invert: controls.invert.checked,
    centerline: controls.centerline.checked,
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
    // Tint the inside of closed outlines; single lines have no inside.
    `<path d="${shapes.filter((s) => s.closed).map((s) => pathData(s)).join(' ')}" stroke="none"/>${paths}</g></svg>`;

  if (!polygons.length) {
    summary.textContent = t('summary.none');
    return;
  }
  const box = boundingBox(polygons);
  summary.textContent =
    `${polygons.length} ${t(controls.centerline.checked ? (polygons.length === 1 ? 'summary.line' : 'summary.lines') : polygons.length === 1 ? 'summary.shape' : 'summary.shapes')} · ` +
    `${(box.maxX - box.minX).toFixed(1)} × ${(box.maxY - box.minY).toFixed(1)} mm`;
}

function updateOutputs() {
  $<HTMLOutputElement>('threshold-out').value = Number(controls.threshold.value || 0).toFixed(2);
  $<HTMLOutputElement>('tolerance-out').value = `${controls.tolerance.value} mm`;
  $<HTMLOutputElement>('minarea-out').value = `${controls.minarea.value} mm²`;
  $<HTMLOutputElement>('smooth-out').value = Number(controls.smooth.value) ? `${controls.smooth.value} mm` : t('smooth.off');
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

function setStatus(message: () => string, error = false) {
  statusMessage = message;
  statusIsError = error;
  status.textContent = message();
  status.classList.toggle('error', error);
}

function applyLang() {
  t = translator(lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as Parameters<Translate>[0]);
  }
  langSelect.setAttribute('aria-label', t('language'));
  if (statusMessage) setStatus(statusMessage, statusIsError);
  $('frame-status').textContent = '';
  updateOutputs();
  render();
}

function nextFrame() {
  return new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
}

interface DownloadsCapability {
  save(req: { filename: string; data: Blob }): Promise<unknown>;
}
type ClaudeHost = { use(name: 'downloads'): Promise<DownloadsCapability | null> };

/**
 * Saves a file. Inside a claude.ai artifact the sandbox blocks plain downloads,
 * so the viewer's `downloads` capability is used there instead.
 */
async function download(blob: Blob, name: string) {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (host) {
    const downloads = await host.use('downloads');
    if (downloads) {
      try {
        await downloads.save({ filename: name, data: blob });
      } catch (err) {
        if ((err as { code?: string }).code !== 'declined') setStatus(() => t('status.saveFailed'), true);
      }
      return;
    }
  }
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
