import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { FRAMES } from './src/core/frame';
import { framePdf, framePdfName } from './src/core/pdf';
import { matPdf, matPdfName } from './src/scan3d/pdf';

/** Publishes every frame PDF next to the app, so a computer can open it by link. */
function framePdfs(): Plugin {
  return {
    name: 'frame-pdfs',
    apply: 'build',
    generateBundle() {
      for (const frame of FRAMES) {
        for (const lang of ['en', 'it'] as const) {
          this.emitFile({ type: 'asset', fileName: `frames/${framePdfName(frame, lang)}`, source: framePdf(frame, lang) });
        }
      }
      for (const lang of ['en', 'it'] as const) {
        for (const mat of ['rect', 'round'] as const) {
          this.emitFile({ type: 'asset', fileName: `frames/${matPdfName(mat, lang)}`, source: matPdf(mat, lang) });
        }
      }
    },
  };
}

/**
 * Content Security Policy for the published site. GitHub Pages cannot send headers, so it goes in a
 * <meta> tag. Everything runs locally: no remote scripts, no network calls, photos stay on the device.
 * Build only, because the dev server needs inline scripts and a websocket for hot reload.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  // The 3D scan plays the chosen video from a blob: URL to read its frames.
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

// `base` is relative so the build works both locally and on GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [contentSecurityPolicy(), framePdfs()],
  build: {
    rollupOptions: {
      // The 2D tracer and the 3D scan are two pages sharing the same code.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        scan3d: fileURLToPath(new URL('./3d.html', import.meta.url)),
      },
    },
  },
});
