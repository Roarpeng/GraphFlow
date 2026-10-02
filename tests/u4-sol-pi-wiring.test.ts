/**
 * U4 (SoL-Pi re-wiring) tests.
 *
 * U4-1a: efficiencyPolicy.observations.reduce.enabled now gates the reducer —
 *        an explicit reduce call under `false` is rejected with a stated
 *        reason (no silent full copy), and the settings switch controls the
 *        MCP graphflow_context entry for real.
 * U4-1b: the dsh projection honors the settings switch
 *        (efficiencyPolicy.observations.enabled) read best-effort from the
 *        config layers, with GRAPHFLOW_D_DSH_PROJECTION as the
 *        highest-priority escape hatch.
 * U4-2:  session-level observation pressure accounting with a best-effort
 *        file supply channel (the plugin never calls graphflow_context
 *        itself — see the honest wiring note in dsh/plugin.mjs).
 * U4-3:  oversized graphflow_context preview text copies pack into the
 *        observation store (recallable) before the lossy stub fallback.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  apply,
  estimateTokensFromBytes,
  isObservationProjectionEnabled,
  noteObservationPressure,
  projectToolResultEvent,
  readObservationsSwitch,
  settleObservationPressure,
  writeObservationPressureFile,
} from "../dsh/plugin.mjs";
import { reduceObservation } from "../src/observations";
import {
  executeToolCall,
  renderStablePreviewTextCopy,
} from "../src/surfaces/mcp/tool-handlers";
import type { ContextPreviewResult } from "../src/surfaces/cli/runtime/types";

const tempRoots: string[] = [];

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

/** Known-good full config shape (mirrors tests/efficiency-wiring.test.ts). */
function writeGraphFlowConfig(
  root: string,
  efficiencyPolicy: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {}
): string {
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          enableNearLosslessMode: true,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: join(root, "graph.json"),
          maxContextTokens: 1000,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
        ...(efficiencyPolicy ? { efficiencyPolicy } : {}),
        ...extra,
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
}

/** An isolated GRAPHFLOW_CONFIG_HOME so the machine's global layer never leaks in. */
function makeIsolatedConfigHome(): string {
  return makeRoot("gf-u4-cfg-home-");
}

const OBSERVATION_CONTENT = [
  "INFO start",
  "noise one",
  "ERROR boom",
  "AssertionError: expected 1 actual 2",
  "noise two",
].join("\n");

// ---------------------------------------------------------------------------
// U4-1a: reduce switch gates the reducer
// ---------------------------------------------------------------------------

describe("U4-1a efficiencyPolicy.observations.reduce.enabled gates the reducer", () => {
  it("rejects an explicit reduceObservation call with a stated reason instead of a full copy", async () => {
    const root = makeRoot("gf-u4-reduce-off-");
    const result = await reduceObservation({
      rootDir: root,
      content: OBSERVATION_CONTENT,
      policy: { reduce: { enabled: false } },
    });
    expect(result.fallback).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("reduce-disabled");
    expect(result.retainedLines).toEqual([]);
    expect(result.receipt).toContain("[reduce disabled]");
    expect(result.receipt).toContain("efficiencyPolicy.observations.reduce.enabled=false");
    // Not a silent full-content passthrough:
    expect(result.receipt).not.toContain("ERROR boom");
    expect(result.receipt).not.toContain("AssertionError");
  });

  it("still reduces when the switch is explicitly on (same policy shape)", async () => {
    const root = makeRoot("gf-u4-reduce-on-");
    const result = await reduceObservation({
      rootDir: root,
      content: OBSERVATION_CONTENT,
      policy: { reduce: { enabled: true } },
    });
    expect(result.fallback).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.receipt).toContain("ERROR boom");
  });

  it("the settings switch controls the MCP graphflow_context reduce entry", async () => {
    const offRoot = makeRoot("gf-u4-mcp-reduce-off-");
    const offConfig = writeGraphFlowConfig(offRoot, {
      observations: { reduce: { enabled: false } },
    });
    const rejected = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir: offRoot, configPath: offConfig, content: OBSERVATION_CONTENT, reduce: true },
    });
    const off = rejected.structuredContent as {
      fallback?: boolean;
      verified?: boolean;
      reason?: string;
      receipt?: string;
    };
    expect(off.fallback).toBe(true);
    expect(off.verified).toBe(false);
    expect(off.reason).toBe("reduce-disabled");
    expect(off.receipt).toContain("[reduce disabled]");
    expect(off.receipt).not.toContain("ERROR boom");

    const onRoot = makeRoot("gf-u4-mcp-reduce-on-");
    const onConfig = writeGraphFlowConfig(onRoot, {
      observations: { reduce: { enabled: true } },
    });
    const accepted = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir: onRoot, configPath: onConfig, content: OBSERVATION_CONTENT, reduce: true },
    });
    const on = accepted.structuredContent as { fallback?: boolean; verified?: boolean };
    expect(on.fallback).toBe(false);
    expect(on.verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U4-1b: dsh projection honors the settings switch (env is the escape hatch)
// ---------------------------------------------------------------------------

describe("U4-1b dsh projection switch priority (env > settings > default-on)", () => {
  it("settings observations.enabled=false disables the projection without any env", () => {
    const home = makeIsolatedConfigHome();
    const ws = makeRoot("gf-u4-dsh-off-");
    writeGraphFlowConfig(ws, { observations: { enabled: false } });
    const config = { env: { GRAPHFLOW_CONFIG_HOME: home } };
    expect(isObservationProjectionEnabled({}, ws, config)).toBe(false);
    expect(readObservationsSwitch(ws, config)).toBe(false);
  });

  it("env beats settings in both directions (highest-priority escape hatch)", () => {
    const home = makeIsolatedConfigHome();
    const wsOff = makeRoot("gf-u4-dsh-env-on-");
    writeGraphFlowConfig(wsOff, { observations: { enabled: false } });
    expect(
      isObservationProjectionEnabled({ GRAPHFLOW_D_DSH_PROJECTION: "1" }, wsOff, {
        env: { GRAPHFLOW_CONFIG_HOME: home },
      })
    ).toBe(true);

    const wsOn = makeRoot("gf-u4-dsh-env-off-");
    writeGraphFlowConfig(wsOn, { observations: { enabled: true } });
    expect(
      isObservationProjectionEnabled({ GRAPHFLOW_D_DSH_PROJECTION: "0" }, wsOn, {
        env: { GRAPHFLOW_CONFIG_HOME: home },
      })
    ).toBe(false);
  });

  it("the workspace overlay layer wins over the project root layer", () => {
    const home = makeIsolatedConfigHome();
    const ws = makeRoot("gf-u4-dsh-overlay-");
    writeGraphFlowConfig(ws, { observations: { enabled: true } });
    mkdirSync(join(ws, ".graphflow"), { recursive: true });
    writeFileSync(
      join(ws, ".graphflow", "config.json"),
      JSON.stringify({ efficiencyPolicy: { observations: { enabled: false } } }),
      "utf8"
    );
    expect(readObservationsSwitch(ws, { env: { GRAPHFLOW_CONFIG_HOME: home } })).toBe(false);
  });

  it("defaults on when no layer states an opinion (and never reads the home dir when isolated)", () => {
    const home = makeIsolatedConfigHome();
    const ws = makeRoot("gf-u4-dsh-default-");
    expect(readObservationsSwitch(ws, { env: { GRAPHFLOW_CONFIG_HOME: home } })).toBeUndefined();
    expect(isObservationProjectionEnabled({}, ws, { env: { GRAPHFLOW_CONFIG_HOME: home } })).toBe(true);
  });

  it("projectToolResultEvent refuses to project when settings disable observations", async () => {
    const home = makeIsolatedConfigHome();
    const ws = makeRoot("gf-u4-dsh-proj-off-");
    writeGraphFlowConfig(ws, { observations: { enabled: false } });
    const calls: unknown[] = [];
    const session = {
      append: (...args: unknown[]) => {
        calls.push(args);
        return { seq: 100 };
      },
    };
    const event = {
      type: "tool/result",
      seq: 42,
      data: {
        message: {
          content: [{ type: "tool-result", content: [{ type: "text", text: "x".repeat(9000) }] }],
        },
      },
    };
    const result = await projectToolResultEvent({
      session: session as never,
      event: event as never,
      workspace: ws,
      config: { env: { GRAPHFLOW_CONFIG_HOME: home } },
      packText: async () => ({ handle: "gfo:0123456789abcdef" }),
    });
    expect(result).toEqual({ projected: false, reason: "disabled" });
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U4-2: session observation pressure accounting + file supply channel
// ---------------------------------------------------------------------------

describe("U4-2 session observation pressure accounting", () => {
  it("estimates tokens from bytes with a floor of 0", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(-5)).toBe(0);
    expect(estimateTokensFromBytes(Number.NaN)).toBe(0);
    expect(estimateTokensFromBytes(8000)).toBe(2000);
  });

  it("counts raw bytes first, then settles visible bytes to the projection", () => {
    const session = {};
    const bigEvent = {
      type: "tool/result",
      data: {
        message: {
          content: [{ type: "tool-result", content: [{ type: "text", text: "x".repeat(9000) }] }],
        },
      },
    };
    const pending = noteObservationPressure(session, bigEvent as never);
    expect(pending?.rawBytes).toBe(9000);
    expect(pending?.entry.rawBytes).toBe(9000);
    // Projection replaced the surface: visible bytes are the small projection.
    settleObservationPressure(pending, 3700);
    expect(pending?.entry.visibleBytes).toBe(3700);
    expect(pending?.entry.observations).toBe(1);

    // A result left inline counts its raw bytes as visible bytes.
    const second = noteObservationPressure(session, bigEvent as never);
    settleObservationPressure(second, undefined);
    expect(second?.entry.rawBytes).toBe(18000);
    expect(second?.entry.visibleBytes).toBe(3700 + 9000);
    expect(second?.entry.observations).toBe(2);
  });

  it("never throws on unusable inputs", () => {
    expect(noteObservationPressure(undefined, undefined)).toBeUndefined();
    const pending = noteObservationPressure({}, undefined);
    settleObservationPressure(pending, undefined);
    settleObservationPressure(undefined, 10);
  });

  it("persists per-session snapshots, merging sessions in the pressure file", () => {
    const ws = makeRoot("gf-u4-pressure-file-");
    const first = { rawBytes: 9000, visibleBytes: 3700, observations: 1, updatedAt: 1_700_000_000_000 };
    expect(writeObservationPressureFile(ws, "sess-1", first)).toBe(true);
    const file = join(ws, ".graphflow", "observation-pressure.json");
    expect(existsSync(file)).toBe(true);
    let parsed = JSON.parse(readFileSync(file, "utf8")) as {
      sessions: Record<string, { sessionId: string; usedTokensEstimate: number }>;
    };
    expect(parsed.sessions["sess-1"].usedTokensEstimate).toBe(estimateTokensFromBytes(3700));
    expect(parsed.sessions["sess-1"].sessionId).toBe("sess-1");

    const second = { rawBytes: 100, visibleBytes: 100, observations: 1, updatedAt: 1_700_000_100_000 };
    expect(writeObservationPressureFile(ws, "sess-2", second)).toBe(true);
    parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
    expect(Object.keys(parsed.sessions).sort()).toEqual(["sess-1", "sess-2"]);

    expect(writeObservationPressureFile(undefined, "sess-1", first)).toBe(false);
    expect(writeObservationPressureFile(ws, undefined, first)).toBe(false);
  });

  it("is wired into the session/event tool/result branch (projection settles + persists)", async () => {
    const home = makeIsolatedConfigHome();
    const ws = makeRoot("gf-u4-pressure-wire-");
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const ctx = {
      skills: { register: () => undefined },
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers[event] = handler;
      },
    };
    const packedOut = JSON.stringify({
      data: {
        handle: "gfo:0123456789abcdef",
        sha: "0123456789abcdef",
        sizeBytes: 9000,
        lines: 9,
        head: "HEAD",
        tail: "TAIL",
      },
    });
    const makeFakeChild = (stdoutText: string) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      queueMicrotask(() => {
        child.stdout.emit("data", stdoutText);
        child.stdout.emit("end");
        child.stderr.emit("end");
        child.emit("exit", 0);
      });
      return child;
    };
    const fakeSpawn = ((_bin: string, _args: string[], _opts?: unknown) =>
      makeFakeChild(packedOut)) as unknown as typeof import("node:child_process").spawn;

    const calls: Array<{ type: string; intent?: { surfaceOp?: { op: string } } }> = [];
    const session = {
      id: "sess-u4",
      header: { cwd: ws },
      append: (type: string, _data: unknown, intent?: { surfaceOp?: { op: string } }) => {
        calls.push({ type, intent });
        return { seq: 999 };
      },
    };
    apply(ctx, { cwd: ws, spawn: fakeSpawn, env: { GRAPHFLOW_CONFIG_HOME: home } });
    expect(typeof handlers["session/event"]).toBe("function");

    handlers["session/event"]?.(
      session,
      {
        type: "tool/result",
        seq: 7,
        data: {
          message: {
            content: [
              { type: "tool-result", content: [{ type: "text", text: "y".repeat(9000) }] },
            ],
          },
        },
      } as never
    );
    // The projection + settle chain is async; give the fake child a tick.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls.length).toBe(1);
    expect(calls[0]?.type).toBe("tool/result");
    expect(calls[0]?.intent?.surfaceOp?.op).toBe("replace");

    const file = join(ws, ".graphflow", "observation-pressure.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      sessions: Record<string, { rawBytes: number; visibleBytes: number; observations: number }>;
    };
    const entry = parsed.sessions["sess-u4"];
    expect(entry).toBeDefined();
    expect(entry.rawBytes).toBe(9000);
    expect(entry.visibleBytes).toBeGreaterThan(0);
    expect(entry.visibleBytes).toBeLessThan(9000);
    expect(entry.observations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// U4-3: oversized preview text copies pack (recallable) before the stub fallback
// ---------------------------------------------------------------------------

describe("U4-3 oversized graphflow_context preview text copy packs into the observation store", () => {
  const bigQuery = "find the anchor " + "context pressure supply ".repeat(600);

  it("replaces the oversized text copy with a handle projection and keeps the full structuredContent", async () => {
    const root = makeRoot("gf-u4-pack-");
    const configPath = writeGraphFlowConfig(root, undefined);
    const response = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir: root, configPath, query: bigQuery, recordDialogue: false },
    });

    const structured = response.structuredContent as unknown as ContextPreviewResult & {
      observationHandle?: string;
    };
    // The stable face really was oversized before packing:
    expect(
      Buffer.byteLength(JSON.stringify(renderStablePreviewTextCopy(structured)), "utf8")
    ).toBeGreaterThan(8192);

    const textCopy = response.content[0]?.text ?? "";
    expect(textCopy).toContain("[graphflow observation context-preview]");
    expect(textCopy).toContain("handle=gfo:");
    expect(textCopy).toContain("(recall exact bytes with graphflow_context handle=");
    expect(Buffer.byteLength(textCopy, "utf8")).toBeLessThan(4096);

    expect(structured.observationHandle).toMatch(/^gfo:[0-9a-f]{16}$/);
    expect(structured.observationHandle && textCopy).toContain(structured.observationHandle);
    // structuredContent keeps the full result (query echo intact):
    expect(structured.query).toBe(bigQuery);

    // The packed bytes are recallable exactly:
    const recalled = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir: root, configPath, handle: structured.observationHandle },
    });
    const recall = recalled.structuredContent as { expired?: boolean; content?: string };
    expect(recall.expired).toBe(false);
    expect(JSON.parse(recall.content ?? "")).toMatchObject({ query: bigQuery });
  });

  it("falls back to the existing auto-stub when the pack fails (no error, no handle)", async () => {
    const root = makeRoot("gf-u4-pack-fail-");
    // maxStoreBytes=1 makes every pack fail content-too-large while staying a
    // positive (schema-valid) number.
    const configPath = writeGraphFlowConfig(root, { observations: { maxStoreBytes: 1 } }, {
      mcp: { textCopy: "auto" },
    });
    const response = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir: root, configPath, query: bigQuery, recordDialogue: false },
    });

    const textCopy = response.content[0]?.text ?? "";
    expect(textCopy).toContain('"stub":true');
    expect(textCopy).not.toContain("[graphflow observation");
    const structured = response.structuredContent as unknown as { observationHandle?: string; query?: string };
    expect(structured.observationHandle).toBeUndefined();
    expect(structured.query).toBe(bigQuery);
  });

  it("does not pack when observations are disabled by settings (switch gates this path too)", async () => {
    const root = makeRoot("gf-u4-pack-disabled-");
    const configPath = writeGraphFlowConfig(root, { observations: { enabled: false } }, {
      mcp: { textCopy: "auto" },
    });
    const response = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir: root, configPath, query: bigQuery, recordDialogue: false },
    });

    const textCopy = response.content[0]?.text ?? "";
    expect(textCopy).toContain('"stub":true');
    expect(textCopy).not.toContain("[graphflow observation");
    expect(
      (response.structuredContent as unknown as { observationHandle?: string }).observationHandle
    ).toBeUndefined();
  });

  it("leaves small previews untouched (no pack below the inline threshold)", async () => {
    const root = makeRoot("gf-u4-pack-small-");
    const configPath = writeGraphFlowConfig(root, undefined);
    const response = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir: root, configPath, query: "small demo query", recordDialogue: false },
    });

    const textCopy = response.content[0]?.text ?? "";
    expect(textCopy.startsWith('{"query"')).toBe(true);
    expect(textCopy).not.toContain("[graphflow observation");
    expect(
      (response.structuredContent as unknown as { observationHandle?: string }).observationHandle
    ).toBeUndefined();
  });
});
