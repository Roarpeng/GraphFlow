import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerObservation } from "../src/domain.js";
import {
  CREDENTIAL_ENV_CACHE_TTL_MS,
  readCredentialEnv,
  resetCredentialEnvCache,
  type RegistryExec,
} from "../src/host/credential-env.js";
import { createTypeSafeJevWorker } from "../src/workers/typesafe-jev-worker.js";

// Every case injects `env`, `platform` and `exec`: the real registry is never read.
const HKCU = "HKCU\\Environment";
const HKLM = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

function regOutput(key: string, name: string, type: "REG_SZ" | "REG_EXPAND_SZ", value: string): string {
  return `\r\n${key}\r\n    ${name}    ${type}    ${value}\r\n\r\n`;
}

/** Fake `reg query <key> /v <name>`: `values[key][NAME]` hit, undefined = value not found. */
function fakeReg(values: Partial<Record<string, Record<string, { type?: "REG_SZ" | "REG_EXPAND_SZ"; value: string }>>>) {
  return vi.fn<RegistryExec>((file, args) => {
    expect(file).toBe("reg");
    const [verb, key = "", flag, name = ""] = args;
    expect(verb).toBe("query");
    expect(flag).toBe("/v");
    const hit = values[key]?.[name.toUpperCase()];
    return hit ? regOutput(key, name, hit.type ?? "REG_SZ", hit.value) : undefined;
  });
}

beforeEach(() => resetCredentialEnvCache());

describe("readCredentialEnv", () => {
  it("prefers process.env and never queries the registry when the var is set", () => {
    const exec = fakeReg({ [HKCU]: { TYPESAFE_API_KEY: { value: "from-registry" } } });
    const value = readCredentialEnv("TYPESAFE_API_KEY", { env: { TYPESAFE_API_KEY: "  from-env  " }, platform: "win32", exec });
    expect(value).toBe("from-env");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to HKCU, then HKLM, on win32", () => {
    const user = fakeReg({ [HKCU]: { TYPESAFE_API_KEY: { value: "user-key" } }, [HKLM]: { TYPESAFE_API_KEY: { value: "machine-key" } } });
    expect(readCredentialEnv("TYPESAFE_API_KEY", { env: {}, platform: "win32", exec: user })).toBe("user-key");
    expect(user).toHaveBeenCalledTimes(1);
    expect(user.mock.calls[0]?.[1]).toEqual(["query", HKCU, "/v", "TYPESAFE_API_KEY"]);

    resetCredentialEnvCache();
    const machine = fakeReg({ [HKLM]: { TYPESAFE_API_KEY: { value: "machine-key" } } });
    expect(readCredentialEnv("TYPESAFE_API_KEY", { env: {}, platform: "win32", exec: machine })).toBe("machine-key");
    expect(machine.mock.calls.map((c) => c[1][1])).toEqual([HKCU, HKLM]);
  });

  it("expands REG_EXPAND_SZ references from the environment", () => {
    const exec = fakeReg({ [HKCU]: { TOOL_HOME: { type: "REG_EXPAND_SZ", value: "%BASE%\\tool" } } });
    expect(readCredentialEnv("TOOL_HOME", { env: { BASE: "C:\\x" }, platform: "win32", exec })).toBe("C:\\x\\tool");
  });

  it("does nothing off Windows or when GRAPHFLOW_NO_REGISTRY_ENV opts out", () => {
    const exec = fakeReg({ [HKCU]: { TYPESAFE_API_KEY: { value: "k" } } });
    expect(readCredentialEnv("TYPESAFE_API_KEY", { env: {}, platform: "linux", exec })).toBeUndefined();
    for (const flag of ["1", "true", "YES"]) {
      expect(readCredentialEnv("TYPESAFE_API_KEY", { env: { GRAPHFLOW_NO_REGISTRY_ENV: flag }, platform: "win32", exec })).toBeUndefined();
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("caches registry answers (hits and misses) for ~30s", () => {
    let now = 1_000;
    const exec = fakeReg({ [HKCU]: { TYPESAFE_API_KEY: { value: "k1" } } });
    const opts = { env: {}, platform: "win32" as const, exec, now: () => now };
    expect(readCredentialEnv("TYPESAFE_API_KEY", opts)).toBe("k1");
    expect(readCredentialEnv("typesafe_api_key", opts)).toBe("k1"); // case-insensitive cache key
    expect(readCredentialEnv("MISSING_KEY", opts)).toBeUndefined();
    expect(readCredentialEnv("MISSING_KEY", opts)).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(3); // 1 hit (HKCU) + 2 misses (HKCU, HKLM), then cached
    now += CREDENTIAL_ENV_CACHE_TTL_MS;
    expect(readCredentialEnv("TYPESAFE_API_KEY", opts)).toBe("k1");
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("never throws: transient reg failures return undefined and are not cached", () => {
    let fail = true;
    const exec = vi.fn<RegistryExec>((_file, args) => {
      if (fail) throw new Error("reg timed out");
      return args[1] === HKCU ? regOutput(HKCU, "TYPESAFE_API_KEY", "REG_SZ", "late-key") : undefined;
    });
    const opts = { env: {}, platform: "win32" as const, exec };
    expect(readCredentialEnv("TYPESAFE_API_KEY", opts)).toBeUndefined();
    fail = false;
    expect(readCredentialEnv("TYPESAFE_API_KEY", opts)).toBe("late-key");
  });

  it("rejects names that are not env identifiers without spawning reg", () => {
    const exec = fakeReg({});
    for (const bad of ["", "  ", "A B", "X&calc", "/v"]) {
      expect(readCredentialEnv(bad, { env: {}, platform: "win32", exec })).toBeUndefined();
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("treats blank values as absent", () => {
    const exec = fakeReg({ [HKCU]: { TYPESAFE_API_KEY: { value: "   " } } });
    expect(readCredentialEnv("TYPESAFE_API_KEY", { env: { TYPESAFE_API_KEY: "" }, platform: "win32", exec })).toBeUndefined();
  });
});

describe("TypeSafe-JEV worker key source", () => {
  const ok: WorkerObservation = { exitCode: 0, stdoutTail: "ok", durationMs: 1 };
  const systemOne = () =>
    vi.fn(async () => new Response(JSON.stringify({ answers: { succeeded: { type: "noul", noul: 0.9 } } }), { status: 200 }));

  it("uses the registry key when process.env lacks it, resolved lazily at validate()", async () => {
    const exec = fakeReg({ [HKCU]: { TYPESAFE_API_KEY: { value: "tsk-registry" } } });
    const fetchMock = systemOne();
    const worker = createTypeSafeJevWorker({
      credentialEnv: { env: {}, platform: "win32", exec },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await worker.prepare(["node -v"]);
    expect(exec).not.toHaveBeenCalled();
    expect((await worker.validate(ok)).passed).toBe(true);
    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const auth = (init[1].headers as Record<string, string>)["authorization"] ?? "";
    expect(auth.startsWith("Bearer ")).toBe(true);
    expect(auth.length).toBe("Bearer ".length + "tsk-registry".length);
  });

  it("an explicit apiKey still wins (no registry lookup), and no key at all means local-only validation", async () => {
    const exec = fakeReg({ [HKCU]: { TYPESAFE_API_KEY: { value: "tsk-registry" } } });
    const fetchMock = systemOne();
    const explicit = createTypeSafeJevWorker({
      apiKey: "",
      credentialEnv: { env: {}, platform: "win32", exec },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect((await explicit.validate(ok)).passed).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const none = createTypeSafeJevWorker({
      credentialEnv: { env: { GRAPHFLOW_NO_REGISTRY_ENV: "1" }, platform: "win32", exec },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect((await none.validate(ok)).passed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
