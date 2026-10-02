import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * JSON-file KV store for the injected cache / policy / registry ports. Writes
 * go through a temp file + rename so a crash never leaves half a store.
 */
export interface FileKVStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export function createFileKVStore(path: string): FileKVStore {
  let data: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        );
      }
    } catch {
      data = {};
    }
  }
  return {
    get(key) {
      return data[key];
    },
    set(key, value) {
      data[key] = value;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      renameSync(tmp, path);
    },
  };
}
