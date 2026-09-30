import { createHash } from "node:crypto";
import type {
  ContextStateFacts,
  EnvironmentStateFacts,
  ProjectStateFacts,
  TaskFingerprint,
} from "./domain.js";

/**
 * Four-track task fingerprint (2.x plan §8): one hash per state track so the
 * reuse engine can tell WHAT changed, not only THAT something changed.
 * 四轨任务指纹（§8）：语义 / 项目 / 上下文 / 环境各占一轨，任何一轨的事实
 * 变化只改自己那一轨的 hash —— 复用引擎据此区分"变了什么"而不只是"变了"。
 *
 * Pure and deterministic: identical inputs → identical output. Record-typed
 * facts (relevantFileHashes, toolVersions) are canonicalized with sorted keys,
 * so key insertion order never leaks into a hash.
 * 纯函数且确定性：相同输入必得相同输出；record 字段按 key 排序后入哈希，
 * 插入顺序不影响结果。
 */

export interface FingerprintInput {
  task: string;
  project: ProjectStateFacts;
  context?: ContextStateFacts;
  environment?: EnvironmentStateFacts;
}

/** Semantic-track normalization: trim, collapse whitespace, lowercase. 语义轨归一化。 */
export function normalizeSemanticTask(task: string): string {
  return task.trim().replace(/\s+/g, " ").toLowerCase();
}

/** sha256 hex, first 16 chars — enough discrimination for the reuse engine. */
function shortSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/** gitHead + workingTreeHash + sorted relevantFileHashes + dependencyLockHash. */
function canonicalProject(project: ProjectStateFacts): string {
  const files = Object.keys(project.relevantFileHashes)
    .sort()
    .map((file) => `${file}=${project.relevantFileHashes[file] ?? ""}`);
  return JSON.stringify([
    project.gitHead ?? "",
    project.workingTreeHash ?? "",
    files,
    project.dependencyLockHash ?? "",
  ]);
}

/** graphVersion + contextPolicyVersion + workingSetHash (empty when absent). */
function canonicalContext(context: ContextStateFacts | undefined): string {
  return JSON.stringify([
    context?.graphVersion ?? "",
    context?.contextPolicyVersion ?? "",
    context?.workingSetHash ?? "",
  ]);
}

/** sorted toolVersions + runtimeVersion + selectedProvider + dynamicStateFingerprint. */
function canonicalEnvironment(environment: EnvironmentStateFacts | undefined): string {
  const toolVersions = environment?.toolVersions ?? {};
  const tools = Object.keys(toolVersions)
    .sort()
    .map((tool) => `${tool}=${toolVersions[tool] ?? ""}`);
  return JSON.stringify([
    tools,
    environment?.runtimeVersion ?? "",
    environment?.selectedProvider ?? "",
    environment?.dynamicStateFingerprint ?? "",
  ]);
}

/**
 * Build the four-track fingerprint. The reuse engine's primary key is
 * `reuseKey` = the four hashes joined with "|".
 * 构建四轨指纹；reuseKey 为四轨哈希以 "|" 连接，是复用引擎的主键。
 */
export function buildTaskFingerprint(input: FingerprintInput): TaskFingerprint {
  const semanticTaskHash = shortSha256(normalizeSemanticTask(input.task));
  const projectStateHash = shortSha256(canonicalProject(input.project));
  const contextStateHash = shortSha256(canonicalContext(input.context));
  const environmentStateHash = shortSha256(canonicalEnvironment(input.environment));
  return {
    semanticTaskHash,
    projectStateHash,
    contextStateHash,
    environmentStateHash,
    reuseKey: `${semanticTaskHash}|${projectStateHash}|${contextStateHash}|${environmentStateHash}`,
  };
}
