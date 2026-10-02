import { takeWorkspaceSnapshot } from "../host/workspace-snapshot.js";
import {
  auditWorkspaceSnapshots,
  cacheAdmission,
  checkWriteScope,
  detectInjection,
  evaluateAction,
  evaluateWorkerLaunch,
  loadSecurityPolicy,
  redactDeep,
  redactSecrets,
  wrapUntrusted,
  type SecurityPolicy,
} from "../security/index.js";
import type { TraceSecurityDecision } from "../trace.js";
import { combineDecisions, type PipelineSecurity, type SecurityContext } from "./security-adapter.js";

/** Paths eff-agent itself writes; the post-run audit ignores them. */
const SELF_WRITTEN = ["graphflow-out/**", ".graphflow-cache/**"];

function withFlags(policy: SecurityPolicy, ctx: SecurityContext): SecurityPolicy {
  return {
    ...policy,
    externalWriteApproval: ctx.externalWriteApproval,
    networkDefault: ctx.network,
    maxSubAgents: ctx.subAgents ? Math.max(1, policy.maxSubAgents) : 0,
  };
}

function quoteArg(arg: string): string {
  return /\s|"/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * The bundled security gate: policies/default-policy-v1.json semantics,
 * an optional operator policy file, and fail-closed (STRICT) when that file
 * is corrupt or invalid (spec §9).
 */
export function createDefaultSecurity(options: { policyFile?: string } = {}): PipelineSecurity & {
  source: "default" | "file" | "fail-closed";
  loadError?: string;
} {
  const loaded = loadSecurityPolicy(options.policyFile);
  const base = loaded.policy;
  const policyVersion = `security-v${base.version}${loaded.source === "fail-closed" ? "-strict" : loaded.source === "file" ? "-custom" : ""}`;
  const loadReason = loaded.error ? [`policy fail-closed: ${loaded.error}`] : [];

  return {
    source: loaded.source,
    ...(loaded.error ? { loadError: loaded.error } : {}),
    policyVersion,

    checkCommands(commands, ctx) {
      const policy = withFlags(base, ctx);
      const decisions: TraceSecurityDecision[] = commands
        .filter((c) => c.trim().length > 0)
        .map((command) => {
          const d = evaluateAction({ kind: "exec", command, workspaceRoot: ctx.workspaceRoot, readOnly: ctx.readOnly }, policy);
          return { ...d, reasons: d.reasons.map((r) => `validation \`${command}\`: ${r}`) };
        });
      const combined = combineDecisions(decisions);
      return loadReason.length > 0 ? { ...combined, reasons: [...loadReason, ...combined.reasons] } : combined;
    },

    checkWorkerLaunch(executor, ctx) {
      const policy = withFlags(base, ctx);
      const line = [executor.command, ...executor.args.filter((a) => a !== "{prompt}")].map(quoteArg).join(" ");
      return evaluateWorkerLaunch(line, policy);
    },

    checkWriteScope(ctx) {
      return checkWriteScope(ctx.workspaceRoot, ctx.writeScope ?? []);
    },

    snapshot(root, before) {
      return takeWorkspaceSnapshot(root, before);
    },

    auditWrites(before, after, ctx) {
      if (before === undefined || after === undefined) {
        return {
          decision: { verdict: "allow", risk: "R1", reasons: ["workspace is not a git repository: write audit unavailable"] },
          newlyChanged: [],
        };
      }
      const audit = auditWorkspaceSnapshots({
        before,
        after,
        workspaceRoot: ctx.workspaceRoot,
        readOnly: ctx.readOnly,
        policy: withFlags(base, ctx),
        ignorePaths: SELF_WRITTEN,
        ...(ctx.writeScope ? { writeScope: ctx.writeScope } : {}),
      });
      return {
        decision: audit.decision,
        newlyChanged: audit.newlyChanged,
        ...(audit.rewrittenDirty.length > 0 ? { rewrittenDirty: audit.rewrittenDirty } : {}),
        ...(audit.ignoredChanged.length > 0 ? { ignoredChanged: audit.ignoredChanged } : {}),
        ...(audit.outsideRoot.length > 0 ? { outsideRoot: audit.outsideRoot } : {}),
      };
    },

    redact: (text) => redactSecrets(text).text,
    redactDeep: (value) => redactDeep(value).value,
    wrapUntrusted: (source, text) => wrapUntrusted(source, text),

    admitToCache({ output, validationPassed, evidence }) {
      const injection = detectInjection(output);
      const secrets = redactSecrets(output);
      const verdict = cacheAdmission({
        validationPassed,
        evidence,
        injectionSuspected: injection.suspicious,
        secretsRedacted: secrets.redactions,
      });
      return { admit: verdict.admit, reason: verdict.reasons.join("; ") };
    },
  };
}
