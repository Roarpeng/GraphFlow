import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveConfig } from "../../../config/resolve";
import { createGraphClient } from "../../../graph/client-factory";
import {
  type GraphArtifactData,
  approveGraphNode,
  applyRetentionPolicy,
  mergeGraphArtifacts,
  propagateQuarantine,
  signArtifact,
  verifyArtifactSignature,
} from "../../../graph/team-governance";
import {
  buildRequirementTraceability,
  listKnowledgeReviewQueue,
  upsertKnowledgeNode,
  type KnowledgeGovernanceInput,
} from "../../../graph/engineering-knowledge";
import { exportGraphArtifact, importGraphArtifact } from "../../../graph/artifact-manager";
import {
  getContextFidelityStats,
} from "../../../graph/token-savings";
import { getFlywheelReport } from "./graph";
import { decryptJson, encryptJson } from "../../../security/secure-store";

export { verifyArtifactSignature };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function upsertKnowledge(configPath: string | undefined, input: KnowledgeGovernanceInput) {
  const client = createGraphClient(resolveConfig(configPath));
  return upsertKnowledgeNode(client, input);
}

export async function listKnowledgeQueue(configPath?: string) {
  const client = createGraphClient(resolveConfig(configPath));
  return listKnowledgeReviewQueue(client.readSnapshot?.().nodes ?? []);
}

export async function reviewKnowledge(
  configPath: string | undefined,
  nodeId: string,
  role: string,
  decision: "approved" | "rejected",
  reason?: string
) {
  const client = createGraphClient(resolveConfig(configPath));
  return approveGraphNode(client, nodeId, role, decision, reason);
}

export async function traceRequirement(configPath: string | undefined, requirementId: string) {
  const client = createGraphClient(resolveConfig(configPath));
  return buildRequirementTraceability(client, requirementId);
}

export function mergeArtifactFiles(basePath: string, localPath: string, remotePath: string) {
  return mergeGraphArtifacts(
    readJson(basePath) as GraphArtifactData,
    readJson(localPath) as GraphArtifactData,
    readJson(remotePath) as GraphArtifactData
  );
}

export function writeMergedArtifact(outputPath: string, artifact: unknown): string {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2), "utf8");
  return outputPath;
}

export function signArtifactFile(inputPath: string, secret: string) {
  const payload = readJson(inputPath);
  return signArtifact(payload, secret);
}

export function createSignedArtifactFile(
  configPath: string | undefined,
  outputPath: string,
  secret: string,
  includeEpisodes = true
) {
  const temp = mkdtempSync(join(tmpdir(), "graphflow-signed-"));
  try {
    const plainPath = join(temp, "artifact.json");
    const result = exportGraphArtifact(resolveConfig(configPath), plainPath, undefined, {
      compression: "none",
      includeEpisodes,
    });
    const envelope = encryptJson(readJson(plainPath), secret);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify({ ...envelope, ...result }, null, 2), "utf8");
    return { path: outputPath, sha256: result.sha256, nodeCount: result.nodeCount };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function importSignedArtifactFile(
  configPath: string | undefined,
  inputPath: string,
  passphrase: string
) {
  const envelopeRaw = readJson(inputPath) as Record<string, unknown>;
  const envelope = {
    v: envelopeRaw.v,
    alg: envelopeRaw.alg,
    salt: envelopeRaw.salt,
    iv: envelopeRaw.iv,
    tag: envelopeRaw.tag,
    ciphertext: envelopeRaw.ciphertext,
  } as Parameters<typeof decryptJson>[0];
  const artifact = decryptJson<unknown>(envelope, passphrase);
  const temp = mkdtempSync(join(tmpdir(), "graphflow-signed-import-"));
  try {
    const path = join(temp, "artifact.json");
    writeFileSync(path, JSON.stringify(artifact), "utf8");
    const client = createGraphClient(resolveConfig(configPath));
    return importGraphArtifact(resolveConfig(configPath), client, path);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function quarantineNodes(
  configPath: string | undefined,
  nodeIds: string[],
  options: { actor?: string; auditPath?: string; reason?: string } = {}
) {
  const client = createGraphClient(resolveConfig(configPath));
  return propagateQuarantine(client, nodeIds, options);
}

export function retentionSummary(configPath?: string) {
  const client = createGraphClient(resolveConfig(configPath));
  return applyRetentionPolicy(client.readSnapshot?.().nodes ?? []);
}

export interface MemoryProfileOptions {
  outputDir: string;
  command?: string;
  packageSpec?: string;
  httpUrl?: string;
  stateful?: boolean;
}

export function exportMemoryProfiles(options: MemoryProfileOptions) {
  const command = options.command ?? "npx";
  const packageSpec = options.packageSpec ?? "-y --package=@roarpeng/graphflow graphflow-mcp";
  const args = options.httpUrl
    ? ["mcp", "serve", "--http", ...(options.stateful ? ["--stateful"] : [])]
    : packageSpec.split(/\s+/).filter(Boolean);
  const server = options.httpUrl ? { type: "http", url: options.httpUrl } : {
    type: "stdio",
    command,
    args,
  };
  const profiles = {
    cursor: { mcpServers: { graphflow: server } },
    "claude-code": { mcpServers: { graphflow: server } },
    codex: `[mcp_servers.graphflow]\n${options.httpUrl ? `url = "${options.httpUrl}"` : `command = "${command}"\nargs = [${args.map((arg) => `"${arg}"`).join(", ")}"]`}\n`,
    dsh: {
      insert: [{
        id: "mcp-graphflow",
        name: "@deepseek-ai/dsh-mcp-client",
        config: {
          serverName: "graphflow",
          transport: options.httpUrl ? "http" : "stdio",
          ...(options.httpUrl ? { url: options.httpUrl } : { command, args }),
          failOnStartupError: false,
        },
      }],
    },
  };
  mkdirSync(options.outputDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries(profiles)) {
    const file = join(options.outputDir, `${name}.json`);
    writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    files[name] = file;
  }
  return files;
}

export interface ReleaseGateOptions {
  minProvenSkills: number;
  minFidelitySamples: number;
  maxPendingRatio: number;
}

export function releaseGate(
  configPath?: string,
  thresholds: ReleaseGateOptions = { minProvenSkills: 1, minFidelitySamples: 1, maxPendingRatio: 0.5 }
) {
  const report = getFlywheelReport(configPath);
  const config = resolveConfig(configPath);
  const fidelity = getContextFidelityStats(config);
  const checks = [
    { name: "proven-skills", actual: report.experience.provenSkillCount, required: thresholds.minProvenSkills },
    { name: "fidelity-samples", actual: fidelity.sampleCount, required: thresholds.minFidelitySamples },
    {
      name: "pending-ratio",
      actual: report.episodes.total === 0 ? 0 : report.episodes.pending / report.episodes.total,
      maximum: thresholds.maxPendingRatio,
    },
  ];
  const failures = checks.flatMap((check) => {
    if ("required" in check && check.actual < check.required) {
      return [`${check.name}: ${check.actual} < ${check.required}`];
    }
    if ("maximum" in check && check.actual > check.maximum) {
      return [`${check.name}: ${check.actual} > ${check.maximum}`];
    }
    return [];
  });
  if (failures.length > 0) throw new Error(`release gates failed: ${failures.join("; ")}`);
  return { report, fidelity, checks };
}
