import { logger } from "../utils/logger";
import {
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  writeSync,
  statSync,
} from "node:fs";

/** A lock file younger than this may still be mid-creation (openSync before
 * writeSync of the pid) — never reap it, only older corrupt files. */
const CORRUPT_LOCK_MIN_AGE_MS = 10_000;

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isStaleCorruptLock(lockFilePath: string): boolean {
  try {
    const age = Date.now() - statSync(lockFilePath).mtimeMs;
    return age >= CORRUPT_LOCK_MIN_AGE_MS;
  } catch {
    // vanished or unreadable — treat as reaped
    return true;
  }
}

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
        try {
          writeSync(this.fd, String(process.pid));
        } catch (writeErr: unknown) {
          // Avoid leaking the fd and leaving a half-written lock behind.
          try {
            closeSync(this.fd);
          } catch {
            // ignore close failure on the error path
          }
          this.fd = null;
          try {
            unlinkSync(this.lockFilePath);
          } catch {
            // ignore — next acquire sees the stale file and reaps it
          }
          throw writeErr;
        }
        return true;
      } catch (err: unknown) {
        if (nodeErrorCode(err) !== "EEXIST") {
          throw err;
        }

        try {
          const pidStr = readFileSync(this.lockFilePath, "utf8").trim();
          const pid = pidStr === "" ? Number.NaN : parseInt(pidStr, 10);
          if (Number.isNaN(pid)) {
            // Crash between openSync and writeSync leaves an empty/unparsable
            // lock file that no process holds — reap it (once it is old enough
            // not to race the creator's pid write) instead of blocking forever.
            if (isStaleCorruptLock(this.lockFilePath)) {
              try {
                unlinkSync(this.lockFilePath);
              } catch {
                // someone else reaped it first — retry immediately
              }
              continue;
            }
          } else if (pid !== process.pid) {
            try {
              process.kill(pid, 0);
            } catch (e: unknown) {
              if (nodeErrorCode(e) === "ESRCH") {
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
      } catch (_err: unknown) {
        if (nodeErrorCode(_err) && nodeErrorCode(_err) !== "ENOENT") {
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
