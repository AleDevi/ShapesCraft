export type Lang = 'en' | 'it';

const en = {
  tagline: 'From photo to true-scale vector',
  language: 'Language',
  'frame.title': 'Frame',
  'frame.format': 'Format',
  'frame.hint':
    'Print the frame at 100% (no "fit to page") and check that the reference line measures 100 mm. ' +
    'For a rigid frame, glue it to card or thin plastic and cut out the outer edge and the window. ' +
    'Then lay it over the drawing or object (on a white background), which must sit inside the window.',
  'frame.open': 'Open printable frame',
  'photo.title': 'Photo',
  'photo.hint': 'Frame the whole sheet with all four markers visible. Even light, no glare.',
  'photo.take': 'Take photo',
  'photo.upload': 'Upload image',
  'result.title': 'Vector',
  threshold: 'Threshold',
  'threshold.auto': 'Automatic',
  straighten: 'Straighten lines',
  'straighten.hint': 'Left follows the stroke faithfully, right removes wobble and straightens.',
  minarea: 'Ignore shapes under',
  smooth: 'Smoothing',
  'smooth.hint': 'Left follows every detail, right removes bumps and noise while keeping curves and corners.',
  'smooth.off': 'off',
  centerline: 'Single line (stroke centre)',
  'centerline.hint': 'For pen drawings: each stroke becomes one line instead of a closed outline. Useful for engraving and plotters.',
  invert: 'Light shapes on a dark background',
  'show-photo': 'Show photo under the paths',
  download: 'Download SVG',
  'status.loading': 'Loading the photo…',
  'status.detecting': 'Looking for the frame…',
  'status.rectifying': 'Correcting the perspective…',
  'status.found': 'Frame found.',
  'status.partial': 'Frame found with {n} of 4 markers: the scale may be less accurate.',
  'status.notFound':
    'Frame not found: {n} of 4 markers recognised. Get the whole sheet in the shot and avoid glare and shadows on the black squares.',
  'status.saveFailed': "Couldn't save the file on this page.",
  'summary.none': 'No shapes found: try raising the threshold.',
  'summary.shape': 'shape',
  'summary.shapes': 'shapes',
  'summary.line': 'line',
  'summary.lines': 'lines',
  'sheet.scale': 'print at 100%: the line = 100 mm',
  'sheet.glue1': 'Glue to card or thin plastic,',
  'sheet.glue2': 'then cut along the black lines (outer edge and window)',
};

type Key = keyof typeof en;

const it: Record<Key, string> = {
  tagline: 'Dalla foto al vettoriale in scala reale',
  language: 'Lingua',
  'frame.title': 'Cornice',
  'frame.format': 'Formato',
  'frame.hint':
    'Stampa la cornice al 100% (senza "adatta alla pagina") e controlla che la linea di riferimento misuri 100 mm. ' +
    'Per una cornice rigida incollala su cartoncino o plastica sottile e ritaglia bordo esterno e finestra. ' +
    "Poi appoggiala sul disegno o sull'oggetto (su fondo bianco), che deve stare dentro la finestra.",
  'frame.open': 'Apri cornice da stampare',
  'photo.title': 'Foto',
  'photo.hint': 'Inquadra tutto il foglio con i quattro marker visibili. Luce uniforme, niente riflessi.',
  'photo.take': 'Scatta foto',
  'photo.upload': 'Carica immagine',
  'result.title': 'Vettoriale',
  threshold: 'Soglia',
  'threshold.auto': 'Automatica',
  straighten: 'Raddrizza linee',
  'straighten.hint': 'A sinistra segue fedelmente il tratto, a destra toglie le irregolarità e raddrizza.',
  minarea: 'Ignora forme sotto',
  smooth: 'Levigatura',
  'smooth.hint': 'A sinistra segue ogni dettaglio, a destra toglie bozzi e rumore mantenendo curve e spigoli.',
  'smooth.off': 'no',
  centerline: 'Linea singola (centro del tratto)',
  'centerline.hint': 'Per disegni a penna: ogni tratto diventa una sola linea invece di un contorno chiuso. Utile per incisione e plotter.',
  invert: 'Forme chiare su fondo scuro',
  'show-photo': 'Mostra foto sotto i tracciati',
  download: 'Scarica SVG',
  'status.loading': 'Carico la foto…',
  'status.detecting': 'Cerco la cornice…',
  'status.rectifying': 'Raddrizzo la prospettiva…',
  'status.found': 'Cornice trovata.',
  'status.partial': 'Cornice trovata con {n} marker su 4: la scala potrebbe essere meno precisa.',
  'status.notFound':
    'Cornice non trovata: riconosciuti {n} marker su 4. Inquadra tutto il foglio, evita riflessi e ombre sui quadrati neri.',
  'status.saveFailed': 'Non riesco a salvare il file in questa pagina.',
  'summary.none': 'Nessuna forma trovata: prova ad alzare la soglia.',
  'summary.shape': 'forma',
  'summary.shapes': 'forme',
  'summary.line': 'linea',
  'summary.lines': 'linee',
  'sheet.scale': 'stampa al 100%: la linea = 100 mm',
  'sheet.glue1': 'Incolla su cartoncino o plastica sottile,',
  'sheet.glue2': 'poi ritaglia lungo le linee nere (bordo esterno e finestra)',
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, it };

export type Translate = (key: Key, vars?: Record<string, string | number>) => string;

export function translator(lang: Lang): Translate {
  return (key, vars = {}) => dictionaries[lang][key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

/** Italian for Italian-language browsers, English otherwise. */
export function defaultLang(languages: readonly string[]): Lang {
  return languages.some((l) => l.toLowerCase().startsWith('it')) ? 'it' : 'en';
}
