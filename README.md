# ShapesCraft

Web app (PWA) che trasforma la foto di un disegno o di un oggetto appoggiato su una cornice stampata in un vettoriale SVG in scala reale, pronto per laser, CNC o plotter da taglio.

## Come si usa

1. Scegli il formato (A3 o A2) e apri la cornice da stampare. Stampala al 100%: la linea di riferimento in basso deve misurare 100 mm.
2. Disegna (pennarello scuro) o appoggia l'oggetto dentro i quattro marker.
3. Scatta la foto inquadrando tutto il foglio. L'app trova i marker, raddrizza la prospettiva e traccia i contorni.
4. Regola soglia, precisione e rumore, poi scarica l'SVG (unità in millimetri).

## Come funziona

- **Marker**: quattro ArUco `ARUCO_MIP_36h12` (id 0–3) rilevati con [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (incluso in `src/vendor`), poi raffinati al sub-pixel adattando una retta su ogni lato.
- **Prospettiva**: omografia ai minimi quadrati sui 16 angoli dei marker; l'area di lavoro viene ricampionata a 5 px/mm.
- **Luce**: lo sfondo della carta viene stimato con una superficie quadratica e rimosso, poi soglia automatica (Otsu).
- **Vettorializzazione**: marching squares con interpolazione sub-pixel, semplificazione Douglas–Peucker, angoli vivi preservati e curve di Bézier sul resto.

Tutto gira nel browser, nessun server.

## Sviluppo

```bash
npm install
npm run dev     # server locale, raggiungibile anche dal telefono nella stessa rete
npm test        # test su foto sintetiche in prospettiva
npm run build
```

La fotocamera del telefono richiede HTTPS: il workflow `.github/workflows/pages.yml` pubblica l'app su GitHub Pages a ogni push su `main` (in Settings → Pages scegli "GitHub Actions" come sorgente).

## Limiti noti

- Gli oggetti 3D proiettano ombre e il loro bordo superiore risulta più grande per la prospettiva: meglio luce dall'alto e oggetti bassi.
- I tratti di penna diventano contorni chiusi (doppia linea), non linee singole.
