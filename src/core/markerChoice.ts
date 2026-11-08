import { randomUniqueIds, uniqueCode, validUniqueIds, type MarkerMode } from './markers';

/**
 * The person's choice between fixed and unique markers, remembered on this device,
 * with the unique ids drawn for each sheet layout: downloading or sharing the PDF
 * again gives the same sheet, until new markers are asked for.
 */
export class MarkerChoice {
  constructor(private readonly prefix: string) {}

  get mode(): MarkerMode {
    return read(`${this.prefix}.mode`) === 'unique' ? 'unique' : 'fixed';
  }

  set mode(mode: MarkerMode) {
    write(`${this.prefix}.mode`, mode);
  }

  /** The unique ids of a sheet `layout` with `n` markers, or undefined for the fixed markers. */
  ids(layout: string, n: number): number[] | undefined {
    if (this.mode === 'fixed') return undefined;
    let ids: unknown;
    try {
      ids = JSON.parse(read(`${this.prefix}.ids.${layout}`) ?? 'null');
    } catch {
      ids = null;
    }
    return validUniqueIds(ids, n) ? ids : this.renew(layout, n);
  }

  code(layout: string, n: number): string | undefined {
    const ids = this.ids(layout, n);
    return ids && uniqueCode(ids);
  }

  /** Draws a new set of unique ids for `layout`. */
  renew(layout: string, n: number): number[] {
    const ids = randomUniqueIds(n);
    write(`${this.prefix}.ids.${layout}`, JSON.stringify(ids));
    return ids;
  }
}

// Storage can be blocked (private windows, embedded pages): the choice then lasts for the visit.
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept in memory only.
  }
}
