# ShapesCraft

Web app (PWA) che trasforma la foto di un disegno o di un oggetto appoggiato su una cornice stampata in un vettoriale SVG in scala reale, pronto per laser, CNC o plotter da taglio.

## Come si usa

1. Scegli il formato (A4 o A3) e apri la cornice da stampare. Stampala al 100%: la linea di riferimento in basso deve misurare 100 mm.
2. Per una cornice rigida incollala su cartoncino o plastica sottile e ritaglia lungo le linee nere (bordo esterno e finestra centrale). In alternativa usa il foglio così com'è e disegna dentro la finestra.
3. Appoggia la cornice sul disegno (pennarello scuro su carta bianca) o sull'oggetto, che deve stare dentro la finestra.
4. Scatta la foto inquadrando tutta la cornice. L'app trova i marker, raddrizza la prospettiva e traccia i contorni.
5. Regola soglia, precisione e rumore, poi scarica l'SVG (unità in millimetri).

## Come funziona

- **Marker**: quattro ArUco `ARUCO_MIP_36h12` (id 0–3) rilevati con [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (incluso in `src/vendor`), poi raffinati al sub-pixel adattando una retta su ogni lato.
- **Prospettiva**: omografia ai minimi quadrati sui 16 angoli dei marker; la finestra della cornice viene ricampionata a 5 px/mm.
- **Luce**: lo sfondo della carta viene stimato con una superficie quadratica e rimosso, poi soglia automatica (Otsu).
- **Vettorializzazione**: marching squares con interpolazione sub-pixel, semplificazione Douglas–Peucker, angoli vivi preservati e curve di Bézier sul resto.
- **Linea singola**: assottigliamento Zhang–Suen dell'inchiostro, scheletro diviso in rami tra estremi e incroci, rimozione dei rami spuri, estremi riallungati di mezzo tratto; i tracciati aperti escono come linee non chiuse nell'SVG.

Tutto gira nel browser, nessun server.

## Sviluppo

```bash
npm install
npm run dev     # server locale, raggiungibile anche dal telefono nella stessa rete
npm test        # test su foto sintetiche in prospettiva
npm run build
```

Per provarla dal telefono basta `npm run dev` e aprire l'indirizzo di rete sulla stessa Wi-Fi. Per installarla come app serve HTTPS: il workflow `.github/workflows/pages.yml` pubblica l'app su GitHub Pages a ogni push su `main` (in Settings → Pages scegli "GitHub Actions" come sorgente).

## Limiti noti

- Lo spessore del supporto rigido solleva i marker sopra il disegno: con 2 mm di cartone e il telefono a 40 cm l'errore di scala è circa 0,5%. Meglio supporti sottili.
- Gli oggetti 3D proiettano ombre e il loro bordo superiore risulta più grande per la prospettiva: meglio luce dall'alto e oggetti bassi.
- In modalità "linea singola" gli incroci tra tratti spessi possono spostarsi leggermente verso il centro della macchia d'inchiostro.

## Licenza

ShapesCraft è distribuito con licenza [GNU AGPL-3.0](LICENSE) (`AGPL-3.0-only`). Copyright © 2026 Alessandro Devigili.

Il codice in `src/vendor/js-aruco2/` resta sotto la sua licenza originale (MIT, con parti derivate da OpenCV sotto licenza BSD): vedi [`src/vendor/js-aruco2/LICENSE.txt`](src/vendor/js-aruco2/LICENSE.txt).
