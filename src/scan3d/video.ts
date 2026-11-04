import { toGray, type Gray, type Rgba } from '../core/image';

/** Longest side of the quick preview used to compare sharpness between nearby frames. */
const SHARPNESS_SIDE = 480;

/** Longest side of the colour copy kept of each frame, for the 3D model. */
export const COLOR_SIDE = 720;

/** `photo`: full size, grey, to find the markers; `color`: a small colour copy, to find the object. */
export interface VideoFrame { time: number; photo: Gray; color: Rgba }

/** A small colour copy of an image or video frame. */
export function colorCopy(source: CanvasImageSource, w: number, h: number): Rgba {
  const k = Math.min(1, COLOR_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * Picks the sharpest frames of a video, evenly spread over its length: the video
 * is cut into `count` windows and, in each one, `perWindow` moments are compared
 * by sharpness so that motion blur from walking around is avoided.
 * `onFrame` gets each chosen frame as soon as it is read, so detection can run
 * while the rest of the video is still being scanned.
 */
export async function sharpestFrames(
  file: Blob,
  count: number,
  perWindow: number,
  onFrame: (frame: VideoFrame, index: number) => Promise<void> | void,
  onProgress: (done: number) => void,
): Promise<number> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video'));
    });
    // Some mobile browsers only decode frames after playback has started once.
    try {
      await video.play();
      video.pause();
    } catch {
      // Autoplay refused: seeking still works on most browsers.
    }
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth) throw new Error('video');
    const w = video.videoWidth;
    const h = video.videoHeight;
    const full = document.createElement('canvas');
    full.width = w;
    full.height = h;
    const fctx = full.getContext('2d', { willReadFrequently: true })!;
    const k = Math.min(1, SHARPNESS_SIDE / Math.max(w, h));
    const small = document.createElement('canvas');
    small.width = Math.round(w * k);
    small.height = Math.round(h * k);
    const sctx = small.getContext('2d', { willReadFrequently: true })!;

    const windows = Math.max(1, Math.min(count, Math.floor(duration * 4)));
    for (let i = 0; i < windows; i++) {
      let best = { time: 0, score: -1 };
      for (let j = 0; j < perWindow; j++) {
        // Stay clear of the very first and last instants, often shaky or black.
        const time = Math.min(duration - 0.05, ((i + (j + 0.5) / perWindow) / windows) * duration);
        await seek(video, time);
        sctx.drawImage(video, 0, 0, small.width, small.height);
        const score = sharpness(toGray(sctx.getImageData(0, 0, small.width, small.height)));
        if (score > best.score) best = { time, score };
      }
      await seek(video, best.time);
      fctx.drawImage(video, 0, 0, w, h);
      await onFrame({ time: best.time, photo: toGray(fctx.getImageData(0, 0, w, h)), color: colorCopy(full, w, h) }, i);
      onProgress((i + 1) / windows);
    }
    return windows;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      // Wait until the frame at the new time is actually on screen, where supported.
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (v.requestVideoFrameCallback) {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        v.requestVideoFrameCallback(finish);
        // A paused video may never present a new frame: don't wait for it forever.
        setTimeout(finish, 120);
      } else resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

/** Mean squared gradient (Tenengrad): higher for sharper images. */
export function sharpness(g: Gray): number {
  const { width: w, height: h, data } = g;
  let sum = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + w] - data[i - w];
      sum += gx * gx + gy * gy;
    }
  return sum / ((w - 2) * (h - 2));
}
