import { logger } from "../utils/logger";
import { openSync, closeSync, unlinkSync, readFileSync, writeSync } from "node:fs";

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
        writeSync(this.fd, String(process.pid));
        return true;
      } catch (err: any) {
        if (err.code !== "EEXIST") {
          throw err;
        }
        
        try {
          const pidStr = readFileSync(this.lockFilePath, "utf8");
          const pid = parseInt(pidStr, 10);
          if (pid && pid !== process.pid) {
            try {
              process.kill(pid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") {
                unlinkSync(this.lockFilePath);
                continue;
              }
            }
          }
        } catch {
          // ignore
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
      } catch (error) {
        logger.error({ error }, "Caught error");
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
