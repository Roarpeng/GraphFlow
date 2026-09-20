import { estimateUnbudgetedPayloadTokens } from "./graph.js";
import { calculateSavingsPercent } from "./helpers.js";
import type { ContextPreviewResult } from "./types.js";

/**
 * 响应硬预算 / Hard server-side response budget.
 *
 * `graphflow_context` once produced responses the MCP host truncated at its
 * own transport limit (observed: a 67KB JSON cut at 50KB — trailing fields
 * like `tokenBudget` / `dialogueCapture` were silently lost). The layered
 * package budget governs code anchors, but post-packaging additions (dialogue
 * hits, workbench echo, dialogue-thread spine) ride outside it, so the wire
 * size is otherwise unbounded. This module enforces a hard cap with an
 * ordered, loss-graded degradation ladder: each step drops the least valuable
 * payload first, re-measures, and stops as soon as the serialized response
 * fits. `degraded` records exactly which steps ran, and token accounting is
 * recomputed on the FINAL payload so `unbudgetedTokens` / `accountedTokens`
 * stay honest about what was actually sent.
 * 服务端硬预算 + 有序降级：先删最廉价可再取的内容（outline），最后才丢
 * dialogueHits 本体；每步后重测，达标即停；降级后按最终负载重算记账。
 */

/** Hard cap on the serialized response (JSON.stringify().length). */
export const MAX_RESPONSE_BYTES = 32_768;

/** 降级步骤名（按阶梯顺序）/ Degradation step ids in ladder order. */
export type ResponseDegradationStep =
  | "outline"
  | "dialogueHits.userQuery"
  | "promptLines"
  | "dialogueHits";

export interface ResponseBudgetOptions {
  /** Hard cap on JSON.stringify(result).length; defaults to MAX_RESPONSE_BYTES. */
  maxBytes?: number;
}

function omitKey<T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> {
  const copy = { ...source } as Record<string, unknown>;
  delete copy[key as string];
  return copy as Omit<T, K>;
}

/**
 * Enforce the response budget on an assembled preview result.
 *
 * Within budget: the input is returned unchanged (same reference, no
 * `degraded` field). Over budget: degradation steps run in order —
 * ① `outline` (workbench.outline + a defensive top-level outline key),
 * ② `dialogueHits.userQuery` per hit (id/seq/title survive),
 * ③ `promptLines` (workbench/dialogueThread echo duplicates of already
 * budgeted summary lines — emptied in place of deletion because the echo
 * view types keep `promptLines: string[]`),
 * ④ the whole `dialogueHits` array — measuring after each step and stopping
 * as soon as the serialized size fits. Only steps that actually removed
 * content are listed in `degraded`.
 * 纯函数：不修改入参（上下文缓存 / 测试 fixture 不被降级污染）。
 */
export function applyResponseBudget(
  result: ContextPreviewResult,
  options?: ResponseBudgetOptions
): ContextPreviewResult {
  const maxBytes = options?.maxBytes ?? MAX_RESPONSE_BYTES;
  const steps: ResponseDegradationStep[] = [];
  // `degraded` 本身也占字节：测量时带上已执行步骤，防止收尾加字段又超限。
  const measure = (candidate: ContextPreviewResult): number =>
    JSON.stringify(
      steps.length > 0 ? { ...candidate, degraded: [...steps] } : candidate
    ).length;
  if (measure(result) <= maxBytes) {
    return result;
  }

  let out: ContextPreviewResult = { ...result };

  // ① outline：全量脉络树最占字节，且 CLI `workbench tree` 常驻可查。
  // The outline tree is the bulkiest payload and standing-viewable via CLI.
  if (out.workbench?.outline || "outline" in out) {
    if (out.workbench) {
      out = { ...out, workbench: omitKey(out.workbench, "outline") };
    }
    if ("outline" in out) {
      out = omitKey(out as ContextPreviewResult & { outline?: unknown }, "outline");
    }
    steps.push("outline");
    if (measure(out) <= maxBytes) return finalizeBudget(out, steps);
  }

  // ② dialogueHits 每项删 userQuery 正文（id/seq/title 等定位字段保留）。
  // Drop the verbose query text first; hit identity fields survive.
  if (out.dialogueHits?.some((hit) => hit.userQuery)) {
    out = {
      ...out,
      dialogueHits: out.dialogueHits.map((hit) =>
        hit.userQuery ? omitKey(hit, "userQuery") : hit
      ),
    };
    steps.push("dialogueHits.userQuery");
    if (measure(out) <= maxBytes) return finalizeBudget(out, steps);
  }

  // ③ promptLines：这些行已前置进 summary（预算内），回显字段是重复内容。
  // promptLines are already-budgeted summary lines; the echo copy duplicates
  // them. Emptied (not deleted) because the echo view types keep `string[]`;
  // compressedTokens is untouched — the summary lines are still sent.
  if ((out.workbench?.promptLines.length ?? 0) > 0 || (out.dialogueThread?.promptLines.length ?? 0) > 0) {
    out = {
      ...out,
      ...(out.workbench ? { workbench: { ...out.workbench, promptLines: [] } } : {}),
      ...(out.dialogueThread ? { dialogueThread: { ...out.dialogueThread, promptLines: [] } } : {}),
    };
    steps.push("promptLines");
    if (measure(out) <= maxBytes) return finalizeBudget(out, steps);
  }

  // ④ 整体删 dialogueHits：定位信息也随之让位，属最后手段。
  // The whole hit array is the last thing to go.
  if (out.dialogueHits) {
    out = omitKey(out, "dialogueHits");
    steps.push("dialogueHits");
  }
  return finalizeBudget(out, steps);
}

/**
 * 降级后重算记账 / Re-account after degradation.
 *
 * Mirrors `withPostPackageAccounting` semantics (src/surfaces/cli/runtime/
 * graph.ts): `unbudgetedTokens` is re-estimated via
 * `estimateUnbudgetedPayloadTokens` over the payloads that actually ride
 * outside the layered package in the FINAL response — workbench echo and an
 * injected thread spine are measured without their promptLines (already
 * budgeted in `summary`), a non-injected thread view is measured as sent, and
 * hits are measured as-is. `accountedTokens = compressedTokens +
 * unbudgetedTokens`, `estimatedRawTokens` keeps its floor semantics, and the
 * savings percent is recomputed against the true accounted total.
 */
function finalizeBudget(
  result: ContextPreviewResult,
  steps: readonly ResponseDegradationStep[]
): ContextPreviewResult {
  const payloads: unknown[] = [];
  if (result.workbench) {
    const { promptLines: _budgeted, ...echo } = result.workbench;
    payloads.push(echo);
  }
  if (result.dialogueThread) {
    const spineInjected = result.summary.some((line) => line.startsWith("Thread:"));
    if (spineInjected) {
      const { promptLines: _budgeted, ...thread } = result.dialogueThread;
      payloads.push(thread);
    } else {
      payloads.push(result.dialogueThread);
    }
  }
  if (result.dialogueHits) {
    payloads.push(...result.dialogueHits);
  }
  const unbudgetedTokens = estimateUnbudgetedPayloadTokens(payloads);
  const compressedTokens = result.tokenBudget.compressedTokens;
  const accountedTokens = compressedTokens + unbudgetedTokens;
  // 真实下发量不会低于 raw 估算：沿用 estimateRawContextTokens 的下限语义。
  const estimatedRawTokens = Math.max(result.tokenBudget.estimatedRawTokens, accountedTokens);
  const { unbudgetedTokens: _stale, ...base } = result;
  return {
    ...base,
    degraded: [...steps],
    tokenBudget: {
      ...result.tokenBudget,
      estimatedRawTokens,
      estimatedSavingsPercent: calculateSavingsPercent(estimatedRawTokens, accountedTokens),
    },
    ...(unbudgetedTokens > 0 ? { unbudgetedTokens } : {}),
    accountedTokens,
  };
}
