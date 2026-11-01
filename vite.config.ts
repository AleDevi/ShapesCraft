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

// `base` is relative so the build works both locally and on GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [framePdfs()],
});
