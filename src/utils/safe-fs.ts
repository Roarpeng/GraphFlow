import { readdirSync, statSync, type Dirent } from "node:fs";

type NodeFsError = NodeJS.ErrnoException;

/** True for permission denied / missing path errors that should skip a directory, not abort indexing. */
export function isIgnorableFsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as NodeFsError).code;
  return code === "EPERM" || code === "EACCES" || code === "ENOENT";
}

export function safeReaddirSync(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isIgnorableFsError(error)) {
      return [];
    }
    throw error;
  }
}

export function safeStatSync(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch (error) {
    if (isIgnorableFsError(error)) {
      return undefined;
    }
    throw error;
  }
}
