#!/usr/bin/env npx tsx
/**
 * Minimal third-party ATP Producer example.
 *
 * Emits a simple-plan AgentWorkItem set (no network). Compatible consumers
 * (e.g. GraphFlow graphflow_insight submit/merge) accept these IDs/kinds.
 *
 * Run: npx tsx examples/atp-minimal-producer/producer.ts [task text...]
 */

import { buildMinimalSimplePlanWorkItems } from "../../src/agents/atp-example-producer.js";

const task =
  process.argv.slice(2).join(" ").trim() ||
  "Add a cache layer for the tokenizer and verify with unit tests";

const workItems = buildMinimalSimplePlanWorkItems(task);

const payload = {
  protocol: "atp-ir/1.1",
  role: "producer",
  mode: "simple-plan",
  task,
  agentWorkItems: workItems,
  agentInstructions: [
    "Answer each REQUIRED work item as JSON only.",
    'Submit via a compatible consumer (GraphFlow: graphflow_insight mode=submit).',
    'After both required items are submitted, merge (GraphFlow: graphflow_insight mode=merge).',
    "Optional: submit alignment-check after execution, then report_outcome.",
  ].join("\n"),
  status: "awaiting-agent",
  requiresAgentBridge: true,
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
