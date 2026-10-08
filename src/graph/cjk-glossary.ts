/**
 * cjk-glossary.ts — deterministic Chinese→English search-term support.
 *
 * Pure-Chinese queries cannot hit English-only code symbols through the
 * keyword channel (CJK bigrams never occur in `cost-ledger.ts`), and the
 * agent-translation round-trip (`query-translate-en` work item) is the
 * designed backstop — but it costs a full extra agent turn. This module is
 * the zero-LLM first aid: a curated seed glossary of project/dev-domain
 * Chinese terms plus a generic dev-path segment stoplist, both applied
 * server-side inside `expandSearchQueries` before RRF fusion.
 *
 * Honest scope: a seed glossary, not a translator. Terms outside the map
 * still need agent `englishQuery`. The map is intentionally high-precision
 * (codebase-attested identifiers and core dev vocabulary); when in doubt a
 * term stays out, because a wrong expansion is worse than none — ranking
 * scores every expansion by coverage, so junk terms only cost index lookups.
 */

const CJK_CHAR = "[一-鿿㐀-䶿豈-﫿]";

/** codebase-attested Chinese term → English search terms (all lowercase). */
export const CJK_EN_GLOSSARY: ReadonlyMap<string, readonly string[]> = new Map([
  ["成本台账", ["cost", "ledger"]],
  ["成本", ["cost"]],
  ["花费", ["cost"]],
  ["开销", ["cost"]],
  ["台账", ["ledger"]],
  ["账本", ["ledger"]],
  ["自定义", ["custom"]],
  ["优先级", ["priority"]],
  ["优先", ["priority"]],
  ["提供商", ["provider"]],
  ["供应商", ["provider"]],
  ["服务商", ["provider"]],
  ["服务", ["service"]],
  ["端点", ["endpoint"]],
  ["配置", ["config"]],
  ["路由", ["routing"]],
  ["失败", ["fail"]],
  ["成功", ["success"]],
  ["错误", ["error"]],
  ["异常", ["exception"]],
  ["处理", ["handle"]],
  ["嵌入", ["embedding"]],
  ["向量", ["vector"]],
  ["索引", ["index"]],
  ["上下文", ["context"]],
  ["缓存", ["cache"]],
  ["会话", ["session"]],
  ["计划", ["plan"]],
  ["规划", ["plan"]],
  ["合并", ["merge"]],
  ["分支", ["branch"]],
  ["测试", ["test"]],
  ["用例", ["test"]],
  ["基准", ["benchmark"]],
  ["评估", ["eval"]],
  ["性能", ["performance"]],
  ["发布", ["publish", "release"]],
  ["发版", ["release"]],
  ["安全", ["security"]],
  ["审计", ["audit"]],
  ["技能", ["skill"]],
  ["记忆", ["memory"]],
  ["检索", ["retrieval"]],
  ["召回", ["recall"]],
  ["压缩", ["compression", "compact"]],
  ["压紧", ["compact"]],
  ["判断", ["judgment"]],
  ["判定", ["judgment"]],
  ["推理", ["inference"]],
  ["并发", ["concurrent"]],
  ["死锁", ["deadlock"]],
  ["超时", ["timeout"]],
  ["重试", ["retry"]],
  ["回退", ["fallback"]],
  ["降级", ["fallback"]],
  ["限流", ["limit"]],
  ["配额", ["quota"]],
  ["预算", ["budget"]],
  ["证据", ["evidence"]],
  ["所有权", ["ownership"]],
  ["移交", ["handoff"]],
  ["交接", ["handoff"]],
  ["关闭", ["close"]],
  ["创建", ["create"]],
  ["新建", ["create"]],
  ["泄漏", ["leak"]],
  ["泄露", ["leak"]],
  ["句柄", ["handle"]],
  ["守卫", ["guard"]],
  ["初始化", ["init"]],
  ["初始", ["init"]],
  ["观测", ["observation"]],
  ["观察", ["observation"]],
  ["锚点", ["anchor"]],
  ["工作区", ["workspace"]],
  ["对话", ["dialogue"]],
  ["轮次", ["turn"]],
  ["飞轮", ["flywheel"]],
  ["翻译", ["translate"]],
  ["关键词", ["keyword"]],
  ["关键字", ["keyword"]],
  ["符号", ["symbol"]],
  ["文件", ["file"]],
  ["目录", ["directory"]],
  ["路径", ["path"]],
  ["报告", ["report"]],
  ["产物", ["artifact"]],
  ["工件", ["artifact"]],
  ["快照", ["snapshot"]],
  ["增量", ["incremental"]],
  ["全量", ["full"]],
  ["差异", ["diff"]],
  ["冲突", ["conflict"]],
  ["清理", ["cleanup"]],
  ["删除", ["delete"]],
  ["治理", ["governance"]],
  ["可观测", ["observability"]],
  ["规则", ["rule"]],
  ["提示", ["prompt"]],
  ["指令", ["instruction"]],
  ["文档", ["doc"]],
  ["说明", ["doc"]],
  ["指南", ["guide"]],
  ["模型", ["model"]],
  ["大模型", ["llm"]],
  ["令牌", ["token"]],
]);

/** Cap on emitted English terms: bounds the extra index lookups per query. */
export const CJK_GLOSSARY_MAX_TERMS = 24;

/**
 * English terms for the Chinese domain vocabulary present in `query`.
 * Longest keys first (deterministic order — RRF breaks ties by first-seen),
 * duplicates removed. Empty for non-CJK input.
 */
export function expandCjkGlossaryTerms(query: string): string[] {
  if (!query || !new RegExp(CJK_CHAR).test(query)) return [];
  const keys = [...CJK_EN_GLOSSARY.keys()].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (!query.includes(key)) continue;
    for (const term of CJK_EN_GLOSSARY.get(key) ?? []) {
      if (seen.has(term)) continue;
      seen.add(term);
      out.push(term);
      if (out.length >= CJK_GLOSSARY_MAX_TERMS) return out;
    }
  }
  return out;
}

/**
 * Generic developer-machine path segments: they match thousands of nodes
 * (`code` hits every `*-code-hooks.ts`, `tmp` hits every tmpdir test) and,
 * RRF-fused at equal weight, bury the true ranking (T4: framework-routes
 * outranked schema.ts). Project-distinctive segments (fat-battle, …) pass
 * through untouched.
 */
export const GENERIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "users",
  "user",
  "home",
  "root",
  "administrator",
  "admin",
  "desktop",
  "documents",
  "downloads",
  "download",
  "tmp",
  "temp",
  "var",
  "opt",
  "usr",
  "code",
  "codes",
  "coding",
  "projects",
  "project",
  "workspace",
  "workspaces",
  "work",
  "repos",
  "repo",
  "repository",
  "git",
  "github",
  "gitlab",
  "dev",
  "development",
  "src",
  "source",
  "mnt",
  "media",
  "volumes",
]);

/** Drop generic dev-path tokens; the survivors carry the path-hint signal. */
export function filterGenericPathTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => {
    const lower = token.toLowerCase();
    return lower.length >= 2 && !GENERIC_PATH_SEGMENTS.has(lower);
  });
}
