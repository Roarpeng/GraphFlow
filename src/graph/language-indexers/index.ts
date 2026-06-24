import { typescriptIndexer } from "./typescript";
import { pythonIndexer } from "./python";
import { rustIndexer } from "./rust";
import { goIndexer } from "./go";
import { cppIndexer } from "./c-cpp";
import { javaIndexer } from "./java";
import { rubyIndexer } from "./ruby";

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

export interface CallRelation {
  /** Name of the function/method being called. */
  callee: string;
  /** Name of the enclosing function/method that makes the call, if known. */
  caller?: string;
  /** Line number where the call occurs. */
  line: number;
}

export interface InheritRelation {
  /** Name of the child type (class/interface/struct). */
  child: string;
  /** Name of the parent type being extended/implemented. */
  parent: string;
  /** Kind of inheritance: extends (class), implements (interface). */
  kind: "extends" | "implements";
  /** Line number of the declaration. */
  line: number;
}

export interface ExtractionResult {
  symbols: DeclaredSymbol[];
  imports: ImportTarget[];
  calls?: CallRelation[];
  inherits?: InheritRelation[];
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
  javaIndexer,
  rubyIndexer,
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
