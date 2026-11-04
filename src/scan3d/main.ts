import '../style.css';
import './scan3d.css';
import { registerServiceWorker, setupInstall } from '../pwa';
import { defaultLang, type Lang } from '../i18n';
import { toGray } from '../core/image';
import { translator3d, type Translate3d } from './i18n';
import { matPdf, matPdfName } from './pdf';
import { MatNotFoundError, detectMat, solveSession, type MatDetection, type SolvedSession } from './pose';
import { MATS, matById, type MatId } from './mat';
import { FAIR_MM, GOOD_MM, SceneView, drawCoverage, quality, type Colors } from './view';
import { colorCopy, sharpestFrames } from './video';
import { carve, measure } from './carve';
import { stl, surface, type Mesh } from './mesh';
import { MeshView } from './meshview';
import type { Rgba } from '../core/image';

/** Frames taken from a video: one per window, the sharpest of a few candidates. */
const VIDEO_FRAMES = 40;
const VIDEO_CANDIDATES = 3;

/** Photos are downscaled to this longest side to keep memory in check on phones. */
const MAX_PHOTO_SIDE = 4000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Shot { name: string; det: MatDetection; color: Rgba }
let shots: Shot[] = [];
let solved: SolvedSession | null = null;
let model: { mesh: Mesh; size: NonNullable<ReturnType<typeof measure>> } | null = null;
let modelEmpty = false;

/** Above this many triangles the preview uses a coarser copy of the model, to stay smooth on phones. */
const PREVIEW_TRIANGLES = 40000;

const langSelect = $<HTMLSelectElement>('lang');
const savedLang = storageGet('lang');
let lang: Lang = savedLang === 'it' || savedLang === 'en' ? savedLang : defaultLang(navigator.languages ?? [navigator.language]);
let t: Translate3d = translator3d(lang);
let statusMessage: (() => string) | null = null;
const errors: (() => string)[] = [];
langSelect.value = lang;
langSelect.addEventListener('change', () => {
  lang = langSelect.value as Lang;
  storageSet('lang', lang);
  applyLang();
});

const scene = new SceneView($<HTMLCanvasElement>('scene'), colors);
const modelView = new MeshView($<HTMLCanvasElement>('model-view'), () => ({ fill: colors().accent, edge: colors().border }));
applyLang();

const matRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="mat"]')];
const savedMat = storageGet('mat3d');
for (const r of matRadios) {
  r.checked = r.value === (MATS.some((m) => m.id === savedMat) ? savedMat : 'rect');
  r.addEventListener('change', () => {
    storageSet('mat3d', selectedMat());
    $('round-hint').hidden = selectedMat() === 'rect';
  });
}
$('round-hint').hidden = selectedMat() === 'rect';

function selectedMat(): MatId {
  const v = matRadios.find((r) => r.checked)?.value;
  return MATS.find((m) => m.id === v)?.id ?? 'rect';
}

function matFile(): File {
  const mat = selectedMat();
  return new File([matPdf(mat, lang) as BlobPart], matPdfName(mat, lang), { type: 'application/pdf' });
}
const shareButton = $<HTMLButtonElement>('share-mat');
shareButton.hidden = !navigator.canShare?.({ files: [matFile()] });
$('download-mat').classList.toggle('secondary', !shareButton.hidden);
shareButton.addEventListener('click', async () => {
  const file = matFile();
  try {
    await navigator.share({ files: [file], title: 'ShapesCraft 3D' });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') await download(file, file.name);
  }
});
$('download-mat').addEventListener('click', () => {
  const file = matFile();
  void download(file, file.name);
});

const upload = $<HTMLInputElement>('upload');
upload.addEventListener('change', () => {
  const files = [...(upload.files ?? [])];
  upload.value = '';
  if (files.length) void addPhotos(files);
});
for (const id of ['video-camera', 'video-upload']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void readVideo(file);
  });
}

let busy = false;
function setBusy(on: boolean) {
  busy = on;
  for (const id of ['video-camera', 'video-upload', 'upload']) $<HTMLInputElement>(id).disabled = on;
  for (const id of ['build-model', 'clear']) $<HTMLButtonElement>(id).disabled = on;
  $('progress').hidden = !on;
}

/** A video is a whole scan: it replaces what was there. */
async function readVideo(file: File) {
  if (busy) return;
  setBusy(true);
  shots = [];
  solved = null;
  resetModel();
  errors.length = 0;
  render();
  const progress = $<HTMLProgressElement>('progress');
  let missing = 0;
  let frame2d = false;
  try {
    setStatus(() => t('status.video', { pct: 0 }));
    const total = await sharpestFrames(
      file,
      VIDEO_FRAMES,
      VIDEO_CANDIDATES,
      async ({ time, photo, color }) => {
        try {
          shots.push({ name: `${time.toFixed(1)} s`, det: detectMat(photo), color });
        } catch (err) {
          missing++;
          if (err instanceof MatNotFoundError && err.frame2d) frame2d = true;
        }
        await nextFrame();
      },
      (done) => {
        progress.value = done;
        setStatus(() => t('status.video', { pct: Math.round(done * 100) }));
      },
    );
    if (frame2d && shots.length < 4) errors.push(() => t('status.frame2d'));
    if (missing) errors.push(() => t('status.videoFrames', { missing, total }));
  } catch {
    errors.push(() => t('status.videoFailed'));
  }
  await solveAndRender();
  setBusy(false);
}

$('clear').addEventListener('click', () => {
  shots = [];
  solved = null;
  resetModel();
  errors.length = 0;
  setStatus(null);
  render();
});

$('json').addEventListener('click', () => {
  if (!solved) return;
  const data = {
    app: 'ShapesCraft 3D',
    focal: solved.focal,
    focalFromData: solved.focalFromData,
    photos: solved.photos.map((p, i) => ({
      name: shots[i].name,
      size: [shots[i].det.width, shots[i].det.height],
      markers: shots[i].det.markerIds,
      R: p.pose.R,
      t: p.pose.t,
      rmsPx: p.rmsPx,
      meanMm: p.meanMm,
      heightMm: p.heightMm,
      distanceMm: p.distanceMm,
      elevationDeg: p.elevationDeg,
      azimuthDeg: p.azimuthDeg,
    })),
  };
  void download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), 'shapescraft-3d-poses.json');
});

$('build-model').addEventListener('click', () => void buildModel());
$('stl').addEventListener('click', () => {
  if (model) void download(new Blob([stl(model.mesh)], { type: 'model/stl' }), 'shapescraft-3d.stl');
});

function resetModel() {
  model = null;
  modelEmpty = false;
}

async function buildModel() {
  if (busy || !solved || !shots.length) return;
  setBusy(true);
  resetModel();
  render();
  const progress = $<HTMLProgressElement>('progress-model');
  progress.hidden = false;
  try {
    const mat = matById(shots[0].det.matId);
    const views = shots.map((s, i) => ({
      image: s.color,
      pose: solved!.photos[i].pose,
      focal: solved!.focal * Math.max(s.color.width, s.color.height),
    }));
    const volume = await carve(mat, views, async (done) => {
      progress.value = done;
      setStatus(() => t('model.building', { pct: Math.round(done * 100) }));
      await nextFrame();
    });
    const size = measure(volume);
    if (size) {
      const mesh = surface(volume, mat.center);
      model = { mesh, size };
      modelView.set(mesh.triangles.length / 3 > PREVIEW_TRIANGLES ? surface(volume, mat.center, 2) : mesh);
    } else modelEmpty = true;
    setStatus(null);
  } finally {
    progress.hidden = true;
    setBusy(false);
    render();
  }
}

window.addEventListener('resize', () => render());
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => render());

async function addPhotos(files: File[]) {
  if (busy) return;
  setBusy(true);
  try {
    await readPhotos(files);
  } finally {
    setBusy(false);
  }
}

async function readPhotos(files: File[]) {
  for (let i = 0; i < files.length; i++) {
    setStatus(() => t('status.reading', { n: i + 1, total: files.length }));
    await nextFrame();
    const file = files[i];
    const name = file.name || `foto ${shots.length + 1}`;
    try {
      const bitmap = await createImageBitmap(file);
      const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * k);
      const h = Math.round(bitmap.height * k);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      shots.push({ name, det: detectMat(toGray(ctx.getImageData(0, 0, w, h))), color: colorCopy(canvas, w, h) });
    } catch (err) {
      const found = err instanceof MatNotFoundError ? err.markersFound : 0;
      errors.push(() => (err instanceof MatNotFoundError && err.frame2d ? `${name}: ${t('status.frame2d')}` : t('status.notFound', { name, found })));
    }
  }
  await solveAndRender();
}

async function solveAndRender() {
  resetModel();
  setStatus(() => t('status.solving'));
  await nextFrame();
  // Only the mat seen in most views counts: a stray view of the other mat is left out.
  const counts = new Map<MatId, number>();
  for (const s of shots) counts.set(s.det.matId, (counts.get(s.det.matId) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  shots = shots.filter((s) => s.det.matId === main);
  solved = shots.length ? solveSession(shots.map((s) => s.det)) : null;
  setStatus(solved ? () => t('status.done', { count: shots.length }) : null);
  render();
}

function render() {
  const list = $('errors');
  list.replaceChildren(...errors.map((e) => Object.assign(document.createElement('li'), { textContent: e() })));
  const result = $('result');
  result.hidden = !solved;
  $('model').hidden = !solved;
  if (!solved) return;
  $('model-result').hidden = !model;
  $('model-empty').hidden = !modelEmpty;
  if (model) {
    const s = model.size;
    $('model-size').textContent = t('model.size', {
      w: Math.round(s.width), d: Math.round(s.depth), h: Math.round(s.height), ml: Math.round(s.volumeMl),
    });
    modelView.draw();
  }
  const photos = solved.photos;
  const mean = (f: (p: (typeof photos)[number]) => number) => photos.reduce((s, p) => s + f(p), 0) / photos.length;
  const meanMm = mean((p) => p.meanMm);
  const verdict = meanMm < GOOD_MM ? 'good' : meanMm < FAIR_MM ? 'fair' : 'poor';
  const v = $('verdict');
  v.className = `verdict ${verdict}`;
  v.textContent = t(`result.${verdict}`);
  $('summary').textContent = t('result.summary', {
    px: mean((p) => p.rmsPx).toFixed(2),
    mm: meanMm.toFixed(2),
    focal: solved.focal.toFixed(3),
    source: t(solved.focalFromData ? 'result.focal.data' : 'result.focal.default'),
  });

  const d0 = shots[0].det;
  scene.set(matById(d0.matId), photos, { width: d0.width, height: d0.height, focal: solved.focal });
  drawCoverage($<HTMLCanvasElement>('coverage'), photos, colors());

  const table = $<HTMLTableElement>('table');
  const head = ['table.photo', 'table.markers', 'table.height', 'table.distance', 'table.elevation', 'table.azimuth', 'table.error'] as const;
  const row = (cells: string[], tag: 'td' | 'th') => {
    const tr = document.createElement('tr');
    for (const c of cells) tr.append(Object.assign(document.createElement(tag), { textContent: c }));
    return tr;
  };
  const headRow = row(head.map((k) => t(k)), 'th');
  headRow.prepend(document.createElement('th'));
  const rows = photos.map((p, i) => {
    const tr = row([
      String(i + 1),
      String(shots[i].det.markerIds.length),
      `${Math.round(p.heightMm)} mm`,
      `${Math.round(p.distanceMm)} mm`,
      `${Math.round(p.elevationDeg)}°`,
      `${Math.round(p.azimuthDeg)}°`,
      `${p.meanMm.toFixed(2)} mm`,
    ], 'td');
    const dot = document.createElement('td');
    dot.className = 'q';
    const span = document.createElement('span');
    span.style.background = `var(--${quality(p)})`;
    dot.append(span);
    tr.prepend(dot);
    tr.title = shots[i].name;
    return tr;
  });
  table.replaceChildren(headRow, ...rows);
}

function colors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { text: v('--text'), muted: v('--muted'), accent: v('--accent'), border: v('--border'), card: v('--card'), good: v('--good'), fair: v('--fair'), poor: v('--poor') };
}

function setStatus(message: (() => string) | null) {
  statusMessage = message;
  $('status').textContent = message ? message() : '';
}

function applyLang() {
  t = translator3d(lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Parameters<Translate3d>[0]);
  if (statusMessage) setStatus(statusMessage);
  render();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

interface ClaudeHost { use(name: string): Promise<{ save(o: { filename: string; data: Blob }): Promise<void> } | null> }

async function download(blob: Blob, name: string) {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (host) {
    const downloads = await host.use('downloads');
    if (downloads) {
      try {
        await downloads.save({ filename: name, data: blob });
      } catch (err) {
        if ((err as { code?: string }).code !== 'declined') setStatus(() => t('status.saveFailed'));
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

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice just isn't remembered.
  }
}

registerServiceWorker();
setupInstall(document.getElementById('install') as HTMLButtonElement, document.getElementById('install-help')!, (el, key) => {
  el.dataset.i18n = key;
  el.textContent = t(key);
});
