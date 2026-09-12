/**
 * Mechanism auto-research loop (SoL-Pi methodology, host-agnostic slice).
 *
 * SoL-Pi searched 152 harness ideas down to 4 survivors. GraphFlow already owns
 * the evidence/quota machinery for skills; this module turns the same loop on
 * MECHANISMS (harness/context changes) instead of skills:
 *
 *   proposed -> in-trajectory (training screening) -> frozen -> held-out -> admitted | rejected
 *
 * Three rules are enforced, not documented:
 *  1. Constrained efficiency: admission requires a held-out trial whose paired
 *     comparison qualifies (capability held within tolerance AND tokens improved).
 *  2. Held-out isolation: after freeze, no further in-trajectory trial is
 *     accepted, so the search cannot keep tuning against the frozen evaluation.
 *  3. Terminal decisions: an admitted/rejected mechanism accepts no new trials.
 *
 * State lives in a Decision node with id mechanism:<slug> (metadata.kind is
 * "mechanism"), so it rides the existing graph store and audit chain.
 */
import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { isStopwordOnlyName } from "./skill-admission";
import { evaluateEfficiencyComparison, type EfficiencyArm } from "./efficiency-report";

export const MECHANISM_SCHEMA_VERSION = 1;
export const MECHANISM_ID_PREFIX = "mechanism:";

export type MechanismFamily = "tools" | "context" | "observation" | "delegation" | "prompt" | "method";
export type MechanismStatus = "proposed" | "in-trajectory" | "frozen" | "held-out" | "admitted" | "rejected";

export interface MechanismCapabilityFloor {
  /** Allowed capability regression ratio (0.05 = 5%). */
  tolerance: number;
}

export interface MechanismTrial {
  id: string;
  phase: "in-trajectory" | "held-out";
  recordedAt: string;
  tokenSavingRatio: number;
  scoreDeltaRatio?: number;
  responseCountDeltaRatio?: number;
  qualifies: boolean;
  reasons: string[];
  episodeId?: string;
}

export interface MechanismState {
  id: string;
  name: string;
  family: MechanismFamily;
  claim: string;
  efficiencyMetric: string;
  capabilityFloor: MechanismCapabilityFloor;
  status: MechanismStatus;
  createdAt: string;
  updatedAt: string;
  frozenAt?: string;
  trials: MechanismTrial[];
  decision?: { status: "admitted" | "rejected"; reason: string; at: string };
}

export interface ProposeMechanismInput {
  name: string;
  family: MechanismFamily;
  claim: string;
  efficiencyMetric: string;
  tolerance?: number;
  now?: string;
}

export interface MechanismReport {
  total: number;
  byStatus: Record<MechanismStatus, number>;
  admitted: number;
  rejected: number;
  /** In-trajectory trials recorded after freeze (must stay 0; enforced by recordMechanismTrial). */
  heldOutViolations: number;
  mechanisms: Array<{ id: string; name: string; family: MechanismFamily; status: MechanismStatus; trials: number; heldOutTrials: number; updatedAt: string }>;
}

const MECHANISM_STATUSES: MechanismStatus[] = ["proposed", "in-trajectory", "frozen", "held-out", "admitted", "rejected"];
const TERMINAL: ReadonlySet<MechanismStatus> = new Set(["admitted", "rejected"]);

export function sanitizeMechanismAtom(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function mechanismNodeId(name: string): string {
  return MECHANISM_ID_PREFIX + sanitizeMechanismAtom(name);
}

export function serializeMechanism(state: MechanismState): string {
  return JSON.stringify({ kind: "mechanism", ...state });
}

export function parseMechanism(content: string): MechanismState | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<MechanismState> & { kind?: string };
    if (parsed.kind !== "mechanism" || typeof parsed.id !== "string" || typeof parsed.name !== "string") {
      return undefined;
    }
    const family = parsed.family as MechanismFamily;
    if (family !== "tools" && family !== "context" && family !== "observation" && family !== "delegation" && family !== "prompt" && family !== "method") {
      return undefined;
    }
    const status = parsed.status as MechanismStatus;
    if (!MECHANISM_STATUSES.includes(status) || typeof parsed.claim !== "string") {
      return undefined;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      family,
      claim: parsed.claim,
      efficiencyMetric: typeof parsed.efficiencyMetric === "string" ? parsed.efficiencyMetric : "tokens",
      capabilityFloor: { tolerance: typeof parsed.capabilityFloor?.tolerance === "number" ? parsed.capabilityFloor.tolerance : 0.05 },
      status,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      ...(typeof parsed.frozenAt === "string" ? { frozenAt: parsed.frozenAt } : {}),
      trials: Array.isArray(parsed.trials) ? parsed.trials.filter((trial): trial is MechanismTrial => Boolean(trial) && typeof trial.id === "string" && (trial.phase === "in-trajectory" || trial.phase === "held-out")) : [],
      ...(parsed.decision && (parsed.decision.status === "admitted" || parsed.decision.status === "rejected")
        ? { decision: { status: parsed.decision.status, reason: String(parsed.decision.reason ?? ""), at: String(parsed.decision.at ?? "") } }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export async function readMechanism(client: GraphClient, id: string): Promise<MechanismState | undefined> {
  const key = id.startsWith(MECHANISM_ID_PREFIX) ? id : mechanismNodeId(id);
  const matches = (nodes: GraphNode[]): MechanismState | undefined =>
    nodes
      .map((node) => parseMechanism(node.content))
      .find((parsed): parsed is MechanismState => parsed?.id === key);
  if (typeof client.getNodesByIds === "function") {
    const direct = matches(await client.getNodesByIds([key]));
    // A keyword fallback can return a sibling mechanism, so identity is matched
    // by exact id rather than "any parsed state".
    if (direct) return direct;
  }
  return matches(await client.queryByKeyword(key));
}

export async function listMechanisms(client: GraphClient): Promise<MechanismState[]> {
  const snapshot = client.readSnapshot?.();
  const nodes: GraphNode[] = snapshot?.nodes
    ? snapshot.nodes.filter((node) => node.id.startsWith(MECHANISM_ID_PREFIX))
    : (await client.queryByKeyword("mechanism")).filter((node) =>
        node.id.startsWith(MECHANISM_ID_PREFIX)
      );
  const byId = new Map<string, MechanismState>();
  for (const node of nodes) {
    const parsed = parseMechanism(node.content);
    if (parsed) byId.set(parsed.id, parsed);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function writeMechanism(client: GraphClient, state: MechanismState): Promise<void> {
  await client.upsertNodes([
    {
      id: state.id,
      type: "Decision",
      content: serializeMechanism(state),
      metadata: { kind: "mechanism", schemaVersion: MECHANISM_SCHEMA_VERSION, family: state.family, status: state.status },
    },
  ]);
}

function assertProposal(input: ProposeMechanismInput): void {
  const name = input.name.trim();
  const claim = input.claim.trim();
  if (name.length < 3 || input.name.length > 120) throw new Error("mechanism name must be 3..120 characters");
  if (isStopwordOnlyName(name)) throw new Error("mechanism name is structural noise (stopword-only)");
  if (claim.length < 20) throw new Error("mechanism claim must state the avoidable work (>= 20 characters)");
  if (!input.efficiencyMetric.trim()) throw new Error("mechanism efficiencyMetric is required");
}

export async function proposeMechanism(client: GraphClient, input: ProposeMechanismInput): Promise<MechanismState> {
  assertProposal(input);
  const id = mechanismNodeId(input.name);
  const existing = await readMechanism(client, id);
  if (existing && !TERMINAL.has(existing.status)) {
    throw new Error("mechanism already proposed: " + id + " (status " + existing.status + ")");
  }
  const now = input.now ?? new Date().toISOString();
  const state: MechanismState = {
    id,
    name: input.name.trim(),
    family: input.family,
    claim: input.claim.trim(),
    efficiencyMetric: input.efficiencyMetric.trim(),
    capabilityFloor: { tolerance: typeof input.tolerance === "number" && Number.isFinite(input.tolerance) ? Math.min(Math.max(input.tolerance, 0), 1) : 0.05 },
    status: "proposed",
    createdAt: now,
    updatedAt: now,
    trials: [],
  };
  await writeMechanism(client, state);
  return state;
}

export interface RecordTrialInput {
  id: string;
  phase: "in-trajectory" | "held-out";
  baseline: EfficiencyArm;
  packaged: EfficiencyArm;
  episodeId?: string;
  now?: string;
}

export async function recordMechanismTrial(client: GraphClient, input: RecordTrialInput): Promise<MechanismState> {
  const state = await readMechanism(client, input.id);
  if (!state) throw new Error("unknown mechanism: " + input.id);
  if (TERMINAL.has(state.status)) throw new Error("mechanism " + state.id + " is " + state.status + "; no new trials accepted");
  if (state.frozenAt && input.phase === "in-trajectory") {
    throw new Error("held-out isolation: mechanism " + state.id + " is frozen; in-trajectory trials are no longer accepted");
  }

  const evaluation = evaluateEfficiencyComparison(
    { query: state.claim, baseline: input.baseline, packaged: input.packaged, source: "benchmark", ...(input.episodeId ? { episodeId: input.episodeId } : {}), mechanismId: state.id },
    { tolerance: state.capabilityFloor.tolerance, ...(input.now ? { now: input.now } : {}) }
  );
  const trial: MechanismTrial = {
    id: state.id + ":trial:" + (state.trials.length + 1),
    phase: input.phase,
    recordedAt: evaluation.timestamp,
    tokenSavingRatio: evaluation.tokenSavingRatio,
    qualifies: evaluation.qualifies,
    reasons: evaluation.reasons,
    ...(evaluation.scoreDeltaRatio !== undefined ? { scoreDeltaRatio: evaluation.scoreDeltaRatio } : {}),
    ...(evaluation.responseCountDeltaRatio !== undefined ? { responseCountDeltaRatio: evaluation.responseCountDeltaRatio } : {}),
    ...(input.episodeId ? { episodeId: input.episodeId } : {}),
  };
  const next: MechanismState = {
    ...state,
    status: input.phase === "held-out" ? "held-out" : "in-trajectory",
    updatedAt: trial.recordedAt,
    trials: [...state.trials, trial],
  };
  await writeMechanism(client, next);
  return next;
}

export async function freezeMechanism(client: GraphClient, id: string, options: { now?: string } = {}): Promise<MechanismState> {
  const state = await readMechanism(client, id);
  if (!state) throw new Error("unknown mechanism: " + id);
  if (TERMINAL.has(state.status)) throw new Error("mechanism " + state.id + " is " + state.status + "; cannot freeze");
  if (state.frozenAt) return state;
  const screened = state.trials.filter((trial) => trial.phase === "in-trajectory");
  if (screened.length === 0) throw new Error("mechanism " + state.id + " has no in-trajectory trial; nothing to freeze");
  const now = options.now ?? new Date().toISOString();
  const next: MechanismState = { ...state, status: "frozen", frozenAt: now, updatedAt: now };
  await writeMechanism(client, next);
  return next;
}

export interface AdmissionResult { admitted: boolean; state: MechanismState; failures: string[]; }

export async function admitMechanism(client: GraphClient, id: string, options: { reason?: string; now?: string } = {}): Promise<AdmissionResult> {
  const state = await readMechanism(client, id);
  if (!state) throw new Error("unknown mechanism: " + id);
  if (TERMINAL.has(state.status)) throw new Error("mechanism " + state.id + " is terminal (" + state.status + ")");

  const failures: string[] = [];
  if (!state.frozenAt) failures.push("candidate is not frozen");
  const heldOut = state.trials.filter((trial) => trial.phase === "held-out");
  if (heldOut.length === 0) failures.push("no held-out trial recorded");
  const regressing = heldOut.filter((trial) => !trial.qualifies);
  if (regressing.length > 0) failures.push("held-out capability/efficiency floor failed: " + regressing.flatMap((trial) => trial.reasons).join(","));

  const admitted = failures.length === 0;
  const now = options.now ?? new Date().toISOString();
  const next: MechanismState = admitted
    ? { ...state, status: "admitted", updatedAt: now, decision: { status: "admitted", reason: options.reason ?? "capability floor met with a qualifying held-out trial", at: now } }
    : state;
  if (admitted) await writeMechanism(client, next);
  return { admitted, state: next, failures };
}

export async function rejectMechanism(client: GraphClient, id: string, reason: string, options: { now?: string } = {}): Promise<MechanismState> {
  const state = await readMechanism(client, id);
  if (!state) throw new Error("unknown mechanism: " + id);
  if (TERMINAL.has(state.status)) throw new Error("mechanism " + state.id + " is terminal (" + state.status + ")");
  const now = options.now ?? new Date().toISOString();
  const next: MechanismState = { ...state, status: "rejected", updatedAt: now, decision: { status: "rejected", reason: reason || "rejected", at: now } };
  await writeMechanism(client, next);
  return next;
}

export async function getMechanismReport(client: GraphClient): Promise<MechanismReport> {
  const mechanisms = await listMechanisms(client);
  const byStatus = Object.fromEntries(MECHANISM_STATUSES.map((status) => [status, 0])) as Record<MechanismStatus, number>;
  let heldOutViolations = 0;
  for (const mechanism of mechanisms) {
    byStatus[mechanism.status] += 1;
    if (mechanism.frozenAt) {
      for (const trial of mechanism.trials) {
        if (trial.phase === "in-trajectory" && trial.recordedAt > mechanism.frozenAt) heldOutViolations += 1;
      }
    }
  }
  return {
    total: mechanisms.length,
    byStatus,
    admitted: byStatus.admitted,
    rejected: byStatus.rejected,
    heldOutViolations,
    mechanisms: mechanisms.map((mechanism) => ({
      id: mechanism.id,
      name: mechanism.name,
      family: mechanism.family,
      status: mechanism.status,
      trials: mechanism.trials.length,
      heldOutTrials: mechanism.trials.filter((trial) => trial.phase === "held-out").length,
      updatedAt: mechanism.updatedAt,
    })),
  };
}
