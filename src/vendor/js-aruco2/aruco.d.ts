export interface ArucoPoint { x: number; y: number }
export interface ArucoMarker { id: number; corners: ArucoPoint[]; hammingDistance: number }
export interface ArucoImage { width: number; height: number; data: Uint8ClampedArray | Uint8Array | number[] }
export declare const AR: {
  Detector: new (config?: { dictionaryName?: string; maxHammingDistance?: number }) => {
    detect(image: ArucoImage): ArucoMarker[];
  };
  Dictionary: new (name: string) => { generateSVG(id: number): string; codeList: string[]; markSize: number };
};
