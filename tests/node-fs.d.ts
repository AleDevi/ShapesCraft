// The project has no Node type definitions: just the two calls the frames test needs.
declare module 'node:fs' {
  export function readdirSync(path: URL): string[];
  export function readFileSync(path: URL): Uint8Array;
}
