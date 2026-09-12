import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shellQuote } from "./claude-code-hooks";

export interface NestedHookHandler {
  type: "command";
  command: string;
  name?: string;
  timeout?: number;
  statusMessage?: string;
}

export interface NestedHookGroup {
  matcher?: string;
  hooks: NestedHookHandler[];
}

export type NestedHooksByEvent = Record<string, NestedHookGroup[]>;

export interface NestedMergeResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

function handlerCommands(hooks: unknown): string[] {
  if (!hooks || typeof hooks !== "object") return [];
  const commands: string[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const handlers = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command =
          handler && typeof handler === "object"
            ? (handler as { command?: unknown }).command
            : undefined;
        if (typeof command === "string") commands.push(command);
      }
    }
  }
  return commands;
}

export function nestedHooksReferenceScript(raw: string, scriptPath: string): boolean {
  const quoted = shellQuote(scriptPath);
  try {
    const parsed = JSON.parse(raw) as { hooks?: unknown };
    if (parsed.hooks) {
      for (const command of handlerCommands(parsed.hooks)) {
        if (command.includes(scriptPath) || command.includes(quoted)) return true;
      }
    }
  } catch {
    // fall through to raw substring checks for partially written files
  }
  return raw.includes(scriptPath) || raw.includes(quoted);
}

export function mergeNestedHooks(
  configPath: string,
  groups: NestedHooksByEvent,
  extraTopLevel: Record<string, unknown> = {}
): NestedMergeResult {
  const existed = existsSync(configPath);
  let json: Record<string, unknown>;
  if (existed) {
    try {
      json = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      return {
        status: "error",
        filePath: configPath,
        message: "existing config is not valid JSON; refusing to overwrite",
      };
    }
  } else {
    json = {};
  }

  const existingHooks =
    json.hooks && typeof json.hooks === "object"
      ? { ...(json.hooks as Record<string, unknown>) }
      : {};

  for (const [event, newGroups] of Object.entries(groups)) {
    const existingGroups = Array.isArray(existingHooks[event])
      ? (existingHooks[event] as unknown[]).slice()
      : [];
    const existingCommands = new Set(
      existingGroups.flatMap((group) =>
        Array.isArray((group as { hooks?: unknown } | undefined)?.hooks)
          ? ((group as { hooks: Array<{ command?: unknown }> }).hooks
              .map((handler) => handler.command)
              .filter((command): command is string => typeof command === "string"))
          : []
      )
    );
    for (const group of newGroups) {
      const handlers = group.hooks.filter((handler) => !existingCommands.has(handler.command));
      if (handlers.length === 0) continue;
      const merged: NestedHookGroup = { hooks: handlers };
      if (group.matcher !== undefined) merged.matcher = group.matcher;
      existingGroups.push(merged);
      for (const handler of handlers) existingCommands.add(handler.command);
    }
    existingHooks[event] = existingGroups;
  }

  const next: Record<string, unknown> = { ...extraTopLevel, ...json, hooks: existingHooks };
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  if (existed && readFileSync(configPath, "utf8") === payload) {
    return { status: "skipped", filePath: configPath, message: "already up to date" };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, payload, "utf8");
  return {
    status: existed ? "updated" : "created",
    filePath: configPath,
    message: `hooks installed (${Object.keys(groups).join(", ")})`,
  };
}

export function removeNestedHooks(
  configPath: string,
  events: readonly string[],
  scriptPath: string
): { result: NestedMergeResult; removed: boolean } {
  if (!existsSync(configPath)) {
    return { result: { status: "skipped", filePath: configPath, message: "config not found" }, removed: false };
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { result: { status: "error", filePath: configPath, message: "config is not valid JSON" }, removed: false };
  }

  const hooks =
    json.hooks && typeof json.hooks === "object"
      ? (json.hooks as Record<string, unknown>)
      : {};
  const quoted = shellQuote(scriptPath);
  const matches = (command: unknown): boolean =>
    typeof command === "string" && (command.includes(scriptPath) || command.includes(quoted));

  let removed = false;
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const keptGroups: unknown[] = [];
    for (const group of groups) {
      const handlers = Array.isArray((group as { hooks?: unknown } | undefined)?.hooks)
        ? (group as { hooks: unknown[] }).hooks
        : [];
      const kept = handlers.filter((handler) => !matches((handler as { command?: unknown })?.command));
      if (kept.length !== handlers.length) removed = true;
      if (kept.length > 0) {
        keptGroups.push({ ...(group as object), hooks: kept });
      }
    }
    if (keptGroups.length > 0) hooks[event] = keptGroups;
    else delete hooks[event];
  }

  const next: Record<string, unknown> = { ...json, hooks };
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    result: {
      status: removed ? "updated" : "skipped",
      filePath: configPath,
      message: removed ? "hooks removed" : "no graphflow hooks present",
    },
    removed,
  };
}

export function removeHookScript(scriptPath: string): void {
  if (!existsSync(scriptPath)) return;
  try {
    rmSync(scriptPath, { force: true });
  } catch {
    // script removal must not block uninstall
  }
}
