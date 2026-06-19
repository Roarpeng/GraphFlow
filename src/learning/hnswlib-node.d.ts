/**
 * Type declarations for optional hnswlib-node dependency.
 * When not installed, the HNSW index gracefully falls back to linear scan.
 */
declare module "hnswlib-node" {
  export class HierarchicalNSW {
    constructor(space: "cosine" | "l2" | "ip", dim: number);
    initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number): void;
    addPoint(point: number[], label: number): void;
    searchKnn(query: number[], k: number, filter?: (label: number) => boolean): {
      distances: number[];
      neighbors: number[];
    };
    getCurrentCount(): number;
    getMaxElements(): number;
  }
}
