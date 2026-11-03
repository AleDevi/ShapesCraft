# ShapesCraft

**English** · [Italiano](README.it.md)

### 👉 [**Open the app: aledevi.github.io/ShapesCraft**](https://aledevi.github.io/ShapesCraft/)

No install, no sign-up: it runs in the browser on phone, tablet and computer.

A web app (PWA) that turns a photo of a drawing or an object laid on a printed frame into a true-scale SVG vector, ready for a laser cutter, CNC or cutting plotter.

The app is available in English and Italian: it follows the phone's language, and you can switch it from the menu at the top.

## How to use it

1. Open the app and tap Start. Pick the format (A4 or A3) and get the frame as a PDF: share it from the phone (email, chat, Drive, a printer app), download it, or copy its link to open it on a computer. Print it at 100%: the reference line at the bottom must measure 100 mm.
2. For a rigid frame, glue it to card or thin plastic and cut along the black lines (outer edge and central window). Or use the sheet as it is and draw inside the window.
3. Lay the frame over the drawing (dark marker on white paper) or the object, which must sit inside the window.
4. Take the photo with the whole frame in view. The app finds the markers, corrects the perspective and traces the outlines.
5. Adjust threshold, straightening and smoothing, then pick the format and download or share the file: SVG, DXF (R12), PDF at real size or PNG at 300 dpi, all in millimetres.

## How it works

- **Markers**: four ArUco `ARUCO_MIP_36h12` markers (ids 0–3) detected with [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (bundled in `src/vendor`), then refined to sub-pixel accuracy by fitting a line to each side.
- **Perspective**: least-squares homography over the 16 marker corners; the frame window is resampled at 5 px/mm.
- **Lighting**: the paper background is estimated with a quadratic surface and removed, then an automatic threshold (Otsu) is applied.
- **Vectorisation**: marching squares with sub-pixel interpolation, Douglas–Peucker simplification, sharp corners preserved and Bézier curves everywhere else.
- **Single line**: Zhang–Suen thinning of the ink, skeleton split into branches between ends and junctions, spurious branches removed, ends extended by half a stroke; the open paths are exported as unclosed lines in the SVG.

- **Frame PDF**: a small built-in writer turns the same drawing as the SVG frame into a vector PDF (Helvetica, WinAnsi). The build also publishes every frame under `frames/`, so a computer can open it by link.
- **Exports**: SVG and PDF keep the Bézier curves; DXF R12 (one polyline per shape, curves split into pieces within 0.02 mm, y pointing up) for CAD and CNC; PNG drawn on a canvas with its dpi written in a `pHYs` chunk so it opens at real size.

Everything runs in the browser, no server.

## Development

```bash
npm install
npm run dev     # local server, also reachable from a phone on the same network
npm test        # tests on synthetic photos in perspective
npm run build
```

To try it on a phone, run `npm run dev` and open the network address on the same Wi-Fi. Installing it as an app needs HTTPS: the `.github/workflows/pages.yml` workflow publishes the app to GitHub Pages on every push to `main` (in Settings → Pages choose "GitHub Actions" as the source).

## Known limitations

- The thickness of a rigid backing lifts the markers above the drawing: with 2 mm card and the phone at 40 cm the scale error is about 0.5%. Thin backings work best.
- 3D objects cast shadows, and their top edge looks larger because of perspective: light from above and low objects work best.
- In "single line" mode, crossings between thick strokes can shift slightly towards the centre of the ink blob.

## License

ShapesCraft is released under the [GNU AGPL-3.0](LICENSE) license (`AGPL-3.0-only`). Copyright © 2026 Alessandro Devigili.

The code in `src/vendor/js-aruco2/` keeps its original license (MIT, with parts derived from OpenCV under the BSD license): see [`src/vendor/js-aruco2/LICENSE.txt`](src/vendor/js-aruco2/LICENSE.txt).
