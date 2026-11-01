import { defineConfig, type Plugin } from 'vite';
import { FRAMES } from './src/core/frame';
import { framePdf, framePdfName } from './src/core/pdf';

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
});
