import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { FileLock, withFileLock } from "../src/utils/file-lock";

describe("M101 file lock", () => {
  let dir: string;

  function ensureDir(): string {
    if (!dir) dir = mkdtempSync(join(tmpdir(), "gf-m101-"));
    return dir;
  }

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("acquire writes pid, release unlinks the lock file", async () => {
    const lockPath = join(ensureDir(), "task.lock");
    const lock = new FileLock(lockPath);
    expect(await lock.acquire(1000, 10)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a held lock blocks a second acquire until timeout", async () => {
    const lockPath = join(ensureDir(), "held.lock");
    const first = new FileLock(lockPath);
    expect(await first.acquire(1000, 10)).toBe(true);
    const second = new FileLock(lockPath);
    expect(await second.acquire(120, 20)).toBe(false);
    // Releasing the second lock without ownership must not unlink the first's file.
    second.release();
    expect(existsSync(lockPath)).toBe(true);
    first.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("withFileLock runs fn and always releases, even when fn throws", async () => {
    const lockPath = join(ensureDir(), "with.lock");
    const value = await withFileLock(lockPath, async () => 42, 1000);
    expect(value).toBe(42);
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }, 1000)
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("withFileLock throws when the lock cannot be acquired in time", async () => {
    const lockPath = join(ensureDir(), "stuck.lock");
    const holder = new FileLock(lockPath);
    expect(await holder.acquire(1000, 10)).toBe(true);
    await expect(withFileLock(lockPath, async () => 1, 120)).rejects.toThrow(
      /Failed to acquire lock/
    );
    holder.release();
  });

  it("reaps a stale lock whose owner process is dead (ESRCH)", async () => {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.status).toBe(0);
    const lockPath = join(ensureDir(), "dead-owner.lock");
    writeFileSync(lockPath, String(dead.pid), "utf8");
    const lock = new FileLock(lockPath);
    expect(await lock.acquire(2000, 10)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    lock.release();
  });

  it("reaps an old corrupt (empty) lock file instead of blocking forever", async () => {
    const lockPath = join(ensureDir(), "corrupt.lock");
    writeFileSync(lockPath, "", "utf8");
    // Backdate past the corrupt-lock grace window (crash artifact, no live writer).
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const lock = new FileLock(lockPath);
    expect(await lock.acquire(2000, 10)).toBe(true);
    lock.release();
  });

  it("does not reap a just-created corrupt lock file (mid-creation race)", async () => {
    const lockPath = join(ensureDir(), "fresh-corrupt.lock");
    writeFileSync(lockPath, "", "utf8");
    const lock = new FileLock(lockPath);
    // Fresh mtime → treated as possibly mid-creation; short window → acquire fails.
    expect(await lock.acquire(150, 20)).toBe(false);
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("reaps an old non-numeric corrupt lock file", async () => {
    const lockPath = join(ensureDir(), "garbage.lock");
    writeFileSync(lockPath, "not-a-pid", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const lock = new FileLock(lockPath);
    expect(await lock.acquire(2000, 10)).toBe(true);
    lock.release();
  });
});
