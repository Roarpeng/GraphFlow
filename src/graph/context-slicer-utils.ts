import { logger } from "../utils/logger.js";
import type { GraphNode } from "../core/types.js";
import type { ContextLayer, ContextAnchorItem } from "./context-slicer-types.js";

let encoderFn: ((text: string) => number[]) | null = null;
let encoderLoaded = false;

export function getEncoder(): ((text: string) => number[]) | null {
  if (encoderLoaded) return encoderFn;
  encoderLoaded = true;
  try {
    const mod = require("gpt-tokenizer/encoding/o200k_base") as { encode: (t: string) => number[] };
    if (typeof mod.encode === "function") {
      encoderFn = mod.encode.bind(mod);
      return encoderFn;
    }
  } catch (error) {
    logger.error({ error }, "Caught error");
    // fall through
  }
  try {
    const mod = require("gpt-tokenizer") as { encode: (t: string) => number[] };
    if (typeof mod.encode === "function") {
      encoderFn = mod.encode.bind(mod);
      return encoderFn;
    }
  } catch (error) {
    logger.error({ error }, "Caught error");
    // fall through
  }
  encoderFn = null;
  return null;
}

export function estimateTokens(text: string): number {
  const enc = getEncoder();
  if (enc) {
    try {
      const n = enc(text).length;
      return Math.max(1, n);
    } catch (error) {
    logger.error({ error }, "Caught error");
      // fall back below
    }
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function summarizeNodes(nodes: GraphNode[]): string[] {
  return nodes.map((node) => `${node.type}(${node.id})`);
}

export function classifyLayer(node: GraphNode): ContextLayer {
  if (node.type === "File" || node.type === "Symbol") {
    return "L1";
  }

  if (node.type === "Module") {
    return "L2";
  }

  return "L3";
}

export function canUseLayer(
  layer: ContextLayer,
  quota: { l1: number; l2: number; l3: number },
  used: { l1: number; l2: number; l3: number }
): boolean {
  if (layer === "L1") {
    return used.l1 < quota.l1;
  }

  if (layer === "L2") {
    return used.l2 < quota.l2;
  }

  return used.l3 < quota.l3;
}

export function markLayerUsed(layer: ContextLayer, used: { l1: number; l2: number; l3: number }): void {
  if (layer === "L1") {
    used.l1 += 1;
    return;
  }

  if (layer === "L2") {
    used.l2 += 1;
    return;
  }

  used.l3 += 1;
}

export function modulePathKey(relPath: string): string {
  return relPath.replace(/\.(ts|tsx|js|jsx|md|json|py|rs|go|hpp|hxx|cpp|cxx|cc|h|c|java|rb|rake|gemspec)$/i, "");
}

export function deriveModuleId(anchor: ContextAnchorItem, node?: GraphNode): string | undefined {
  if (anchor.type === "File" && anchor.id.startsWith("file:")) {
    return `module:${modulePathKey(anchor.id.slice("file:".length))}`;
  }

  if (anchor.type === "Symbol") {
    const filePath =
      typeof node?.metadata?.file === "string"
        ? node.metadata.file
        : extractFileFromSymbolId(anchor.id);
    if (filePath) {
      return `module:${modulePathKey(filePath)}`;
    }
  }

  return undefined;
}

export function extractFileFromSymbolId(id: string): string | undefined {
  if (!id.startsWith("symbol:")) {
    return undefined;
  }
  const body = id.slice("symbol:".length);
  const hashIndex = body.lastIndexOf(":");
  if (hashIndex > 0) {
    return body.slice(0, hashIndex);
  }
  return undefined;
}