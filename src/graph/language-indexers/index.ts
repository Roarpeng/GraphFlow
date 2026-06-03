import { typescriptIndexer } from "./typescript";
import { pythonIndexer } from "./python";
import { rustIndexer } from "./rust";
import { goIndexer } from "./go";
import { cppIndexer } from "./c-cpp";

export interface DeclaredSymbol {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
  file: string;
  signature?: string;
  jsdoc?: string;
  visibility?: "public" | "protected" | "private";
  paramsCount?: number;
  returnType?: string;
  complexity?: number;
}

export interface ImportTarget {
  module: string;
  raw?: string;
}

export interface ExtractionResult {
  symbols: DeclaredSymbol[];
  imports: ImportTarget[];
}

export interface LanguageIndexer {
  language: string;
  extensions: string[];
  extract(filePath: string, content: string): ExtractionResult | Promise<ExtractionResult>;
}

const INDEXERS: LanguageIndexer[] = [
  typescriptIndexer,
  pythonIndexer,
  rustIndexer,
  goIndexer,
  cppIndexer,
];

export function getIndexerForFile(filename: string): LanguageIndexer | undefined {
  const lower = filename.toLowerCase();
  for (const indexer of INDEXERS) {
    if (indexer.extensions.some((ext) => lower.endsWith(ext))) {
      return indexer;
    }
  }
  return undefined;
}

export const ALL_LANGUAGE_EXTENSIONS: string[] = Array.from(
  new Set(INDEXERS.flatMap((i) => i.extensions))
);
