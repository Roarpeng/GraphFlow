import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  getTreeSitterParser,
  type TreeSitterEdit,
  type TreeSitterLanguage,
  type TreeSitterSyntaxNode,
  type TreeSitterTree,
} from "./tree-sitter-loader.js";

const MAX_INCREMENTAL_PARSE_CACHE_ENTRIES = 32;

interface IncrementalParseCacheEntry {
  content: string;
  hash: string;
  language: TreeSitterLanguage;
  tree: TreeSitterTree;
}

export interface IncrementalParseResult {
  rootNode: TreeSitterSyntaxNode;
  usedIncremental: boolean;
}

const parseCache = new Map<string, IncrementalParseCacheEntry>();

export async function parseFileIncremental(
  filePath: string,
  language: TreeSitterLanguage,
  newContent: string
): Promise<IncrementalParseResult> {
  const key = resolve(filePath);
  const cached = parseCache.get(key);
  const parser = await getTreeSitterParser(language);

  if (cached?.language === language && canEditTree(cached.tree)) {
    try {
      const edit = computeTreeEdit(cached.content, newContent);
      cached.tree.edit(edit);
      const tree = parser.parse(newContent, cached.tree);
      cached.tree.delete?.();
      rememberParsedTree(key, {
        content: newContent,
        hash: hashContent(newContent),
        language,
        tree,
      });
      return { rootNode: tree.rootNode, usedIncremental: true };
    } catch {
      cached.tree.delete?.();
      parseCache.delete(key);
    }
  } else if (cached) {
    cached.tree.delete?.();
    parseCache.delete(key);
  }

  const tree = parser.parse(newContent);
  rememberParsedTree(key, {
    content: newContent,
    hash: hashContent(newContent),
    language,
    tree,
  });
  return { rootNode: tree.rootNode, usedIncremental: false };
}

export function computeTreeEdit(oldContent: string, newContent: string): TreeSitterEdit {
  let prefixLength = 0;
  const maxPrefixLength = Math.min(oldContent.length, newContent.length);
  while (
    prefixLength < maxPrefixLength &&
    oldContent.charCodeAt(prefixLength) === newContent.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  const maxSuffixLength = Math.min(
    oldContent.length - prefixLength,
    newContent.length - prefixLength
  );
  while (
    suffixLength < maxSuffixLength &&
    oldContent.charCodeAt(oldContent.length - suffixLength - 1) ===
      newContent.charCodeAt(newContent.length - suffixLength - 1)
  ) {
    suffixLength += 1;
  }

  const oldEndCharacter = oldContent.length - suffixLength;
  const newEndCharacter = newContent.length - suffixLength;

  return {
    startIndex: byteLength(oldContent.slice(0, prefixLength)),
    oldEndIndex: byteLength(oldContent.slice(0, oldEndCharacter)),
    newEndIndex: byteLength(newContent.slice(0, newEndCharacter)),
    startPosition: pointForCharacterIndex(oldContent, prefixLength),
    oldEndPosition: pointForCharacterIndex(oldContent, oldEndCharacter),
    newEndPosition: pointForCharacterIndex(newContent, newEndCharacter),
  };
}

export function clearIncrementalParseCache(): void {
  for (const entry of parseCache.values()) {
    entry.tree.delete?.();
  }
  parseCache.clear();
}

function rememberParsedTree(key: string, entry: IncrementalParseCacheEntry): void {
  parseCache.delete(key);
  parseCache.set(key, entry);

  while (parseCache.size > MAX_INCREMENTAL_PARSE_CACHE_ENTRIES) {
    const oldestKey = parseCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    const oldest = parseCache.get(oldestKey);
    oldest?.tree.delete?.();
    parseCache.delete(oldestKey);
  }
}

function canEditTree(tree: TreeSitterTree): tree is TreeSitterTree & Required<Pick<TreeSitterTree, "edit">> {
  return typeof tree.edit === "function";
}

function pointForCharacterIndex(content: string, characterIndex: number): { row: number; column: number } {
  let row = 0;
  let lineStartCharacter = 0;

  for (let idx = 0; idx < characterIndex; idx += 1) {
    if (content.charCodeAt(idx) === 10) {
      row += 1;
      lineStartCharacter = idx + 1;
    }
  }

  return {
    row,
    column: byteLength(content.slice(lineStartCharacter, characterIndex)),
  };
}

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
