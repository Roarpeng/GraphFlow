import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";
import { logger } from "../utils/logger";
import { parseSkillState, serializeAtomic } from "./skill-store";
import { quarantineSkillsFromEpisode } from "./workflow-skill";

/**
 * M2 — 写入门控 + 来源与撤回链。
 *
 * 依据 docs/growth-plan.md §1.2：写时门控（100%）显著优于读时过滤（8:1 干扰比下崩到 0%），
 * 且社区最痛的事故是「记忆污染」——临时决策被固化并跨会话传染、旧事实不失效。
 * 因此这个模块只做三件事，全部是确定性规则（不调 LLM、不访问网络）：
 *
 *   1. 准入判定  evaluateWriteSalience —— 复合显著性（来源可信度 / 新颖度 / 冲突 / 持久性 / 噪声）。
 *   2. 携带来源  buildProvenance      —— 每条被写入的记忆带来源 + 门控裁决，可追溯到「为什么被存」。
 *   3. 可撤回    retractMemory        —— 软撤回（打标记 + 记录 reason 与时间），绝不物理删除证据节点。
 *
 * 时间只作为报告元数据（createdAt / recordedAt / retractedAt），绝不作为主判据：
 * 陈旧处理应由确定性失效（符号/版本解析）承担，见 growth-plan §0 与 M4。
 */

/** 会流经写入门控的记忆种类。 */
export type MemoryKind = "episode" | "skill" | "dialogue" | "lesson";

/**
 * 来源可信度分类（写入门控最强信号）：
 * - human-confirmed:          人工确认（人给出的判断，最可信）
 * - executable-verification:  可执行验证（测试命令 / 构建 / 类型检查的真实结果）
 * - agent-reported:           agent 自报（§1.5：自评不可靠，只能算弱证据）
 * - unknown:                  无来源或无法识别的来源（不编造，直接降级到 review）
 */
export type WriteSourceKind =
  | "human-confirmed"
  | "executable-verification"
  | "agent-reported"
  | "unknown";

export interface WriteSource {
  kind: WriteSourceKind;
  /** 可选来源引用：测试命令、commit、episode id、会话 id 等。 */
  ref?: string;
}

export interface WriteCandidate {
  /** 已分配的节点 id（可选；用于 provenance 与自我比较排除）。 */
  id?: string;
  kind: MemoryKind;
  content: string;
  task?: string;
  source: WriteSource;
  /** false 表示临时决策 —— 门控绝不把它当作长期记忆 admit。 */
  durable?: boolean;
  /** 显式声明本写入取代的既有记忆 id（非静默覆盖的合规通道）。 */
  supersedes?: string;
  createdAt?: number;
}

/** 既有记忆的轻量视图（门控只需要判定所需的叶子字段，不持有图节点）。 */
export interface ExistingMemory {
  id: string;
  kind: MemoryKind | string;
  content: string;
  task?: string;
  createdAt?: number;
  supersedes?: string;
}

export interface GateContext {
  existing: ExistingMemory[];
  /** 可选当前时间；仅用于报告的元数据，不参与评分。 */
  now?: number;
}

export type GateDecisionKind = "admit" | "review" | "reject";

export interface GateDecision {
  decision: GateDecisionKind;
  score: number;
  reasons: string[];
  /**
   * 与候选写入互斥的既有记忆 id。冲突绝不静默覆盖，一律进 review 待人工/复核通道。
   * 仅在 reasons 含 conflict-with 时出现。
   */
  conflictWith?: string[];
}

export interface WriteGateOptions {
  /** score >= admitScore 且无硬规则触发时 admit。默认 0.55。 */
  admitScore?: number;
  /** 词元包含度 >= duplicateOverlap 视为重复（去重 reject）。默认 0.85。 */
  duplicateOverlap?: number;
  /** 任务词元包含度 >= conflictTaskOverlap 视为「同一 task」。默认 0.6。 */
  conflictTaskOverlap?: number;
  /** 去除首尾空白后短于该长度即视为噪声 reject。默认 12。 */
  minContentLength?: number;
}

export const DEFAULT_WRITE_GATE_OPTIONS: Required<WriteGateOptions> = {
  admitScore: 0.55,
  duplicateOverlap: 0.85,
  conflictTaskOverlap: 0.6,
  minContentLength: 12,
};

/**
 * 来源可信度权重。人工确认 > 可执行验证 > agent 自报；缺失/无法识别按 unknown
 * 处理并强制 review（不编造可信度）。
 */
export const SOURCE_CREDIBILITY: Record<WriteSourceKind, number> = {
  "human-confirmed": 1,
  "executable-verification": 0.75,
  "agent-reported": 0.4,
  unknown: 0.25,
};

/**
 * 稳定的 reason 码（summarizeGateStats 按 `reason.split(":")[0]` 归桶）。
 * 带 id 的 reason 形如 `duplicate-of:<id>`，因此统计不会被 id 打散。
 */
export const GATE_REASON_CODES = {
  emptyContent: "empty-content",
  contentTooShort: "content-too-short",
  duplicate: "duplicate-of",
  conflict: "conflict-with",
  temporary: "temporary-not-durable",
  lowSalience: "low-salience",
  unattributed: "unattributed-source",
  explicitSupersede: "explicit-supersede",
  evaluationFailed: "gate-evaluation-failed",
} as const;

/* ------------------------------------------------------------------ *
 * 写入模式
 * ------------------------------------------------------------------ */

/**
 * - off:      完全关闭门控（不判定、不写 gate/provenance，行为与接入前逐字节一致）。
 * - advisory: 默认。判定并把 gate 裁决 + provenance 写入节点 metadata，但不丢弃写入。
 * - enforce:  reject 的写入不落库（显式开启，见下方 README 注释）。
 *
 * 为什么默认是 advisory 而不是 enforce：growth-plan §M7 明确「原始 episode 永不删除、
 * 是一等证据」，且现有调用方对 episode 节点数量有精确断言。默认丢弃写入会同时破坏
 * 证据留存与既有语义，因此默认形态只做「判定 + 标注 + 可观测」，把丢弃留给操作者显式开启。
 */
export type WriteGateMode = "off" | "advisory" | "enforce";

export const WRITE_GATE_ENV = "GRAPHFLOW_WRITE_GATE";

/** 解析 GRAPHFLOW_WRITE_GATE：0/off/false/no → off；enforce/strict/block → enforce；其余（含未设置）→ advisory。 */
export function resolveWriteGateMode(
  value: string | undefined = process.env[WRITE_GATE_ENV]
): WriteGateMode {
  if (value === undefined) return "advisory";
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return "advisory";
  if (["0", "off", "false", "no", "disabled"].includes(normalized)) return "off";
  if (["enforce", "strict", "block"].includes(normalized)) return "enforce";
  return "advisory";
}

/* ------------------------------------------------------------------ *
 * 1) 准入判定
 * ------------------------------------------------------------------ */

/**
 * 复合显著性门控。硬规则优先于分数：
 *   1. 噪声（空 / 过短）            → reject
 *   2. 同一 task 的互斥结论          → review（绝不静默覆盖）
 *   3. 与既有记忆高度重复            → reject（去重）
 *   4. 临时决策（durable === false） → review（临时决策被固化正是社区抱怨的主因）
 *   5. 无来源                        → review（不编造可信度）
 *   6. 其余按 score 与 admitScore 决定 admit / review
 *
 * 确定性：全部由词元集合与固定词表推导，不使用时间、随机数或 LLM。
 */
export function evaluateWriteSalience(
  candidate: WriteCandidate,
  context: GateContext,
  options?: WriteGateOptions
): GateDecision {
  const admitScore = options?.admitScore ?? DEFAULT_WRITE_GATE_OPTIONS.admitScore;
  const duplicateOverlap =
    options?.duplicateOverlap ?? DEFAULT_WRITE_GATE_OPTIONS.duplicateOverlap;
  const conflictTaskOverlap =
    options?.conflictTaskOverlap ?? DEFAULT_WRITE_GATE_OPTIONS.conflictTaskOverlap;
  const minContentLength =
    options?.minContentLength ?? DEFAULT_WRITE_GATE_OPTIONS.minContentLength;

  const existing = Array.isArray(context?.existing) ? context.existing : [];
  const content = typeof candidate?.content === "string" ? candidate.content.trim() : "";
  const kind = candidate?.kind ?? "episode";
  const source = normalizeSource(candidate?.source);
  const reasons: string[] = [`source:${source.kind}`];

  // 信号 1 — 噪声：空内容或过短内容一律 reject（不写空壳记忆）。
  if (content.length === 0) {
    return decision("reject", 0, [...reasons, GATE_REASON_CODES.emptyContent]);
  }
  if (content.length < minContentLength) {
    return decision("reject", 0, [...reasons, GATE_REASON_CODES.contentTooShort]);
  }

  const candidateTokens = new Set(tokenize(content));

  // 信号 2 — 新颖度 + 信号 3 — 冲突：一次遍历既有记忆，取最大词元包含度并收集互斥结论。
  let bestOverlap = 0;
  let bestId: string | undefined;
  const conflictIds: string[] = [];
  for (const item of existing) {
    if (!item || typeof item.content !== "string") continue;
    // 自我比较没有意义（同 id 重写）。
    if (candidate?.id !== undefined && item.id === candidate.id) continue;
    const itemTokens = new Set(tokenize(item.content));
    const overlap = containment(candidateTokens, itemTokens);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestId = item.id;
    }
    if (
      sameTask(candidate?.task, item.task, conflictTaskOverlap) &&
      polaritiesConflict(content, item.content)
    ) {
      conflictIds.push(item.id);
    }
  }

  // 显式 supersedes 是合规的取代通道：被取代者不算冲突，但该写入仍需 review 确认。
  let mustReview = false;
  if (candidate?.supersedes) {
    const declared = candidate.supersedes;
    const targetExists = existing.some((item) => item && item.id === declared);
    if (targetExists) {
      reasons.push(`${GATE_REASON_CODES.explicitSupersede}:${declared}`);
      mustReview = true;
      const idx = conflictIds.indexOf(declared);
      if (idx >= 0) conflictIds.splice(idx, 1);
    }
  }

  // 信号 4 — 持久性：durable === false 的临时决策降级为 review，绝不直接 admit。
  const durable = candidate?.durable !== false;
  const durabilityScore = durable ? 1 : 0.35;
  if (!durable) {
    reasons.push(GATE_REASON_CODES.temporary);
    mustReview = true;
  }

  // 信号 5 — 无来源：source 缺失或无法识别时不允许静默入库。
  if (candidate?.source === undefined || source.kind === "unknown") {
    reasons.push(GATE_REASON_CODES.unattributed);
    mustReview = true;
  }

  // 新颖度 = 1 - 与既有记忆的最大重叠；无既有记忆时新颖度为 1。
  const novelty = 1 - bestOverlap;
  const score = round3(
    0.5 * SOURCE_CREDIBILITY[source.kind] + 0.3 * novelty + 0.2 * durabilityScore
  );

  // 冲突优先于去重：同一 task 的互斥结论即使字面几乎相同也是冲突，不是重复。
  if (conflictIds.length > 0) {
    return decision("review", score, [...reasons, GATE_REASON_CODES.conflict], conflictIds);
  }

  // 去重：与既有记忆高度重复 → reject，避免同一结论反复入库（干扰比正是这样被抬高的）。
  if (bestOverlap >= duplicateOverlap && bestId !== candidate?.supersedes) {
    return decision("reject", score, [...reasons, `${GATE_REASON_CODES.duplicate}:${bestId ?? "unknown"}`]);
  }

  if (mustReview || score < admitScore) {
    if (score < admitScore) reasons.push(GATE_REASON_CODES.lowSalience);
    return decision("review", score, reasons);
  }

  return decision("admit", score, [...reasons, "admit", `kind:${kind}`]);
}

/**
 * 永不抛出的门控入口：写路径必须容忍门控自身失败。
 * 判定失败时诚实降级为 review（既不静默 admit，也不把候选当噪声丢掉），
 * 并记录诊断日志说明「为什么这次没有判定」。
 */
export function evaluateWriteSalienceSafe(
  candidate: WriteCandidate,
  context: GateContext,
  options?: WriteGateOptions
): GateDecision {
  try {
    return evaluateWriteSalience(candidate, context, options);
  } catch (error) {
    logger.debug({ error }, "[memory-gate] write gate evaluation failed; holding for review");
    return {
      decision: "review",
      score: 0,
      reasons: [GATE_REASON_CODES.evaluationFailed],
    };
  }
}

function decision(
  kind: GateDecisionKind,
  score: number,
  reasons: string[],
  conflictWith?: string[]
): GateDecision {
  return {
    decision: kind,
    score: round3(score),
    reasons: Array.from(new Set(reasons)),
    ...(conflictWith && conflictWith.length > 0 ? { conflictWith } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 2) 来源链（provenance）
 * ------------------------------------------------------------------ */

export interface MemoryProvenance {
  /** 被描述的记忆 id（候选自带 id 时）。 */
  memoryId?: string;
  kind: MemoryKind;
  /**
   * 确定性内容指纹（djb2a）。写入后内容被改写也能判定 provenance 是否已失配。
   */
  contentHash: string;
  source: WriteSource;
  task?: string;
  durable: boolean;
  supersedes?: string;
  /** 门控裁决 —— 「为什么这条记忆被存下来」的原始记录。 */
  gate: GateDecision;
  /** provenance 生成时间：仅报告元数据，不参与评分。 */
  recordedAt: number;
  /**
   * episode 类记忆同时写 episodeId，与既有治理代码
   * （team-governance.propagateQuarantine 读 metadata.provenance.episodeId）互通。
   */
  episodeId?: string;
}

/**
 * 构造写入来源对象。返回 `{ provenance }` 以便调用方直接展开进 metadata，
 * 不覆盖其它 metadata 字段（纯增量）。
 */
export function buildProvenance(
  candidate: WriteCandidate,
  gate: GateDecision,
  now: number = Date.now()
): { provenance: MemoryProvenance } {
  const source = normalizeSource(candidate?.source);
  const durable = candidate?.durable !== false;
  const provenance: MemoryProvenance = {
    kind: candidate?.kind ?? "episode",
    contentHash: hashText(typeof candidate?.content === "string" ? candidate.content : ""),
    source: {
      kind: source.kind,
      ...(source.ref !== undefined ? { ref: source.ref } : {}),
    },
    durable,
    gate,
    recordedAt: now,
    ...(candidate?.id !== undefined ? { memoryId: candidate.id } : {}),
    ...(candidate?.task !== undefined ? { task: candidate.task } : {}),
    ...(candidate?.supersedes !== undefined ? { supersedes: candidate.supersedes } : {}),
    ...((candidate?.kind ?? "episode") === "episode" && candidate?.id !== undefined
      ? { episodeId: candidate.id }
      : {}),
  };
  return { provenance };
}

/** 归一化来源：非法/缺失 → unknown（绝不猜测、绝不编造可信度）。 */
export function normalizeSource(value: unknown): WriteSource {
  if (!value || typeof value !== "object") return { kind: "unknown" };
  const raw = value as { kind?: unknown; ref?: unknown };
  const kind: WriteSourceKind =
    raw.kind === "human-confirmed" ||
    raw.kind === "executable-verification" ||
    raw.kind === "agent-reported"
      ? raw.kind
      : "unknown";
  return {
    kind,
    ...(typeof raw.ref === "string" && raw.ref.length > 0 ? { ref: raw.ref } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 3) 撤回链（软撤回，绝不物理删除）
 * ------------------------------------------------------------------ */

export interface RetractionMarker {
  reason: string;
  /** 撤回时间：仅审计元数据。 */
  retractedAt: number;
  /** 撤回来源（固定标识这个链路由 memory-gate 维护）。 */
  source: "memory-gate";
  /** 写入时的门控裁决（若节点带 writeGate 元数据），便于复盘污染入口。 */
  gateDecision?: string;
}

export interface RetractionResult {
  found: boolean;
  id: string;
  retracted: boolean;
  /** 本次调用之前就已被撤回（幂等；保留第一次的 reason/时间作为审计轨迹）。 */
  alreadyRetracted: boolean;
  /** 因该 episode 被撤回而软隐藏的派生技能数（非 episode 恒为 0）。 */
  skillsHidden: number;
}

/** 节点 metadata 中记录的写入门控信息。 */
export interface StoredWriteGate {
  decision: GateDecisionKind;
  score: number;
  reasons: string[];
  conflictWith?: string[];
  mode?: WriteGateMode;
  evaluatedAt?: number;
}

/** 读取节点上的门控元数据（供 diagnose 统计被门控拒绝/待复核的写入数）。 */
export function readWriteGate(node: GraphNode | undefined): StoredWriteGate | undefined {
  const raw = node?.metadata?.writeGate;
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<StoredWriteGate>;
  if (
    value.decision !== "admit" &&
    value.decision !== "review" &&
    value.decision !== "reject"
  ) {
    return undefined;
  }
  return {
    decision: value.decision,
    score: typeof value.score === "number" ? value.score : 0,
    reasons: Array.isArray(value.reasons)
      ? value.reasons.filter((item): item is string => typeof item === "string")
      : [],
    ...(Array.isArray(value.conflictWith)
      ? {
          conflictWith: value.conflictWith.filter(
            (item): item is string => typeof item === "string"
          ),
        }
      : {}),
    ...(value.mode === "off" || value.mode === "advisory" || value.mode === "enforce"
      ? { mode: value.mode }
      : {}),
    ...(typeof value.evaluatedAt === "number" ? { evaluatedAt: value.evaluatedAt } : {}),
  };
}

/** 读取节点的撤回标记（不存在则 undefined）。 */
export function readRetraction(node: GraphNode | undefined): RetractionMarker | undefined {
  const raw = node?.metadata?.retraction;
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<RetractionMarker>;
  if (typeof value.reason !== "string" || value.reason.length === 0) return undefined;
  return {
    reason: value.reason,
    retractedAt: typeof value.retractedAt === "number" ? value.retractedAt : 0,
    source: "memory-gate",
    ...(typeof value.gateDecision === "string" ? { gateDecision: value.gateDecision } : {}),
  };
}

/**
 * 该记忆是否已被撤回。撤回是软标记：节点仍在图里，只是从召回路径上被隐藏。
 * 与 forgetEpisode（metadata.pruned）和 quarantineSkillsFromEpisode（skill.hidden）
 * 保持同一语义 —— 证据节点永不物理删除。
 */
export function isRetracted(node: GraphNode | undefined): boolean {
  if (!node) return false;
  if (node.metadata?.retracted === true) return true;
  return readRetraction(node) !== undefined;
}

/**
 * 软撤回一条记忆：打 `metadata.retracted` + `metadata.retraction {reason, retractedAt}`，
 * 绝不 deleteNode。复用既有软隐藏语义：
 * - episode 形态节点额外置 `metadata.pruned = true`（与 forgetEpisode 一致，
 *   使 parseEpisodes / findSimilarEpisodes 立即不再召回），并在 record.lessons 记录标记；
 * - Skill 形态节点在 content 内置 `hidden = true`（与 quarantineSkillsFromEpisode 一致）；
 * - episode 撤回时级联软隐藏其派生技能（复用 quarantineSkillsFromEpisode，不另造一套）。
 * 幂等：已撤回的节点保留第一次的 reason 与时间，仅补齐隐藏标记。
 */
export async function retractMemory(
  client: GraphClient,
  memoryId: string,
  reason: string,
  now: number = Date.now()
): Promise<RetractionResult> {
  const node = await loadMemoryNode(client, memoryId);
  if (!node) {
    return {
      found: false,
      id: memoryId,
      retracted: false,
      alreadyRetracted: false,
      skillsHidden: 0,
    };
  }

  const existingMarker = readRetraction(node);
  const alreadyRetracted = existingMarker !== undefined || node.metadata?.retracted === true;
  const gate = readWriteGate(node);
  const marker: RetractionMarker = alreadyRetracted && existingMarker
    ? existingMarker
    : {
        reason: reason.trim().length > 0 ? reason.trim() : "unspecified",
        retractedAt: now,
        source: "memory-gate",
        ...(gate ? { gateDecision: gate.decision } : {}),
      };

  const metadata: Record<string, unknown> = {
    ...node.metadata,
    retracted: true,
    retraction: marker,
  };

  // episode 形态：复用 forgetEpisode 的软删除标记，使既有召回过滤立刻生效。
  const rawRecord = node.metadata?.record;
  if (typeof rawRecord === "string") {
    const updatedRecord = markRecordRetracted(rawRecord, marker.retractedAt);
    if (updatedRecord !== undefined) {
      metadata.record = updatedRecord;
      metadata.pruned = true;
    }
  }

  await client.upsertNodes([{ ...node, metadata }]);

  // Skill 形态：与 quarantineSkillsFromEpisode 一致，在 content 内置 hidden 标记。
  if (node.type === "Skill") {
    const state = parseSkillState(node.content);
    if (state && state.hidden !== true) {
      await client.upsertNodes([
        {
          id: state.id,
          type: "Skill",
          content: serializeAtomic({ ...state, hidden: true, updatedAt: marker.retractedAt }),
        },
      ]);
    }
  }

  // 撤回链的级联：episode 被撤回 → 由它蒸馏出的技能一并软隐藏（复用既有实现）。
  let skillsHidden = 0;
  if (memoryId.startsWith("episode:")) {
    const quarantined = await quarantineSkillsFromEpisode(client, memoryId);
    skillsHidden = quarantined.hidden;
  }

  return {
    found: true,
    id: memoryId,
    retracted: true,
    alreadyRetracted,
    skillsHidden,
  };
}

async function loadMemoryNode(
  client: GraphClient,
  memoryId: string
): Promise<GraphNode | undefined> {
  if (client.getNodesByIds) {
    const nodes = await client.getNodesByIds([memoryId]);
    const direct = nodes.find((node) => node.id === memoryId);
    if (direct) return direct;
  }
  const hits = await client.queryByKeyword(memoryId);
  return hits.find((node) => node.id === memoryId);
}

/**
 * 在 episode record 上记录撤回标记：lessons 前置 "retracted"（去重、上限 4），
 * 与 forgetEpisode 前置 "forgotten" 的写法一致。解析失败则不改 record（只留 metadata 标记）。
 */
function markRecordRetracted(rawRecord: string, retractedAt: number): string | undefined {
  try {
    const parsed = JSON.parse(rawRecord) as Record<string, unknown>;
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.filter((item): item is string => typeof item === "string")
      : [];
    const nextLessons = ["retracted", ...lessons.filter((lesson) => lesson !== "retracted")].slice(
      0,
      4
    );
    return JSON.stringify({ ...parsed, lessons: nextLessons, updatedAt: retractedAt });
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 4) 门控可观测
 * ------------------------------------------------------------------ */

export interface GateStats {
  total: number;
  admitted: number;
  reviewed: number;
  rejected: number;
  /** 被 reject 的写入按 reason 码计数（id 后缀会被剥离，便于聚合）。 */
  rejectReasons: Record<string, number>;
}

/**
 * 汇总门控裁决，供 graphflow_diagnose 报出「被门控拒绝的写入数」。
 * rejectReasons 只统计 reject 的裁决，并跳过纯描述性信号码（`source:` / `kind:`），
 * 否则每次拒绝都会把来源码计入原因分布、掩盖真实拒绝原因。无数据时返回全零（不编造）。
 */
export function summarizeGateStats(decisions: GateDecision[]): GateStats {
  const stats: GateStats = {
    total: 0,
    admitted: 0,
    reviewed: 0,
    rejected: 0,
    rejectReasons: {},
  };
  for (const item of decisions) {
    if (!item) continue;
    stats.total += 1;
    if (item.decision === "admit") stats.admitted += 1;
    else if (item.decision === "review") stats.reviewed += 1;
    else {
      stats.rejected += 1;
      for (const reason of item.reasons ?? []) {
        if (typeof reason !== "string") continue;
        if (reason.startsWith("source:") || reason.startsWith("kind:")) continue;
        const code = reasonCode(reason);
        if (code.length === 0) continue;
        stats.rejectReasons[code] = (stats.rejectReasons[code] ?? 0) + 1;
      }
    }
  }
  return stats;
}

/** 剥离 `:<id>` 后缀，得到可聚合的 reason 码。 */
export function reasonCode(reason: string): string {
  if (typeof reason !== "string") return "";
  const trimmed = reason.trim();
  const idx = trimmed.indexOf(":");
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

/* ------------------------------------------------------------------ *
 * 内部工具（确定性词元/极性判定）
 * ------------------------------------------------------------------ */

/**
 * 词元化：ASCII 词（>= 3 字符，沿用 episodic-memory.extractTaskTokens 的口径）
 * + CJK 连续片段（>= 2 字符，使中文记忆也能参与去重与冲突判定）。
 */
function tokenize(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fa5]+/)) {
    if (raw.length === 0) continue;
    if (/[\u4e00-\u9fa5]/.test(raw)) {
      if (raw.length >= 2) out.add(raw);
      continue;
    }
    if (raw.length >= 3) out.add(raw);
  }
  return Array.from(out);
}

/**
 * 包含度（containment）= |A ∩ B| / min(|A|, |B|)。
 * 比 Jaccard 更适合「短写入 vs 长既有记忆」的重复判定：候选是既有记忆的子集时即为 1。
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const denominator = Math.min(a.size, b.size);
  return denominator === 0 ? 0 : intersection / denominator;
}

/** 两个 task 是否指向同一件事：task 词元包含度达到阈值（缺任一侧则无法判定，返回 false）。 */
function sameTask(
  candidateTask: string | undefined,
  existingTask: string | undefined,
  minOverlap: number
): boolean {
  if (typeof candidateTask !== "string" || typeof existingTask !== "string") return false;
  if (candidateTask.trim().length === 0 || existingTask.trim().length === 0) return false;
  const a = new Set(tokenize(candidateTask));
  const b = new Set(tokenize(existingTask));
  if (a.size === 0 || b.size === 0) return false;
  return containment(a, b) >= minOverlap;
}

/**
 * 结论极性：固定词表的确定性判定（英文按词元、中文按子串）。
 * 极性相反才构成「互斥结论」——同一 task 的 pass 与 fail、adopt 与 revert 等。
 */
const NEGATIVE_MARKERS = [
  "not",
  "never",
  "no",
  "avoid",
  "revert",
  "reverted",
  "remove",
  "removed",
  "disable",
  "disabled",
  "fail",
  "failed",
  "failure",
  "incorrect",
  "wrong",
  "invalid",
  "reject",
  "rejected",
  "broken",
  "deprecated",
];

const POSITIVE_MARKERS = [
  "pass",
  "passed",
  "success",
  "succeeded",
  "works",
  "working",
  "correct",
  "valid",
  "adopt",
  "adopted",
  "enable",
  "enabled",
  "keep",
  "kept",
  "recommended",
  "prefer",
  "保留",
  "采用",
  "启用",
  "通过",
  "成功",
  "正确",
  "有效",
];

const NEGATIVE_CJK_MARKERS = ["不要", "禁止", "避免", "移除", "回滚", "失败", "错误", "无效"];

function polaritiesConflict(a: string, b: string): boolean {
  const left = conclusionPolarity(a);
  const right = conclusionPolarity(b);
  return left !== "unknown" && right !== "unknown" && left !== right;
}

function conclusionPolarity(content: string): "positive" | "negative" | "unknown" {
  const tokens = new Set(tokenize(content));
  let negative = 0;
  let positive = 0;
  for (const marker of NEGATIVE_MARKERS) {
    if (tokens.has(marker)) negative += 1;
  }
  for (const marker of POSITIVE_MARKERS) {
    if (tokens.has(marker)) positive += 1;
  }
  for (const marker of NEGATIVE_CJK_MARKERS) {
    if (content.includes(marker)) negative += 1;
  }
  if (negative > positive) return "negative";
  if (positive > negative) return "positive";
  return "unknown";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
