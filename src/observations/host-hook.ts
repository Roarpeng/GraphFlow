/**
 * Host tool-result projection hook (ObservationPack at the source).
 *
 * SoL-Pi can shrink a large tool result BEFORE its first prompt insertion
 * because it owns the provider-context projection. GraphFlow is an MCP memory
 * service and does not own that surface, so it cannot intercept anything by
 * itself. This module is the single function a host calls from its tool-result
 * hook, plus the exact shape it must be able to write back.
 *
 * A host MUST be able to replace the model-visible result with `projected`.
 * Archiving without projection does not reduce context and is not offered here;
 * hosts that cannot rewrite the surface should keep using the explicit
 * graphflow_context content/handle protocol from SKILL.md instead.
 *
 * Fail-open: a disabled mechanism, a small result, or any store failure leaves
 * the original text untouched.
 */
import { packObservation } from "./index";
import { resolveObservationPolicy } from "./policy";
import type { ObservationPolicy } from "./types";

export interface ToolResultProjectionInput {
  /** Stable tool name (e.g. "bash", "read"). Used only for the projected label. */
  tool: string;
  /** The full result text the host would otherwise insert verbatim. */
  text: string;
}

export interface ProjectedToolResult {
  /** True when the result was archived and `projected` should replace `text`. */
  archived: boolean;
  /** Text to insert on the model surface. Equals the input text when not archived. */
  projected: string;
  handle?: string;
  sizeBytes?: number;
  lines?: number;
  /** Why the result was not projected (disabled / below-threshold / store failure). */
  reason?: string;
}

export interface ProjectToolResultOptions {
  rootDir: string;
  policy?: ObservationPolicy;
}

/**
 * Project one tool result through the observation store. Pure given the store,
 * deterministic, and never throws.
 */
export async function projectToolResult(
  input: ToolResultProjectionInput,
  options: ProjectToolResultOptions
): Promise<ProjectedToolResult> {
  const policy = resolveObservationPolicy(options.policy);
  if (!policy.enabled) {
    return { archived: false, projected: input.text, reason: "disabled" };
  }
  if (Buffer.byteLength(input.text, "utf8") <= policy.inlineThresholdBytes) {
    return { archived: false, projected: input.text, reason: "below-threshold" };
  }

  const packed = await packObservation({ rootDir: options.rootDir, content: input.text, policy });
  if (packed.fallback) {
    return { archived: false, projected: input.text, reason: packed.reason };
  }

  const projected = [
    "[graphflow observation " + input.tool + "] handle=" + packed.handle +
      " lines=" + packed.lines + " bytes=" + packed.sizeBytes,
    packed.head,
    "...",
    packed.tail,
    "(recall exact bytes with graphflow_context handle=" + packed.handle + ")",
  ].join("\n");

  return {
    archived: true,
    projected,
    handle: packed.handle,
    sizeBytes: packed.sizeBytes,
    lines: packed.lines,
  };
}

/**
 * Hosts that can currently rewrite the model-visible tool result. Kept explicit
 * so a caller never assumes projection support that does not exist.
 *
 * "deepseek-harness" is wired through dsh/plugin.mjs: it reuses dsh's public
 * surface-replace primitive (the same one its native
 * dsh-compaction-tool-result-pruner uses), archives the exact bytes first, and
 * is ON by default (set GRAPHFLOW_D_DSH_PROJECTION=0/false/off/no/disabled to
 * turn it off). Other hosts have no result-rewrite
 * surface yet and must use the explicit graphflow_context content/handle protocol.
 */
export const HOSTS_WITH_TOOL_RESULT_PROJECTION: readonly string[] = ["deepseek-harness"];
