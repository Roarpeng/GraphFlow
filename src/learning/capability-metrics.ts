/**
 * 能力指标与能力地图（growth-plan M1 / M3 度量部分 / M5 / M11）。
 *
 * 动机（growth-plan §2.2）：GraphFlow 原先对外的核心指标是 token 节省率，但证据
 * 表明该口径作为核心指标是错的——削减 38.4% 工具输出 token 后计费成本反而 +6.8%
 * （每任务相关 r=0.15），激进压缩把 SWE-bench Go 子集的 patch 成功率从 27/40 打到
 * 15/40（arXiv:2607.12161）。因此本模块把能力侧指标换成 SWE-Bench-CL 已经定义好的
 * 持续学习维度套件（平均准确率 / 遗忘 / 前向迁移 / 工具使用效率 / 复合分数，
 * arXiv:2507.00014），并补上本领域最缺的"技能有效使用精度"。token 节省率降为
 * 成本约束项，刻意不进入能力复合分。
 *
 * 三条不可让渡的纪律：
 * 1. 纯确定性：不调用 LLM、不访问网络。时间只用于"按时间序排序"和"最近验证时间"
 *    这类元数据，从不作为主判据（确定性优先，growth-plan §5.5）。
 * 2. 诚实优先（growth-plan §5、硬约束 7）：样本不足时返回 insufficientData 并把能力
 *    比率归零，绝不回填演示数据、绝不用 NaN 或 Infinity 表达"不知道"。
 * 3. 单文件零依赖：只依赖本文件内的纯函数。对外暴露由 graphflow_diagnose 的输出
 *    接线完成，本模块不新增任何 MCP 工具、不改动其它模块。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 一 · 输入契约
// ─────────────────────────────────────────────────────────────────────────────

/** episode 定论状态，与 episodic-memory 的 EpisodeRecord.outcome 保持结构兼容。 */
export type CapabilityOutcome = "pass" | "fail" | "human_review" | "pending";

/**
 * 指标计算所需的最小 episode 形状。
 *
 * EpisodeRecord 结构上满足本接口（id/outcome/attempts/createdAt 均为其必填字段），
 * 因此调用方可以直接把 loadAllEpisodes() 的结果传进来，无需适配层。这里不 import
 * EpisodeRecord，是为了让本模块保持零依赖、可被单独接线与单独测试。
 */
export interface CapabilityEpisode {
  id: string;
  outcome: CapabilityOutcome;
  /** 外部 agent 自报的尝试次数；仅用于返工率与工具使用效率的分母。 */
  attempts: number;
  /** 记录时间（epoch ms）。只用于时间序与"最近验证时间"，不作为主判据。 */
  createdAt: number;
  /** 最近更新时间（epoch ms）。用于同一 id 重复出现时选取最新修订。 */
  updatedAt?: number;
  /** 任务域/语言；缺失时归入 UNCLASSIFIED_DOMAIN，不猜测、不推断。 */
  domain?: string;
}

/** 内部三分类：human_review 与 pending 都属于"未定论"，不构成成功证据。 */
type DecidedOutcome = "pass" | "fail" | "undecided";

interface NormalizedEpisode {
  id: string;
  outcome: DecidedOutcome;
  attempts: number;
  createdAt: number;
  /** updatedAt ?? createdAt：同一 id 取修订更新的一条。 */
  revision: number;
  domain: string;
}

/** 运行时可能来自 JSON 解析的松散字段（类型断言无法保护真实数据）。 */
interface RawEpisode {
  id?: unknown;
  outcome?: unknown;
  attempts?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  domain?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// 二 · 公开常量（预注册阈值，避免阈值散落在调用点）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "已定论"样本下限：pass+fail 少于该值时不下任何能力结论。
 * 5 是工程下限而不是统计功效计算——小样本下任何一个 episode 翻转都会主导比率，
 * 与其报一个会被误读的数字，不如显式说不确定。
 */
export const MIN_RESOLVED_SAMPLES = 5;

/** domain 晋级 verified 所需的最少已定论样本数（M5 的 n >= k）。 */
export const MIN_DOMAIN_SAMPLES = 5;

/** domain 晋级 verified 所需的成功率下限（M5 的阈值，由 harness 外部强制）。 */
export const MIN_DOMAIN_PASS_RATE = 0.6;

/** 无 domain 字段的 episode 归入的桶名（显式未分类，不假装成某个真实域）。 */
export const UNCLASSIFIED_DOMAIN = "unclassified";

/**
 * M5 的任务域规则表：有序、首命中优先、纯字符串包含匹配。
 *
 * 为什么把领域切分写成确定性规则，而不是让模型判断：growth-plan 的两条纪律要求它
 * ——§5.5「确定性优先」（任何时效/分类判断优先用确定性规则），§1.5（模型会系统性
 * 误判自身边界，校准不等于行动）。能力地图的唯一切分键如果本身不确定，地图就不可
 * 复现、不可比较，也就无法用来回答"哪一类工作我从未验证过"。
 *
 * 这张表刻意粗粒度：它要回答的是"哪一类工作在反复失败 / 从未被验证"，不是精确的
 * 技术栈画像。规则顺序即优先级，命中即返回，所以更具体的语言名要排在更泛的关键词
 * 之前（例如 javascript 必须排在 java 之前，否则 "javascript" 会被判成 java）。
 */
const DOMAIN_RULES: ReadonlyArray<{ domain: string; needles: readonly string[] }> = [
  { domain: "typescript", needles: [".tsx", ".ts", "typescript"] },
  { domain: "javascript", needles: [".jsx", ".js", "javascript", "node.js"] },
  { domain: "python", needles: [".py", "python"] },
  { domain: "rust", needles: [".rs", "rust", "cargo"] },
  { domain: "go", needles: [".go", "golang"] },
  { domain: "java", needles: [".java", "java"] },
  { domain: "kotlin", needles: [".kt", "kotlin"] },
  { domain: "swift", needles: [".swift", "swift"] },
  { domain: "ruby", needles: [".rb", "ruby"] },
  { domain: "csharp", needles: [".cs", "c#", "csharp"] },
  { domain: "cpp", needles: [".cpp", ".hpp", ".cc", "c++"] },
  { domain: "sql", needles: [".sql", "sql"] },
  { domain: "xml", needles: [".xml", "plcopen"] },
  // 以下是跨语言的工作类型，排在语言之后，避免抢走语言标签。
  { domain: "security", needles: ["security", "security-audit", "cve", "安全", "脱敏"] },
  { domain: "ci", needles: [".yml", ".yaml", "workflow", "github actions", "流水线", "发布链"] },
  { domain: "release", needles: ["changelog", "release", "发版", "版本号", "npm publish"] },
  { domain: "docs", needles: [".md", "readme", "文档", "注释"] },
  { domain: "memory", needles: ["memory", "记忆", "episode", "skill", "技能", "flywheel", "飞轮"] },
  { domain: "graph", needles: ["graph", "图谱", "索引", "index", "召回", "检索"] },
  { domain: "test", needles: ["test", "测试", "vitest", "regression", "回归"] },
  { domain: "build", needles: ["build", "编译", "tsc", "构建", "打包"] },
];

/**
 * 由 episode 的 task 文本推导一个粗粒度领域标签（M5 的 domainOf 实现）。
 *
 * 未命中任何规则时返回 UNCLASSIFIED_DOMAIN —— 显式未分类，不去猜一个更"好看"的桶。
 * 未分类本身是有用的信号：它意味着这些 episode 还没有可用的领域切分依据。
 */
export function deriveTaskDomain(task: string): string {
  if (typeof task !== "string") return UNCLASSIFIED_DOMAIN;
  const haystack = task.toLowerCase();
  if (!haystack.trim()) return UNCLASSIFIED_DOMAIN;
  for (const rule of DOMAIN_RULES) {
    for (const needle of rule.needles) {
      if (haystack.includes(needle)) return rule.domain;
    }
  }
  return UNCLASSIFIED_DOMAIN;
}

/**
 * 复合分权重默认值。
 *
 * 取舍理由（这是判断，不是测量，必须随分维度一起上报）：
 * - passRate 0.4：一次通过率是最接近"能力"的证据，权重最高。
 * - retention 0.2：遗忘会静默吃掉已有能力，必须与准确率同权可见。
 * - forwardTransferRate 0.2：新域首次即成，是"学到的是原则而非个例"的唯一信号。
 * - toolUseEfficiency 0.1：效率是能力的调节项而非目标，权重压低。
 * - rework 0.1：返工同样压低权重，避免用"多试几次总能过"换分数。
 * 注意 token 节省率被刻意排除：它是成本约束项（§2.2），不是能力维度。
 */
export const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeights = {
  passRate: 0.4,
  retention: 0.2,
  forwardTransferRate: 0.2,
  toolUseEfficiency: 0.1,
  rework: 0.1,
};

/** 复合分的五个分维度权重（总和不必为 1，计算时按权重和归一化）。 */
export interface CompositeWeights {
  passRate: number;
  /** retention = 1 - forgettingRate。 */
  retention: number;
  forwardTransferRate: number;
  toolUseEfficiency: number;
  /** rework = 1 - min(1, reworkRate)。 */
  rework: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 三 · 基础工具（全部夹在 [0,1]，保证异常输入不产生 NaN/Infinity）
// ─────────────────────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 比率 = numerator / denominator，分母为 0 或输入非法时返回 0。
 * 结果一律夹到 [0,1]：定义上这些都是比例，越界只可能来自坏输入，
 * 此时宁可压回边界也不要放大成一个看起来更好的数字。
 */
function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
  if (!(denominator > 0)) return 0;
  return clamp01(numerator / denominator);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.trunc(value);
  }
  return fallback;
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  return fallback;
}

function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function normalizeOutcome(value: unknown): DecidedOutcome {
  if (value === "pass") return "pass";
  if (value === "fail") return "fail";
  // pending / human_review / 无法识别的取值都归入未定论：保守方向是永不抬高 passRate。
  return "undecided";
}

function normalizeAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

/** 按 codepoint 比较，避免 locale 相关的排序差异（可复现性要求）。 */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 四 · 归一化：去重 + 域切分
// ─────────────────────────────────────────────────────────────────────────────

function resolveDomain(
  raw: RawEpisode,
  domainOf?: (episode: CapabilityEpisode) => string
): string {
  if (domainOf) {
    try {
      const value = domainOf(raw as unknown as CapabilityEpisode);
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // 切分回调抛错时退回未分类桶：诊断输出宁可少一个域，也不能整体失败。
    }
    return UNCLASSIFIED_DOMAIN;
  }
  return typeof raw.domain === "string" && raw.domain.trim()
    ? raw.domain.trim()
    : UNCLASSIFIED_DOMAIN;
}

/**
 * 把外部输入归一化为可统计的 episode 列表。
 *
 * - 同一 id 重复出现时取 revision（updatedAt ?? createdAt）更大的一条：
 *   updateEpisodeOutcome 会重写记录，后写的状态才是该 episode 的真相。
 * - 没有 id 的记录直接丢弃：既无法去重也无法溯源，替它编一个 id 就是造假。
 */
function normalizeEpisodes(
  episodes: readonly CapabilityEpisode[],
  domainOf?: (episode: CapabilityEpisode) => string
): NormalizedEpisode[] {
  const byId = new Map<string, NormalizedEpisode>();
  for (const candidate of episodes as readonly unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as RawEpisode;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) continue;
    const createdAt = normalizeTimestamp(raw.createdAt);
    const updatedAt =
      raw.updatedAt === undefined ? createdAt : normalizeTimestamp(raw.updatedAt);
    const next: NormalizedEpisode = {
      id,
      outcome: normalizeOutcome(raw.outcome),
      attempts: normalizeAttempts(raw.attempts),
      createdAt,
      revision: Math.max(createdAt, updatedAt),
      domain: resolveDomain(raw, domainOf),
    };
    const existing = byId.get(id);
    // 严格大于：revision 相同时保留先出现的一条，保证结果与输入顺序无关的确定性。
    if (!existing || next.revision > existing.revision) byId.set(id, next);
  }
  return Array.from(byId.values());
}

/** 时间序（createdAt 升序，同刻按 id 升序），返回新数组，不改动输入。 */
function orderByTime(episodes: readonly NormalizedEpisode[]): NormalizedEpisode[] {
  return [...episodes].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return compareText(a.id, b.id);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 五 · CapabilityMetrics（M1）
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityMetrics {
  /** 去重后的 episode 总数（含未定论）。 */
  sampleCount: number;
  /** pass / (pass + fail)；pending 与 human_review 不进分母。 */
  passRate: number;
  /** 已定论 episode 中 attempts > 1 的占比（返工率）。 */
  reworkRate: number;
  /** 同域曾经 pass 之后，后续已定论 episode 出现 fail 的比例。 */
  forgettingRate: number;
  /** 每个 domain 首次定论即 pass 的 domain 占比。 */
  forwardTransferRate: number;
  /** 按 attempts 归一化的一次通过效率，取值 [0,1]。 */
  toolUseEfficiency: number;
  /** 上述维度的加权复合分，取值 [0,1]；权重可传入。 */
  compositeScore: number;
  /** 未定论 episode（pending + human_review）/ sampleCount。 */
  pendingRatio: number;
  /** 已定论样本不足时为 true；此时除 pendingRatio 外的比率全部归零。 */
  insufficientData: boolean;
}

export interface CapabilityMetricsOptions {
  /** domain 切分键；默认读 episode.domain，缺失归入 UNCLASSIFIED_DOMAIN。 */
  domainOf?: (episode: CapabilityEpisode) => string;
  /** 已定论样本下限，默认 MIN_RESOLVED_SAMPLES（5）。 */
  minResolvedSamples?: number;
  /** 复合分权重覆盖；未给或非法的分维度回落到默认权重。 */
  weights?: Partial<CompositeWeights>;
}

function resolveWeights(overrides?: Partial<CompositeWeights>): CompositeWeights {
  const resolved: CompositeWeights = { ...DEFAULT_COMPOSITE_WEIGHTS };
  if (!overrides) return resolved;
  for (const key of Object.keys(DEFAULT_COMPOSITE_WEIGHTS) as Array<keyof CompositeWeights>) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * 复合持续学习分数（SWE-Bench-CL composite CL score，arXiv:2507.00014）。
 * 五个分维度都在 [0,1]，先按权重和归一化再求和，因此自定义权重不必凑成 1。
 * 权重和 <= 0 时返回 0（而不是 NaN）：全零权重意味着"没有定义任何偏好"。
 */
function computeCompositeScore(
  components: {
    passRate: number;
    retention: number;
    forwardTransferRate: number;
    toolUseEfficiency: number;
    rework: number;
  },
  weights: CompositeWeights
): number {
  const total =
    weights.passRate +
    weights.retention +
    weights.forwardTransferRate +
    weights.toolUseEfficiency +
    weights.rework;
  if (!(total > 0)) return 0;
  const weighted =
    weights.passRate * components.passRate +
    weights.retention * components.retention +
    weights.forwardTransferRate * components.forwardTransferRate +
    weights.toolUseEfficiency * components.toolUseEfficiency +
    weights.rework * components.rework;
  return clamp01(weighted / total);
}

/**
 * 样本不足时的诚实返回：能力比率全部为 0，但样本量与 pendingRatio 如实上报。
 *
 * 关于 pendingRatio 的例外（有意为之，不是遗漏）：如果把它也归零，那么"3 条样本
 * 全是 pending"就会报成 "pendingRatio = 0"，这本身就是假数据，而且恰好抹掉了
 * 解释"为什么没有数据"的唯一信号。pendingRatio 是记账比率而非能力声明，
 * 因此它在任何样本量下都保持真实。
 */
function insufficientMetrics(sampleCount: number, pendingRatio: number): CapabilityMetrics {
  return {
    sampleCount,
    passRate: 0,
    reworkRate: 0,
    forgettingRate: 0,
    forwardTransferRate: 0,
    toolUseEfficiency: 0,
    compositeScore: 0,
    pendingRatio,
    insufficientData: true,
  };
}

/**
 * 计算能力指标。样本不足时返回 insufficientData=true 且能力比率归零。
 *
 * 各维度定义（与 describeCapabilityMetrics() 对外说明一致）：
 * - passRate = pass / (pass + fail)。pending / human_review 不进分母。
 * - pendingRatio = (pending + human_review) / sampleCount，单独报告未定论比例。
 * - reworkRate = 已定论 episode 中 attempts > 1 的占比（未定论样本的 attempts 未定论，
 *   所以不进分母）；attempts = 0 视为未记录而非零返工。
 * - forgettingRate = 分子/分母都只在"处于风险中"的已定论 episode 上计算：
 *   某 domain 已经出现过 pass 之后，该 domain 后续每一条已定论 episode 都计入分母，
 *   其中 outcome = fail 的计入分子（SWE-Bench-CL 的 forgetting 语义）。
 * - forwardTransferRate = 每个 domain 的第一次已定论 episode 即 pass 的 domain 占比。
 * - toolUseEfficiency = pass 数 / Σ max(1, attempts)（只统计已定论 episode），
 *   即"每次尝试换来的一次通过量"；attempts = 0 下限取 1，因为已定论的 episode
 *   至少消耗过一次尝试，未记录不应被当成免费成功。取值 [0,1]。
 * - compositeScore = 加权复合分（默认权重见 DEFAULT_COMPOSITE_WEIGHTS）。
 * - insufficientData = (pass + fail) < minResolvedSamples（默认 5）。
 */
export function computeCapabilityMetrics(
  episodes: readonly CapabilityEpisode[],
  options?: CapabilityMetricsOptions
): CapabilityMetrics {
  const normalized = normalizeEpisodes(episodes, options?.domainOf);
  const sampleCount = normalized.length;
  const resolved = normalized.filter((episode) => episode.outcome !== "undecided");
  const pendingRatio = ratio(sampleCount - resolved.length, sampleCount);

  const minResolved = normalizePositiveInt(
    options?.minResolvedSamples,
    MIN_RESOLVED_SAMPLES
  );
  if (resolved.length < minResolved) {
    return insufficientMetrics(sampleCount, pendingRatio);
  }

  const ordered = orderByTime(resolved);
  const pass = ordered.filter((episode) => episode.outcome === "pass").length;
  const passRate = ratio(pass, ordered.length);

  // 返工率与工具使用效率共用一次遍历：分母口径都是"已定论 episode"。
  let reworkCount = 0;
  let attemptSum = 0;
  for (const episode of ordered) {
    if (episode.attempts > 1) reworkCount += 1;
    attemptSum += episode.attempts > 1 ? episode.attempts : 1;
  }
  const reworkRate = ratio(reworkCount, ordered.length);
  const toolUseEfficiency = ratio(pass, attemptSum);

  // 遗忘：某 domain 出现过 pass 之后，后续失败即一次遗忘事件。
  let atRisk = 0;
  let forgotten = 0;
  const passedDomains = new Set<string>();
  for (const episode of ordered) {
    if (passedDomains.has(episode.domain)) {
      atRisk += 1;
      if (episode.outcome === "fail") forgotten += 1;
    }
    if (episode.outcome === "pass") passedDomains.add(episode.domain);
  }
  const forgettingRate = ratio(forgotten, atRisk);

  // 前向迁移：只取每个 domain 的第一条已定论 episode。
  const seenDomains = new Set<string>();
  let firstPass = 0;
  let firstTotal = 0;
  for (const episode of ordered) {
    if (seenDomains.has(episode.domain)) continue;
    seenDomains.add(episode.domain);
    firstTotal += 1;
    if (episode.outcome === "pass") firstPass += 1;
  }
  const forwardTransferRate = ratio(firstPass, firstTotal);

  const compositeScore = computeCompositeScore(
    {
      passRate,
      retention: 1 - forgettingRate,
      forwardTransferRate,
      toolUseEfficiency,
      rework: 1 - reworkRate,
    },
    resolveWeights(options?.weights)
  );

  return {
    sampleCount,
    passRate,
    reworkRate,
    forgettingRate,
    forwardTransferRate,
    toolUseEfficiency,
    compositeScore,
    pendingRatio,
    insufficientData: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 六 · DomainCompetence（M5 能力地图）
// ─────────────────────────────────────────────────────────────────────────────

export type DomainCompetenceStatus = "verified" | "provisional" | "unknown";

export interface DomainCompetence {
  domain: string;
  /** 已定论样本数（pass + fail）。阈值只由已定论证据决定，未定论样本不能"验证"一个域。 */
  n: number;
  pass: number;
  fail: number;
  /** 未定论样本数（pending + human_review），单独可见但不参与分级。 */
  pending: number;
  /** n > 0 时为 pass / n；n = 0 时为 0（unknown 域不编造成功率）。 */
  passRate: number;
  /** 该域最近一次 pass 的 createdAt（epoch ms）；从未 pass 过则为 null。 */
  lastVerifiedAt: number | null;
  status: DomainCompetenceStatus;
}

export interface DomainCompetenceOptions {
  /** domain 切分键；默认读 episode.domain，缺失归入 UNCLASSIFIED_DOMAIN。 */
  domainOf?: (episode: CapabilityEpisode) => string;
  /** verified 所需的最少已定论样本数，默认 MIN_DOMAIN_SAMPLES（5）。 */
  minSamples?: number;
  /** verified 所需的成功率下限，默认 MIN_DOMAIN_PASS_RATE（0.6）。 */
  minPassRate?: number;
}

/**
 * 构建能力地图：按任务域聚合 (n, 成功率, 最近验证时间)。
 *
 * 为什么必须按域分池（M5 的关键）：跨域混池会把"某个域已经验证过"和"某个域完全没底"
 * 平均成一个中间数字，信号被稀释到无法行动。分池之后 harness 才能在 n < k 或成功率
 * 不足时明确告诉 Agent"此域无已验证记忆"，而不是让模型自己猜置信度——
 * 模型会系统性误判自身知识边界（arXiv:2604.19749），且"校准 ≠ 行动"，
 * 阈值必须由 harness 外部强制（arXiv:2601.07767）。
 *
 * 分级规则（预注册，可配置但有默认值）：
 * - n >= minSamples(5) 且 passRate >= minPassRate(0.6) → verified
 * - n >= 1 但未达上述门槛 → provisional（仅表示"见过"，不是可用结论）
 * - n = 0 → unknown（一条已定论证据都没有）
 */
export function buildCompetenceMap(
  episodes: readonly CapabilityEpisode[],
  options?: DomainCompetenceOptions
): DomainCompetence[] {
  const normalized = normalizeEpisodes(episodes, options?.domainOf);
  const minSamples = normalizePositiveInt(options?.minSamples, MIN_DOMAIN_SAMPLES);
  const minPassRate = normalizeThreshold(options?.minPassRate, MIN_DOMAIN_PASS_RATE);

  interface Bucket {
    pass: number;
    fail: number;
    pending: number;
    lastVerifiedAt: number | null;
  }

  const buckets = new Map<string, Bucket>();
  for (const episode of normalized) {
    let bucket = buckets.get(episode.domain);
    if (!bucket) {
      bucket = { pass: 0, fail: 0, pending: 0, lastVerifiedAt: null };
      buckets.set(episode.domain, bucket);
    }
    if (episode.outcome === "pass") {
      bucket.pass += 1;
      bucket.lastVerifiedAt =
        bucket.lastVerifiedAt === null
          ? episode.createdAt
          : Math.max(bucket.lastVerifiedAt, episode.createdAt);
    } else if (episode.outcome === "fail") {
      bucket.fail += 1;
    } else {
      bucket.pending += 1;
    }
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => compareText(left, right))
    .map(([domain, bucket]) => {
      const n = bucket.pass + bucket.fail;
      const passRate = ratio(bucket.pass, n);
      const status: DomainCompetenceStatus =
        n === 0
          ? "unknown"
          : n >= minSamples && passRate >= minPassRate
            ? "verified"
            : "provisional";
      return {
        domain,
        n,
        pass: bucket.pass,
        fail: bucket.fail,
        pending: bucket.pending,
        passRate,
        lastVerifiedAt: bucket.lastVerifiedAt,
        status,
      };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 七 · SkillUseStats（M3：技能选择精度 / shadowing）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 技能使用遥测输入。
 *
 * 当前遥测缺口（M3 的真实状态，必须直说而不是假装有数据）：仓库现有落盘遥测里
 * **没有**记录"这一步召回了哪些技能 / 实际用了哪个 / 是否确实有帮助"。因此所有字段
 * 都是可选的，且"字段缺失"与"字段为 0"被严格区分：缺失 → insufficientData=true，
 * 显式为 0 → 视为真实观测到的 0。
 *
 * "有帮助"必须来自外部验证器（测试/构建/类型检查/人工确认），不接受 agent 自报：
 * 无外部反馈的自我评估不可靠（arXiv:2310.01798、ICLR 2025 Stechly 等），
 * 编码域里 68–80% 的失败是"自信且一致"的语义错误（arXiv:2603.25764）。
 */
export interface SkillUseTelemetry {
  /** 召回机会数：至少有一个技能被推给 agent 的决策点。 */
  recalled?: number;
  /** 召回机会中，召回的技能确实被调用的次数。 */
  used?: number;
  /** 被调用且确实有帮助的次数（外部验证器判定）。 */
  helpful?: number;
  /** 召回后选错：用了召回集之外的技能，或干脆没用。 */
  shadowed?: number;
  /** 按技能的绕过计数（代理归因，见 aggregateSkillRecallEvents）。 */
  shadowingBySkill?: Record<string, number>;
}

export interface SkillUseOptions {
  /** 上报任何精度前所需的最少召回机会，默认 1（遥测尚未接线，故下限极低）。 */
  minRecalls?: number;
  /** 上报精度前所需的最少已归因使用次数，默认 1。 */
  minUsed?: number;
}

export interface SkillUseStats {
  recalled: number;
  used: number;
  /** 被调用且确实有帮助的次数 / 被调用次数。 */
  effectiveUsePrecision: number;
  /** 召回了但选错的比例 = shadowed / recalled。 */
  shadowingRate: number;
  /** 每条被绕过的技能被计一次（代理归因，不是 ground truth）。 */
  shadowingBySkill: Record<string, number>;
  /** 缺召回/使用/帮助判定任一项时为 true，此时各率给 0。 */
  insufficientData: boolean;
}

/** 一次召回决策的原始事件（供未来接线时聚合，见 aggregateSkillRecallEvents）。 */
export interface SkillRecallEvent {
  /** 本次决策点被推给 agent 的技能 id。 */
  recalledIds: readonly string[];
  /** 实际调用的技能 id；缺失表示一个都没用。 */
  usedId?: string;
  /** 外部验证器判定被调用的技能确实有帮助；缺失表示未验证（≠ 无效）。 */
  helped?: boolean;
}

interface RawRecallEvent {
  recalledIds?: unknown;
  usedId?: unknown;
  helped?: unknown;
}

/** 只保留有限且为正的计数；非法值不猜测、不填充。 */
function sanitizeCounterMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const entries: Array<[string, number]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
    entries.push([name, Math.trunc(raw)]);
  }
  // Object.fromEntries 以自有属性定义键，避免 __proto__ 之类的键污染原型。
  return Object.fromEntries(entries);
}

/**
 * 把召回事件聚合成 computeSkillUseStats 的输入。
 *
 * shadowingBySkill 用的是**代理归因**：被绕过（召回但未被选中）的技能各记一次。
 * 我们并不知道"正确技能"是哪一个（那需要 ground truth），所以这是可观测的代理量，
 * 不是准确率；对外引用时必须带这个限定。
 */
export function aggregateSkillRecallEvents(
  events: readonly SkillRecallEvent[]
): SkillUseTelemetry {
  let recalled = 0;
  let used = 0;
  let helpful = 0;
  let shadowed = 0;
  let helpedObserved = false;
  const shadowingBySkill = new Map<string, number>();

  for (const candidate of events as readonly unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const event = candidate as RawRecallEvent;
    const recalledIds = Array.isArray(event.recalledIds)
      ? Array.from(
          new Set(
            event.recalledIds.filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0
            )
          )
        )
      : [];
    // 没有任何技能被召回的决策点不构成"选择"，不计入召回机会。
    if (recalledIds.length === 0) continue;

    const usedId =
      typeof event.usedId === "string" && event.usedId.trim()
        ? event.usedId.trim()
        : undefined;
    const picked = usedId !== undefined && recalledIds.includes(usedId);

    recalled += 1;
    if (picked) {
      used += 1;
      if (typeof event.helped === "boolean") {
        helpedObserved = true;
        if (event.helped) helpful += 1;
      }
    } else {
      shadowed += 1;
      for (const id of recalledIds) {
        const name = id.trim();
        shadowingBySkill.set(name, (shadowingBySkill.get(name) ?? 0) + 1);
      }
    }
  }

  const telemetry: SkillUseTelemetry = { recalled, used, shadowed };
  // helped 只在至少观测到一次外部判定时才上报：把"没有判定"与"判定为无效"分开。
  if (helpedObserved) telemetry.helpful = helpful;
  if (shadowingBySkill.size > 0) {
    telemetry.shadowingBySkill = Object.fromEntries(shadowingBySkill);
  }
  return telemetry;
}

/**
 * 计算技能有效使用精度与 shadowing 率（M3 一等指标）。
 *
 * - effectiveUsePrecision = 被调用且确实有帮助的次数 / 被调用次数
 *   （growth-plan §2.2 补的指标；技能池从 5 增到 100 时该精度从 29.6% 掉到 3.3%，
 *   arXiv:2605.24050、arXiv:2608.14036）。
 * - shadowingRate = shadowed / recalled，shadowed 指"用了召回集之外的技能或没用"。
 * - insufficientData：召回数不足、已归因使用数为 0（精度分母为 0）、
 *   或缺少"是否有帮助"的外部判定（分子未知）时为 true。此时各率给 0，
 *   绝不把"未测量"写成 0%。
 *
 * 两个已知的输入不一致情形的处理（夹到 [0,1]，并在此写明）：
 * helpful > used 或 shadowed > recalled 说明上游计数有误，结果压回边界，
 * 不产生 >100% 的"好数字"，也不静默丢弃这些记录。
 */
export function computeSkillUseStats(
  telemetry: SkillUseTelemetry | undefined | null,
  options?: SkillUseOptions
): SkillUseStats {
  const minRecalls = normalizePositiveInt(options?.minRecalls, 1);
  const minUsed = normalizePositiveInt(options?.minUsed, 1);
  const recalled = normalizeCount(telemetry?.recalled);
  const used = normalizeCount(telemetry?.used);
  const helpful = normalizeCount(telemetry?.helpful);
  const shadowed = normalizeCount(telemetry?.shadowed);
  const shadowingBySkill = sanitizeCounterMap(telemetry?.shadowingBySkill);

  const hasHelpfulOutcome =
    typeof telemetry?.helpful === "number" && Number.isFinite(telemetry.helpful);
  const hasShadowOutcome =
    typeof telemetry?.shadowed === "number" && Number.isFinite(telemetry.shadowed);

  const insufficientData =
    recalled < minRecalls || used < minUsed || !hasHelpfulOutcome || !hasShadowOutcome;

  if (insufficientData) {
    return {
      recalled,
      used,
      effectiveUsePrecision: 0,
      shadowingRate: 0,
      shadowingBySkill,
      insufficientData: true,
    };
  }

  return {
    recalled,
    used,
    effectiveUsePrecision: ratio(helpful, used),
    shadowingRate: ratio(shadowed, recalled),
    shadowingBySkill,
    insufficientData: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 八 · 反基准：指标定义 / 依据 / 局限固化在代码里（M11）
// ─────────────────────────────────────────────────────────────────────────────

export interface CapabilityMetricDescriptor {
  /** 对应 CapabilityMetrics / DomainCompetence / SkillUseStats 的字段名。 */
  key: string;
  label: string;
  definition: string;
  /** 依据：文献编号或 growth-plan 章节，避免对外数字无法解释。 */
  evidence: string;
  /** 局限：这个数字什么时候不能信、不能拿来说明什么。 */
  caveat: string;
}

const CAPABILITY_METRIC_DESCRIPTORS: readonly CapabilityMetricDescriptor[] = [
  {
    key: "sampleCount",
    label: "样本量 / sample count",
    definition:
      "去重后的 episode 总数（含 pending 与 human_review）。所有指标的分母口径都以去重后的 episode 为单位。",
    evidence:
      "SWE-Bench-CL（arXiv:2507.00014）要求持续学习指标显式报告样本量与 memory-on/off 配对口径。",
    caveat:
      "样本量不等于独立任务数：同一任务反复重试会算成多条 episode，聚合口径存在选择偏差，必须配同任务配对报告（growth-plan §5.2，arXiv:2609.00549）。",
  },
  {
    key: "passRate",
    label: "一次通过率 / pass rate",
    definition: "pass / (pass + fail)。pending 与 human_review 不进分母，未定论比例由 pendingRatio 单独报告。",
    evidence:
      "SWE-Bench-CL 平均准确率维度（arXiv:2507.00014）。取代 token 节省率作为对外主指标的依据：削减 38.4% token 反而计费 +6.8%，SWE-bench Go 子集 27/40→15/40（arXiv:2607.12161）。",
    caveat:
      "聚合成功率会被「只在简单任务上检索」的选择偏差污染，必须报配对结果与等效区间（growth-plan §5.2/§5.3）；外部提交率 100% 对实际解决率 44%（arXiv:2603.25764），口径差必须写明。",
  },
  {
    key: "pendingRatio",
    label: "未定论比例 / pending ratio",
    definition: "(pending + human_review) / sampleCount，单独报告没有定论的样本占比。",
    evidence:
      "SWE-Bench-CL 显式区分已定论与未定论样本（arXiv:2507.00014）。",
    caveat:
      "这是唯一在 insufficientData 时仍如实上报的比率：样本全是 pending 时把它报成 0 本身就是假数据，而且抹掉了「为什么没有数据」的唯一信号。",
  },
  {
    key: "reworkRate",
    label: "返工率 / rework rate",
    definition:
      "已定论 episode 中 attempts > 1 的占比（分母为 pass + fail；未定论样本的 attempts 未定论故不计入）。",
    evidence:
      "SWE-Bench-CL 工具使用效率维度（arXiv:2507.00014）；Evo-Memory 四维中的 step efficiency（arXiv:2511.20857）。",
    caveat:
      "attempts 由外部 agent 自报，可靠性弱于可执行验证器，因此 M8 要求以测试/构建/类型检查证据为准（growth-plan §1.5、M8）；attempts = 0 视为未记录，不当作零返工。",
  },
  {
    key: "forgettingRate",
    label: "遗忘率 / forgetting rate",
    definition:
      "同域曾出现 pass 之后，该域后续已定论 episode 为 fail 的比例。分母是「处于风险中」的 episode（其域此前已 pass），分子是其中 fail 的数量。",
    evidence:
      "SWE-Bench-CL forgetting 维度（arXiv:2507.00014）；该领域自承没有人认真评测过遗忘（growth-plan §0）。",
    caveat:
      "小样本下方差极大，只在已定论样本达标时上报；退役决策应优先用确定性失效信号（技能引用的符号/路径不再解析，arXiv:2606.01435），遗忘率只作辅助。",
  },
  {
    key: "forwardTransferRate",
    label: "前向迁移率 / forward transfer rate",
    definition:
      "每个 domain 的第一条已定论 episode 即 pass 的 domain 占比（分母 = 有已定论样本的 domain 数）。",
    evidence: "SWE-Bench-CL 前向迁移维度（arXiv:2507.00014）。",
    caveat:
      "分母是 domain 数而不是 episode 数，样本量通常很小，单条样本即可大幅摆动；跨项目泛化本身仍属未验证方向（growth-plan M10）。",
  },
  {
    key: "toolUseEfficiency",
    label: "工具使用效率 / tool use efficiency",
    definition:
      "pass 数 / Σ max(1, attempts)（只统计已定论 episode），即每次尝试换来的一次通过量，取值 [0,1]。",
    evidence: "SWE-Bench-CL 工具使用效率维度（arXiv:2507.00014）。",
    caveat:
      "分母依赖自报 attempts；attempts = 0 取 1 是下限假设（已定论 episode 至少消耗一次尝试），它无法区分「未记录」与「真正一次成功」。",
  },
  {
    key: "compositeScore",
    label: "复合持续学习分数 / composite CL score",
    definition:
      "五维加权和：passRate、retention(1 - forgettingRate)、forwardTransferRate、toolUseEfficiency、rework(1 - min(1, reworkRate))；权重可传入，默认见 DEFAULT_COMPOSITE_WEIGHTS，按权重和归一化。",
    evidence:
      "SWE-Bench-CL 复合持续学习分数（arXiv:2507.00014）。权重本身没有文献依据，是本项目写入代码的显式取舍（passRate 权重最高）。",
    caveat:
      "权重是判断而非测量，不得作为唯一对外数字，必须与各分维度同时上报（growth-plan §5.6）；token 节省率被刻意排除在能力分之外，只作成本约束项（growth-plan §2.2）。",
  },
  {
    key: "insufficientData",
    label: "数据不足 / insufficient data",
    definition:
      "已定论（pass + fail）episode 少于 minResolvedSamples（默认 5）时为 true；此时除 pendingRatio 外的比率全部归零。",
    evidence:
      "确定性优先与诚实性纪律（growth-plan §5）；SWE-Bench-CL 要求显式报告样本量（arXiv:2507.00014）。",
    caveat:
      "5 是工程下限，不是统计功效计算。insufficientData 为 true 时不得回填演示数据或引用历史数字充当本次结论。",
  },
  {
    key: "competence.status",
    label: "域能力分级 / domain competence status",
    definition:
      "按域聚合后分级：n（已定论）>= 5 且 passRate >= 0.6 为 verified；n >= 1 但未达为 provisional；n = 0 为 unknown。",
    evidence:
      "M5：按域分池、由 harness 外部计算并强制阈值，不让模型自报置信度（arXiv:2604.19749、arXiv:2601.07767）。",
    caveat:
      "阈值是预注册的工程阈值，不是校准过的置信度；provisional 只表示「见过」，不得当作可用结论引用（这就是 M5 的「我不知道」信号）。",
  },
  {
    key: "skillUse.effectiveUsePrecision",
    label: "技能有效使用精度 / effective use precision",
    definition: "被调用且确实有帮助的次数 / 被调用次数；「有帮助」必须由外部验证器判定，不接受自报。",
    evidence:
      "技能有效使用精度（growth-plan §2.2 补充指标）；技能池 5→100 时该精度从 29.6% 掉到 3.3%，202 技能使 pass rate 平均 -21%（arXiv:2605.24050、arXiv:2608.14036）。",
    caveat:
      "当前遥测缺口：仓库未记录「召回了哪些 / 实际用了哪个 / 是否有帮助」，因此本指标在遥测接线完成前恒为 insufficientData，不得对外给数字。",
  },
  {
    key: "skillUse.shadowingRate",
    label: "技能遮蔽率 / skill shadowing rate",
    definition:
      "shadowed / recalled，其中 shadowed 指召回了技能却选了召回集之外的技能或干脆没用。",
    evidence:
      "skill shadowing 解释了 202 技能库掉点中的最多 68%（arXiv:2608.14036）；语义预筛可把工具选择准确率从 13.62% 提到 43.13%（arXiv:2505.03275）。",
    caveat:
      "shadowingBySkill 按「被绕过的技能」做代理归因，真正的正确技能未知，所以是代理量不是准确率；分母是召回机会数而不是技能数。",
  },
  {
    key: "reportingDiscipline",
    label: "反基准上报纪律 / anti-benchmark reporting",
    definition:
      "任何公开数字必须附：harness 与版本、数据集划分、检索种子、per-case 工件、判官误判率；token 节省率按同一标准重报。",
    evidence:
      "M11：LOCOMO 答案键 6.4% 错误、判官接受 62.81% 的故意错答；Zep 自报 71.2% 被独立复现为 63.8%；Mem0 OSS 复现 53.83% 对论文 60%+（growth-plan §M11）。",
    caveat:
      "这条纪律本身不产生数字，它约束的是引用方式：缺少上述任一项的数字只能作为内部信号，不得对外声明为能力结论。",
  },
];

/**
 * 返回全部能力指标的定义、依据（含 arXiv 编号）与局限（M11 的最小实现）。
 * 每次调用返回全新对象数组，调用方（diagnose / 文档生成）可以安全地改写结果。
 */
export function describeCapabilityMetrics(): CapabilityMetricDescriptor[] {
  return CAPABILITY_METRIC_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
}
