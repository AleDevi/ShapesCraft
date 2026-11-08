declare module 'earcut' {
  /** Triangulates a polygon with holes; returns vertex indices, three per triangle. */
  export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number> | null, dim?: number): number[];
}
