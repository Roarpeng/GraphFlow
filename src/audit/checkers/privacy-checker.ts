/**
 * R7-d privacy audit — verifiable local-first facts (see docs/threat-model.md).
 *
 * Lists every known on-disk artifact path (exists/missing), every network
 * endpoint (with the condition that triggers it — none required without
 * config), the global config path + POSIX mode, and which providers have a
 * key configured (boolean only, values never read). Existence checks +
 * disclosure constants only; no intent guessing.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PrivacyAuditFacts } from "../types.js";

const WORKSPACE_ARTIFACTS = [
  "graphflow-out/graphflow-graph.sqlite",
  "graphflow-out/graphflow-graph.json",
  "graphflow-out/vectors.db",
  "graphflow-out/learning-dataset.jsonl",
  "graphflow-out/learning-events.jsonl",
  "graphflow-out/learning-summary.json",
  "graphflow-out/efficiency.json",
  "graphflow-out/context-fidelity.json",
  ".graphflow/observations/index.jsonl",
  ".graphflow/session-journal.jsonl",
  ".graphflow-cache",
] as const;

const NETWORK_ENDPOINTS: PrivacyAuditFacts["endpoints"] = [
  { url: "https://api.deepseek.com", requiredWithoutConfig: false, when: "deepseek provider configured" },
  { url: "https://api.openai.com/v1", requiredWithoutConfig: false, when: "openai provider configured" },
  { url: "https://api.anthropic.com", requiredWithoutConfig: false, when: "anthropic provider configured" },
  { url: "https://dashscope.aliyuncs.com", requiredWithoutConfig: false, when: "bailian provider configured" },
  { url: "https://ark.cn-beijing.volces.com", requiredWithoutConfig: false, when: "doubao provider configured" },
  { url: "HuggingFace Hub (HF_ENDPOINT mirrorable)", requiredWithoutConfig: false, when: "first embedding-model download only" },
];

const PROVIDER_ENV_VARS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DASHSCOPE_API_KEY",
  "BAILIAN_API_KEY",
  "ARK_API_KEY",
] as const;

export function collectPrivacyFacts(
  root: string,
  options?: {
    globalConfigPath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }
): PrivacyAuditFacts {
  const env = options?.env ?? process.env;
  const existingPaths: string[] = [];
  const missingPaths: string[] = [];
  for (const rel of WORKSPACE_ARTIFACTS) {
    try {
      if (existsSync(join(root, rel))) existingPaths.push(rel);
      else missingPaths.push(rel);
    } catch {
      missingPaths.push(rel);
    }
  }

  const globalPath = options?.globalConfigPath ?? join(homedir(), ".graphflow.config.json");
  let globalExists = false;
  let mode: string | undefined;
  try {
    globalExists = existsSync(globalPath);
    if (globalExists) {
      try {
        const st = statSync(globalPath);
        mode = `0${(st.mode & 0o777).toString(8)}`;
      } catch {
        mode = undefined;
      }
    }
  } catch {
    globalExists = false;
  }

  const configuredProviders = PROVIDER_ENV_VARS.filter(
    (name) => typeof env[name] === "string" && (env[name] as string).trim().length > 0
  );

  // The documented invariant is a 0600 global config (docs/threat-model.md,
  // disclosure `api_keys[].storage: "file-0600"`). Reporting the mode without
  // judging it let stale 0644/0666 files pass silently — the audit now flags
  // them. POSIX-only: Windows modes are not owner/group/other bitmasks.
  const warnings: string[] = [];
  const platform = options?.platform ?? process.platform;
  if (globalExists && mode !== undefined && platform !== "win32" && mode !== "0600") {
    warnings.push(
      `global-config-mode: ${globalPath} is ${mode}, expected 0600 — run chmod 600 on it (this file may hold provider API keys; see docs/threat-model.md)`
    );
  }

  return {
    existingPaths,
    missingPaths,
    endpoints: NETWORK_ENDPOINTS.map((e) => ({ ...e })),
    globalConfig: {
      path: globalPath,
      exists: globalExists,
      ...(mode !== undefined ? { mode } : {}),
    },
    configuredProviders: [...configuredProviders],
    anyKeyConfigured: configuredProviders.length > 0,
    warnings,
  };
}

export function formatPrivacyFacts(facts: PrivacyAuditFacts): string {
  const lines = [
    `artifacts: ${facts.existingPaths.length} present, ${facts.missingPaths.length} absent`,
    `network: ${facts.endpoints.length} known endpoints, ${facts.endpoints.filter((e) => e.requiredWithoutConfig).length} required without config`,
    `globalConfig: ${facts.globalConfig.path} (${facts.globalConfig.exists ? `exists${facts.globalConfig.mode ? `, mode ${facts.globalConfig.mode}` : ""}` : "absent"})`,
    `providers: ${facts.anyKeyConfigured ? facts.configuredProviders.join(",") : "none configured (fully offline)"}`,
    ...(facts.warnings.length > 0 ? [`warnings: ${facts.warnings.length}`] : []),
  ];
  return lines.join("; ");
}
