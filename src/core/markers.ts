/**
 * Unique markers: a frame or mat printed for one project, with marker ids drawn at
 * random instead of the standard fixed ones.
 *
 * The fixed sheets use ids 0..99 of the dictionary; the unique ones use the 150 ids
 * from 100 to 249. On a sheet with `n` markers, the marker in position `i` gets one of
 * the ids 100 + i, 100 + i + n, 100 + i + 2n, …, picked at random. So any id read in a
 * photo tells by itself where it sits on the sheet: the app needs no list of the
 * sheets printed so far, and a sheet printed from a computer works on any phone.
 * There are about 2 million unique 2D frames and more than 10^16 of each 3D mat.
 */

/** First id of the unique range and number of ids in it (the dictionary has 250). */
export const UNIQUE_FIRST = 100;
export const UNIQUE_COUNT = 150;

export type MarkerMode = 'fixed' | 'unique';

export function isUniqueId(id: number): boolean {
  return Number.isInteger(id) && id >= UNIQUE_FIRST && id < UNIQUE_FIRST + UNIQUE_COUNT;
}

/** Position on a sheet of `n` markers of a unique id. */
export function uniqueSlot(id: number, n: number): number {
  return (id - UNIQUE_FIRST) % n;
}

/** How many ids can go in position `slot` of a sheet of `n` markers. */
function choices(slot: number, n: number): number {
  return Math.ceil((UNIQUE_COUNT - slot) / n);
}

/** A fresh random set of ids, one per position, for a sheet of `n` markers. */
export function randomUniqueIds(n: number, random: (k: number) => number = cryptoInt): number[] {
  return Array.from({ length: n }, (_, i) => UNIQUE_FIRST + i + n * random(choices(i, n)));
}

/** Whether `ids` is a complete set of unique ids for a sheet of `n` markers. */
export function validUniqueIds(ids: unknown, n: number): ids is number[] {
  return Array.isArray(ids) && ids.length === n && ids.every((id, i) => isUniqueId(id) && uniqueSlot(id, n) === i);
}

/** Crockford base 32: no I, L, O, U, so the code can be read back without doubts. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The project code of a complete set of unique ids, printed on the sheet and shown by
 * the app when it recognises it: the same ids always give the same code.
 */
export function uniqueCode(ids: readonly number[]): string {
  const n = ids.length;
  let value = 0n;
  for (let i = n - 1; i >= 0; i--) value = value * BigInt(choices(i, n)) + BigInt((ids[i] - UNIQUE_FIRST - i) / n);
  let digits = 1n;
  for (let i = 0; i < n; i++) digits *= BigInt(choices(i, n));
  let code = '';
  for (let max = digits - 1n; max > 0n || !code; max /= 32n, value /= 32n) code = ALPHABET[Number(value % 32n)] + code;
  // Groups of three to five characters are easier to read and copy.
  if (code.length <= 6) return code;
  const groups = Math.ceil(code.length / 5);
  const out: string[] = [];
  for (let g = 0, at = 0; g < groups; g++) {
    const len = Math.ceil((code.length - at) / (groups - g));
    out.push(code.slice(at, at + len));
    at += len;
  }
  return out.join('-');
}

function cryptoInt(k: number): number {
  // Rejection sampling keeps every id equally likely.
  const limit = Math.floor(0x100000000 / k) * k;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % k;
}
