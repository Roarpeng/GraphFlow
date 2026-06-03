import { openSync, closeSync, unlinkSync } from "node:fs";

export class FileLock {
  private lockFilePath: string;
  private fd: number | null = null;

  constructor(lockFilePath: string) {
    this.lockFilePath = lockFilePath;
  }

  async acquire(timeoutMs: number = 30000, retryIntervalMs: number = 500): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        this.fd = openSync(this.lockFilePath, "wx");
        return true;
      } catch (err: any) {
        if (err.code !== "EEXIST") {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      }
    }
    return false;
  }

  release(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
      try {
        unlinkSync(this.lockFilePath);
      } catch (_err: any) {
        if (_err && _err.code !== "ENOENT") {
          throw _err;
        }
      }
    }
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = 30000
): Promise<T> {
  const lock = new FileLock(lockPath);
  const acquired = await lock.acquire(timeoutMs);
  if (!acquired) {
    throw new Error(`Failed to acquire lock for ${lockPath} within ${timeoutMs}ms`);
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
