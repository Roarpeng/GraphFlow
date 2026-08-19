import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";

/**
 * Workbench topic containers: the canvas node is a *function/topic*, not a turn.
 *
 * Complex task → seed a root + one topic per plan DAG step (mainline).
 * Click a topic → that container becomes active; further Q&A appends as messages.
 * Drift → an isolated (non-mainline) topic is forked so the mainline stays clean.
 * Click a mainline topic → active pointer jumps back; next context is Goal + path + local messages.
 */

export const WORKBENCH_ROOT_PREFIX = "workbench:";
export const WORKBENCH_TOPIC_PREFIX = "topic:";
export const WORKBENCH_ROOT_KIND = "workbench-root";
export const WORKBENCH_TOPIC_KIND = "workbench-topic";

const MAX_TITLE = 48;
const MAX_DESCRIPTION = 400;
const MAX_MESSAGE = 4_000;
const MAX_MESSAGES_PER_TOPIC = 40;
const DRIFT_OVERLAP_THRESHOLD = 0.18;

export interface WorkbenchMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export interface WorkbenchTopicRecord {
  id: string;
  rootId: string;
  title: string;
  description: string;
  mainline: boolean;
  isolated: boolean;
  planStepId?: string;
  messages: WorkbenchMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkbenchRootRecord {
  id: string;
  task: string;
  activeTopicId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanStepSeed {
  id: string;
  description: string;
  dependencies: string[];
}

export interface WorkbenchContextView {
  rootId: string;
  task: string;
  active: WorkbenchTopicRecord;
  ancestors: Array<{ id: string; title: string; description: string }>;
  isolated: boolean;
  promptLines: string[];
  outline?: WorkbenchOutline;
}

/** On-demand outline tree. Titles are display labels from the plan DAG / first drifted question. */
export interface WorkbenchOutlineNode {
  id: string;
  title: string;
  kind: "mainline" | "side";
  active: boolean;
  messageCount: number;
  pendingReply: boolean;
  lastUserPreview?: string;
  children: WorkbenchOutlineNode[];
}

export interface WorkbenchOutline {
  rootId: string;
  task: string;
  activeTopicId: string;
  nodes: WorkbenchOutlineNode[];
}

export function workbenchRootIdFor(task: string, workspaceRoot?: string): string {
  return `${WORKBENCH_ROOT_PREFIX}${hashText(`${normalizeTask(task)}|${(workspaceRoot ?? "").trim().toLowerCase()}`)}`;
}

export function workbenchTopicIdFor(rootId: string, planStepId: string): string {
  const rootHash = rootId.startsWith(WORKBENCH_ROOT_PREFIX)
    ? rootId.slice(WORKBENCH_ROOT_PREFIX.length)
    : hashText(rootId);
  return `${WORKBENCH_TOPIC_PREFIX}${rootHash}:${planStepId}`;
}

export function isWorkbenchTopicNode(node: GraphNode): boolean {
  return node.metadata?.kind === WORKBENCH_TOPIC_KIND || node.id.startsWith(WORKBENCH_TOPIC_PREFIX);
}

export function isWorkbenchRootNode(node: GraphNode): boolean {
  return node.metadata?.kind === WORKBENCH_ROOT_KIND || node.id.startsWith(WORKBENCH_ROOT_PREFIX);
}

export function parseWorkbenchTopic(node: GraphNode): WorkbenchTopicRecord | undefined {
  if (!isWorkbenchTopicNode(node)) return undefined;
  return deserializeTopic(node);
}

export function buildWorkbenchOutlines(nodes: GraphNode[], edges: GraphEdge[]): WorkbenchOutline[] {
  const roots = nodes
    .map((node) => (isWorkbenchRootNode(node) ? deserializeRoot(node) : undefined))
    .filter((root): root is WorkbenchRootRecord => Boolean(root))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const topics = nodes
    .map((node) => parseWorkbenchTopic(node))
    .filter((topic): topic is WorkbenchTopicRecord => Boolean(topic));
  if (roots.length === 0 && topics.length === 0) {
    return [];
  }

  const parentBySide = new Map<string, string>();
  for (const edge of edges) {
    if (edge.relation !== "co_occurs") continue;
    const from = topics.find((topic) => topic.id === edge.from);
    if (from?.isolated) {
      parentBySide.set(from.id, edge.to);
    }
  }

  return roots.map((root) => {
    const owned = topics.filter((topic) => topic.rootId === root.id);
    const mainline = orderMainline(
      owned.filter((topic) => topic.mainline && !topic.isolated),
      edges
    );
    const sides = owned.filter((topic) => topic.isolated);
    const attached = new Set<string>();
    const nodesForRoot: WorkbenchOutlineNode[] = mainline.map((topic) => {
      const children = sides
        .filter((side) => parentBySide.get(side.id) === topic.id)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((side) => {
          attached.add(side.id);
          return toOutlineNode(side, root.activeTopicId, []);
        });
      return toOutlineNode(topic, root.activeTopicId, children);
    });
    for (const side of sides) {
      if (attached.has(side.id)) continue;
      nodesForRoot.push(toOutlineNode(side, root.activeTopicId, []));
    }
    return {
      rootId: root.id,
      task: root.task,
      activeTopicId: root.activeTopicId,
      nodes: nodesForRoot,
    };
  });
}

export function formatWorkbenchOutlineLines(outlines: WorkbenchOutline[]): string[] {
  if (outlines.length === 0) {
    return ["Workbench: (empty) — call graphflow_plan to seed the function DAG."];
  }
  const lines: string[] = [];
  const walk = (node: WorkbenchOutlineNode, depth: number): void => {
    lines.push(formatOutlineLine(node, depth));
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };
  for (const outline of outlines) {
    lines.push(`Workbench: ${clip(outline.task, 80)}`);
    for (const node of outline.nodes) {
      walk(node, 0);
    }
    lines.push(`Resume: graphflow_context({ topicId: "${outline.activeTopicId}" })`);
  }
  return lines;
}

export async function loadWorkbenchOutlines(client: GraphClient): Promise<WorkbenchOutline[]> {
  const snapshot = client.readSnapshot?.();
  if (snapshot) {
    return buildWorkbenchOutlines(snapshot.nodes, snapshot.edges);
  }
  return buildWorkbenchOutlines(await collectWorkbenchNodes(client), []);
}

function formatOutlineLine(node: WorkbenchOutlineNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const mark = node.kind === "side" ? "旁支" : "主线";
  const active = node.active ? " [active]" : "";
  const pending = node.pendingReply ? " pending" : "";
  return `${indent}${mark}${active}${pending}: ${node.title}  ${node.id}`;
}

function toOutlineNode(
  topic: WorkbenchTopicRecord,
  activeTopicId: string,
  children: WorkbenchOutlineNode[]
): WorkbenchOutlineNode {
  const lastUser = [...topic.messages].reverse().find((message) => message.role === "user");
  return {
    id: topic.id,
    title: topic.title,
    kind: topic.isolated ? "side" : "mainline",
    active: topic.id === activeTopicId,
    messageCount: topic.messages.length,
    pendingReply: topic.messages[topic.messages.length - 1]?.role === "user",
    ...(lastUser ? { lastUserPreview: clip(lastUser.content, 72) } : {}),
    children,
  };
}

function orderMainline(topics: WorkbenchTopicRecord[], edges: GraphEdge[]): WorkbenchTopicRecord[] {
  if (topics.length <= 1) return [...topics];
  const ids = new Set(topics.map((topic) => topic.id));
  const remaining = new Map<string, number>();
  const blockedBy = new Map<string, string[]>();
  for (const topic of topics) {
    remaining.set(topic.id, 0);
    blockedBy.set(topic.id, []);
  }
  for (const edge of edges) {
    if (edge.relation !== "depends_on" || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    remaining.set(edge.from, (remaining.get(edge.from) ?? 0) + 1);
    blockedBy.get(edge.to)?.push(edge.from);
  }
  const ready = topics
    .filter((topic) => (remaining.get(topic.id) ?? 0) === 0)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const ordered: WorkbenchTopicRecord[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    ordered.push(next);
    for (const id of blockedBy.get(next.id) ?? []) {
      const left = (remaining.get(id) ?? 1) - 1;
      remaining.set(id, left);
      if (left === 0) {
        const topic = topics.find((item) => item.id === id);
        if (topic) ready.push(topic);
        ready.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      }
    }
  }
  for (const topic of topics) {
    if (!seen.has(topic.id)) ordered.push(topic);
  }
  return ordered;
}

export async function seedWorkbenchFromPlan(
  client: GraphClient,
  input: { task: string; steps: PlanStepSeed[]; workspaceRoot?: string; now?: number }
): Promise<{ root: WorkbenchRootRecord; topics: WorkbenchTopicRecord[] }> {
  const now = input.now ?? Date.now();
  const steps = input.steps.filter((step) => step.id.trim() && step.description.trim());
  const rootId = workbenchRootIdFor(input.task, input.workspaceRoot);
  const existingRoot = await loadRoot(client, rootId);

  const topics: WorkbenchTopicRecord[] = [];
  const idByStep = new Map<string, string>();

  if (steps.length === 0) {
    const fallbackId = workbenchTopicIdFor(rootId, "root");
    const topic = (await loadTopic(client, fallbackId)) ?? {
      id: fallbackId,
      rootId,
      title: clip(input.task, MAX_TITLE),
      description: clip(input.task, MAX_DESCRIPTION),
      mainline: true,
      isolated: false,
      planStepId: "root",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    topics.push(topic);
    idByStep.set("root", topic.id);
  } else {
    for (const step of steps) {
      const id = workbenchTopicIdFor(rootId, step.id);
      const prior = await loadTopic(client, id);
      const topic: WorkbenchTopicRecord = prior
        ? {
            ...prior,
            title: prior.title || titleFromDescription(step.description),
            description: prior.description || clip(step.description, MAX_DESCRIPTION),
            mainline: true,
            isolated: false,
            updatedAt: now,
          }
        : {
            id,
            rootId,
            title: titleFromDescription(step.description),
            description: clip(step.description, MAX_DESCRIPTION),
            mainline: true,
            isolated: false,
            planStepId: step.id,
            messages: [],
            createdAt: now,
            updatedAt: now,
          };
      topics.push(topic);
      idByStep.set(step.id, id);
    }
  }

  const activeTopicId =
    existingRoot?.activeTopicId && topics.some((topic) => topic.id === existingRoot.activeTopicId)
      ? existingRoot.activeTopicId
      : topics[0]!.id;

  const root: WorkbenchRootRecord = {
    id: rootId,
    task: input.task.trim(),
    activeTopicId,
    createdAt: existingRoot?.createdAt ?? now,
    updatedAt: now,
  };

  await persistRoot(client, root);
  for (const topic of topics) {
    await persistTopic(client, topic);
    await upsertUniqueEdges(client, [{ from: topic.id, to: root.id, relation: "part_of" }]);
  }
  for (const step of steps) {
    const fromId = idByStep.get(step.id);
    if (!fromId) continue;
    for (const dep of step.dependencies) {
      const toId = idByStep.get(dep);
      if (!toId) continue;
      await upsertUniqueEdges(client, [{ from: fromId, to: toId, relation: "depends_on" }]);
    }
  }

  return { root, topics };
}

export async function activateTopic(
  client: GraphClient,
  topicId: string,
  now = Date.now()
): Promise<WorkbenchTopicRecord | undefined> {
  const topic = await loadTopic(client, topicId);
  if (!topic) return undefined;
  const root = await loadRoot(client, topic.rootId);
  if (!root) return topic;
  await persistRoot(client, { ...root, activeTopicId: topic.id, updatedAt: now });
  return topic;
}

export async function forkIsolatedTopic(
  client: GraphClient,
  input: { fromTopicId: string; title: string; description?: string; now?: number }
): Promise<WorkbenchTopicRecord | undefined> {
  const parent = await loadTopic(client, input.fromTopicId);
  if (!parent) return undefined;
  const now = input.now ?? Date.now();
  const forkKey = `fork-${hashText(`${parent.id}|${input.title}|${now}`)}`;
  const topic: WorkbenchTopicRecord = {
    id: workbenchTopicIdFor(parent.rootId, forkKey),
    rootId: parent.rootId,
    title: titleFromDescription(input.title),
    description: clip(input.description || input.title, MAX_DESCRIPTION),
    mainline: false,
    isolated: true,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await persistTopic(client, topic);
  await upsertUniqueEdges(client, [
    { from: topic.id, to: parent.rootId, relation: "part_of" },
    { from: topic.id, to: parent.id, relation: "co_occurs" },
  ]);
  const root = await loadRoot(client, parent.rootId);
  if (root) {
    await persistRoot(client, { ...root, activeTopicId: topic.id, updatedAt: now });
  }
  return topic;
}

export async function appendTopicMessage(
  client: GraphClient,
  input: {
    query?: string;
    workspaceRoot?: string;
    taskHint?: string;
    topicId?: string;
    assistantReply?: string;
    allowAutoFork?: boolean;
    now?: number;
  }
): Promise<{ topic: WorkbenchTopicRecord; forked: boolean; filled: boolean } | undefined> {
  const query = clip(input.query ?? "", MAX_MESSAGE);
  const reply = clip(input.assistantReply ?? "", MAX_MESSAGE);
  const now = input.now ?? Date.now();

  let topic = input.topicId
    ? await activateTopic(client, input.topicId, now)
    : await loadActiveTopic(client, input.workspaceRoot, input.taskHint);

  if (!topic) return undefined;

  const filled = fillPendingAssistant(topic, query, reply, now);
  if (filled) {
    await persistTopic(client, filled);
    return { topic: filled, forked: false, filled: true };
  }

  if (query.trim().length < 4) return undefined;

  const explicitClick = Boolean(input.topicId);
  const shouldFork =
    input.allowAutoFork !== false &&
    !explicitClick &&
    topic.mainline &&
    topic.messages.filter((message) => message.role === "user").length >= 1 &&
    scoreOverlap(topicTokens(topic), query) < DRIFT_OVERLAP_THRESHOLD;

  if (shouldFork) {
    const forked = await forkIsolatedTopic(client, {
      fromTopicId: topic.id,
      title: query,
      description: query,
      now,
    });
    if (forked) {
      topic = forked;
    }
  }

  const messages = [
    ...topic.messages,
    { role: "user" as const, content: query, at: now },
    ...(reply.trim() ? [{ role: "assistant" as const, content: reply, at: now }] : []),
  ].slice(-MAX_MESSAGES_PER_TOPIC);

  const updated: WorkbenchTopicRecord = { ...topic, messages, updatedAt: now };
  await persistTopic(client, updated);
  return { topic: updated, forked: shouldFork && updated.isolated, filled: false };
}

export function topicPendingReply(topic: WorkbenchTopicRecord): boolean {
  return topic.messages[topic.messages.length - 1]?.role === "user";
}

function fillPendingAssistant(
  topic: WorkbenchTopicRecord,
  query: string,
  reply: string,
  now: number
): WorkbenchTopicRecord | undefined {
  if (!reply.trim()) return undefined;
  const messages = topic.messages;
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];

  if (last?.role === "user") {
    if (query.trim().length >= 4 && normalizeMessage(query) !== normalizeMessage(last.content)) {
      return undefined;
    }
    return {
      ...topic,
      messages: [...messages, { role: "assistant" as const, content: reply, at: now }].slice(-MAX_MESSAGES_PER_TOPIC),
      updatedAt: now,
    };
  }

  if (
    last?.role === "assistant" &&
    prev?.role === "user" &&
    query.trim().length >= 4 &&
    normalizeMessage(query) === normalizeMessage(prev.content)
  ) {
    return {
      ...topic,
      messages: [...messages.slice(0, -1), { role: "assistant" as const, content: reply, at: now }].slice(-MAX_MESSAGES_PER_TOPIC),
      updatedAt: now,
    };
  }
  return undefined;
}

function normalizeMessage(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function loadActiveTopic(
  client: GraphClient,
  workspaceRoot?: string,
  taskHint?: string
): Promise<WorkbenchTopicRecord | undefined> {
  if (taskHint?.trim()) {
    const root = await loadRoot(client, workbenchRootIdFor(taskHint, workspaceRoot));
    if (root) {
      return loadTopic(client, root.activeTopicId);
    }
  }
  const roots = (await collectWorkbenchNodes(client)).filter(isWorkbenchRootNode);
  if (roots.length === 0) return undefined;
  roots.sort((a, b) => {
    const ar = deserializeRoot(a)?.updatedAt ?? 0;
    const br = deserializeRoot(b)?.updatedAt ?? 0;
    return br - ar;
  });
  const root = deserializeRoot(roots[0]!);
  if (!root) return undefined;
  return loadTopic(client, root.activeTopicId);
}

export async function loadWorkbenchContext(
  client: GraphClient,
  topicId: string
): Promise<WorkbenchContextView | undefined> {
  const active = await loadTopic(client, topicId);
  if (!active) return undefined;
  const root = await loadRoot(client, active.rootId);
  if (!root) return undefined;
  const ancestors = await loadAncestors(client, active);
  const promptLines = formatWorkbenchPrompt({
    rootId: root.id,
    task: root.task,
    active,
    ancestors,
    isolated: active.isolated,
    promptLines: [],
  });
  const outline = (await loadWorkbenchOutlines(client)).find((item) => item.rootId === root.id);
  return {
    rootId: root.id,
    task: root.task,
    active,
    ancestors,
    isolated: active.isolated,
    promptLines,
    ...(outline ? { outline } : {}),
  };
}

export function formatWorkbenchPrompt(view: WorkbenchContextView): string[] {
  const lines = [
    `Workbench: ${clip(view.task, 80)}`,
    `Active: ${view.active.isolated ? "旁支" : "主线"} 「${view.active.title}」 (${view.active.id})`,
  ];
  if (view.ancestors.length > 0) {
    lines.push(
      `Path: ${view.ancestors.map((item) => item.title).join(" → ")} → ${view.active.title}`
    );
  }
  if (view.isolated) {
    lines.push(`Isolated: 当前不在主线。点回主线节点并传入 topicId 可恢复主干上下文。`);
  }
  const recent = view.active.messages.slice(-6);
  for (const message of recent) {
    lines.push(`${message.role === "user" ? "Q" : "A"}: ${clip(message.content, 100)}`);
  }
  lines.push(`Resume: graphflow_context({ topicId: "${view.active.id}" })`);
  return lines;
}

export function scoreOverlap(previousTokens: string[], query: string): number {
  const next = tokenize(query);
  if (previousTokens.length === 0 || next.length === 0) return 1;
  const prev = new Set(previousTokens);
  let hit = 0;
  for (const token of next) {
    if (prev.has(token)) hit += 1;
  }
  return hit / next.length;
}

function topicTokens(topic: WorkbenchTopicRecord): string[] {
  const blob = [topic.title, topic.description, ...topic.messages.map((message) => message.content)].join(" ");
  return tokenize(blob);
}

async function loadAncestors(
  client: GraphClient,
  topic: WorkbenchTopicRecord
): Promise<Array<{ id: string; title: string; description: string }>> {
  if (typeof client.getNeighbors !== "function") return [];
  const chain: Array<{ id: string; title: string; description: string }> = [];
  const seen = new Set<string>([topic.id]);
  let frontier = [topic.id];
  for (let depth = 0; depth < 6 && frontier.length > 0; depth += 1) {
    const neighbors = await client.getNeighbors(frontier, ["depends_on"], "out");
    const next: string[] = [];
    for (const { node } of neighbors) {
      if (seen.has(node.id)) continue;
      const rec = parseWorkbenchTopic(node);
      if (!rec) continue;
      seen.add(node.id);
      chain.push({ id: rec.id, title: rec.title, description: rec.description });
      next.push(rec.id);
    }
    frontier = next;
  }
  return chain.reverse();
}

async function persistTopic(client: GraphClient, topic: WorkbenchTopicRecord): Promise<void> {
  const prefix = topic.isolated ? "旁支" : "主线";
  await client.upsertNodes([
    {
      id: topic.id,
      type: "Decision",
      content: `workbench-topic ${prefix} ${topic.title} # ${clip(topic.description, 120)}`,
      metadata: {
        kind: WORKBENCH_TOPIC_KIND,
        record: JSON.stringify(topic),
        mainline: topic.mainline,
        isolated: topic.isolated,
        title: topic.title,
      },
    },
  ]);
}

async function persistRoot(client: GraphClient, root: WorkbenchRootRecord): Promise<void> {
  await client.upsertNodes([
    {
      id: root.id,
      type: "Decision",
      content: `workbench-root ${clip(root.task, 160)} active=${root.activeTopicId}`,
      metadata: {
        kind: WORKBENCH_ROOT_KIND,
        record: JSON.stringify(root),
        activeTopicId: root.activeTopicId,
      },
    },
  ]);
}

async function loadTopic(client: GraphClient, topicId: string): Promise<WorkbenchTopicRecord | undefined> {
  const node = await loadNode(client, topicId);
  return node ? parseWorkbenchTopic(node) : undefined;
}

async function loadRoot(client: GraphClient, rootId: string): Promise<WorkbenchRootRecord | undefined> {
  const node = await loadNode(client, rootId);
  return node && isWorkbenchRootNode(node) ? deserializeRoot(node) : undefined;
}

async function loadNode(client: GraphClient, id: string): Promise<GraphNode | undefined> {
  if (typeof client.getNodesByIds === "function") {
    const nodes = await client.getNodesByIds([id]);
    return nodes.find((node) => node.id === id);
  }
  return (await collectWorkbenchNodes(client)).find((node) => node.id === id);
}

async function collectWorkbenchNodes(client: GraphClient): Promise<GraphNode[]> {
  const snapshot = client.readSnapshot?.();
  if (snapshot) {
    return snapshot.nodes.filter((node) => isWorkbenchTopicNode(node) || isWorkbenchRootNode(node));
  }
  const byId = new Map<string, GraphNode>();
  for (const query of ["workbench-topic", "workbench-root", WORKBENCH_TOPIC_PREFIX]) {
    for (const node of await client.queryByKeyword(query)) {
      if (isWorkbenchTopicNode(node) || isWorkbenchRootNode(node)) {
        byId.set(node.id, node);
      }
    }
  }
  return Array.from(byId.values());
}

async function upsertUniqueEdges(client: GraphClient, edges: GraphEdge[]): Promise<void> {
  if (edges.length === 0) return;
  const snapshot = client.readSnapshot?.();
  const existing = new Set(
    (snapshot?.edges ?? []).map((edge) => `${edge.from}|${edge.relation}|${edge.to}`)
  );
  const fresh = edges.filter((edge) => !existing.has(`${edge.from}|${edge.relation}|${edge.to}`));
  if (fresh.length === 0) return;
  await client.upsertEdges(fresh);
}

function deserializeTopic(node: GraphNode): WorkbenchTopicRecord | undefined {
  const raw = typeof node.metadata?.record === "string" ? node.metadata.record : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkbenchTopicRecord>;
    if (typeof parsed.id !== "string" || typeof parsed.title !== "string") return undefined;
    return {
      id: parsed.id,
      rootId: typeof parsed.rootId === "string" ? parsed.rootId : "",
      title: parsed.title,
      description: typeof parsed.description === "string" ? parsed.description : "",
      mainline: parsed.mainline !== false,
      isolated: parsed.isolated === true,
      ...(typeof parsed.planStepId === "string" ? { planStepId: parsed.planStepId } : {}),
      messages: Array.isArray(parsed.messages)
        ? parsed.messages
            .filter((item): item is WorkbenchMessage => {
              return Boolean(
                item &&
                  (item.role === "user" || item.role === "assistant") &&
                  typeof item.content === "string"
              );
            })
            .map((item) => ({ role: item.role, content: item.content, at: item.at ?? 0 }))
        : [],
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

function deserializeRoot(node: GraphNode): WorkbenchRootRecord | undefined {
  const raw = typeof node.metadata?.record === "string" ? node.metadata.record : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkbenchRootRecord>;
    if (typeof parsed.id !== "string" || typeof parsed.task !== "string") return undefined;
    return {
      id: parsed.id,
      task: parsed.task,
      activeTopicId: typeof parsed.activeTopicId === "string" ? parsed.activeTopicId : "",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

function titleFromDescription(description: string): string {
  const cleaned = description.replace(/^\s*(分析与设计|实现|测试设计|验证)\s*[:：]\s*/u, "").trim();
  return clip(cleaned || description, MAX_TITLE);
}

function normalizeTask(task: string): string {
  return task.trim().toLowerCase();
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (raw.length >= 2) out.add(raw);
  }
  return Array.from(out);
}
