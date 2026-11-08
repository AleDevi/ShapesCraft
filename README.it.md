<p align="center"><img src="docs/icon.png" alt="Icona di ShapesCraft: un colibrì in volo, disegnato a incisione" width="160"></p>

# ShapesCraft

[English](README.md) · **Italiano**

### 👉 [**Apri l'app: aledevi.github.io/ShapesCraft**](https://aledevi.github.io/ShapesCraft/)

Niente installazione né registrazione: funziona nel browser di telefono, tablet e computer.

Web app (PWA) che trasforma la foto di un disegno o di un oggetto appoggiato su una cornice stampata in un vettoriale SVG in scala reale, pronto per laser, CNC o plotter da taglio.

## Perché un colibrì

Il colibrì vola intorno al fiore con estrema precisione: resta immobile a mezz'aria e gli gira intorno poco alla volta. È quello che si fa col telefono in ShapesCraft: lo si tiene fermo sopra la cornice per una foto nitida e, per la scansione 3D, si gira lentamente intorno all'oggetto, come il colibrì intorno al suo fiore.

L'app è in italiano e in inglese: segue la lingua del telefono e si può cambiare dal menu in alto.

## Come si usa

1. Apri l'app e tocca Inizia. Scegli il formato (A4 o A3) e prendi la cornice in PDF: condividila dal telefono (email, chat, Drive, app della stampante), scaricala, oppure copia il link per aprirla da un computer. Stampala al 100%: la linea di riferimento in basso deve misurare 100 mm.
2. Per una cornice rigida incollala su cartoncino o plastica sottile e ritaglia lungo le linee nere (bordo esterno e finestra centrale). In alternativa usa il foglio così com'è e disegna dentro la finestra.
3. Appoggia la cornice sul disegno (pennarello scuro su carta bianca) o sull'oggetto, che deve stare dentro la finestra.
4. Scatta la foto inquadrando tutta la cornice. L'app trova i marker, raddrizza la prospettiva e traccia i contorni.
5. Regola soglia, raddrizzamento e levigatura, poi scegli il formato e scarica o condividi il file: SVG, DXF (R12), PDF in scala reale o PNG a 300 dpi, sempre in millimetri. Oppure scegli **STL** per trasformare la sagoma in un solido da stampare in 3D: decidi lo spessore e, se vuoi, i bordi arrotondati in alto.

## Come funziona

- **Marker**: quattro ArUco `ARUCO_MIP_36h12` (id 0–3) rilevati con [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (incluso in `src/vendor`), poi raffinati al sub-pixel adattando una retta su ogni lato.
- **Prospettiva**: omografia ai minimi quadrati sui 16 angoli dei marker; la finestra della cornice viene ricampionata a 5 px/mm.
- **Luce**: lo sfondo della carta viene stimato con una superficie quadratica e rimosso, poi soglia automatica (Otsu).
- **Vettorializzazione**: marching squares con interpolazione sub-pixel, semplificazione Douglas–Peucker, angoli vivi preservati e curve di Bézier sul resto.
- **Linea singola**: assottigliamento Zhang–Suen dell'inchiostro, scheletro diviso in rami tra estremi e incroci, rimozione dei rami spuri, estremi riallungati di mezzo tratto; i tracciati aperti escono come linee non chiuse nell'SVG.

- **PDF della cornice**: un piccolo generatore interno trasforma lo stesso disegno della cornice SVG in un PDF vettoriale (Helvetica, WinAnsi). La build pubblica anche tutte le cornici in `frames/`, così un computer può aprirle da link.
- **Esportazioni**: SVG e PDF mantengono le curve di Bézier; DXF R12 (una polilinea per forma, curve spezzate entro 0,02 mm, asse y verso l'alto) per CAD e CNC; PNG disegnato su canvas con i dpi scritti in un chunk `pHYs`, così si apre in scala reale. STL (da 2D a 3D): le forme chiuse sono estruse in un solido chiuso; i bordi arrotondati sono una pila di contorni rientrati presi da un unico campo di distanza con segno (così non si incrociano mai e le parti sottili restano semplicemente più basse), e le facce sono triangolate con [earcut](https://github.com/mapbox/earcut) (ISC).

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

ShapesCraft è distribuito con licenza [Apache 2.0](LICENSE) (`Apache-2.0`): puoi usarlo, modificarlo e ridistribuirlo, anche in prodotti commerciali e a codice chiuso, purché mantieni l'avviso di copyright, la licenza e il file [`NOTICE`](NOTICE). Le versioni pubblicate prima di questo cambio erano rilasciate con AGPL-3.0. Copyright © 2026 Alessandro Devigili.

Il codice in `src/vendor/js-aruco2/` resta sotto la sua licenza originale (MIT, con parti derivate da OpenCV sotto licenza BSD): vedi [`src/vendor/js-aruco2/LICENSE.txt`](src/vendor/js-aruco2/LICENSE.txt). Il pacchetto [earcut](https://github.com/mapbox/earcut), incluso nell'app per l'esportazione STL, è sotto licenza ISC (Copyright (c) 2024, Mapbox). Entrambi i testi sono pubblicati con l'app in `THIRD-PARTY-NOTICES.txt`.
