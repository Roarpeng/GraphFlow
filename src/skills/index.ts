import { previewContext, indexGraph, inspectGraph, expandAnchor } from "../surfaces/cli/runtime/graph";
import { planAndBrainstormResult, planInsightResult, runTaskResult } from "../surfaces/cli/runtime/routing";
import type { ContextPreviewResult, GraphSnapshotResult } from "../surfaces/cli/runtime/types";
import type { SixHatsInsight } from "../agents/insight";

export interface SkillInvocationOptions {
  rootDir?: string;
  configPath?: string;
}

export interface CompressContextInput extends SkillInvocationOptions {
  query: string;
  maxTokens?: number;
}

export interface CompressContextOutput {
  success: boolean;
  compressed: string[];
  anchors: Array<{ id: string; type: string; layer: "L1" | "L2" | "L3" }>;
  tokenBudget: {
    maxContextTokens: number;
    estimatedRawTokens: number;
    compressedTokens: number;
    estimatedSavingsPercent: number;
  };
  detail?: ContextPreviewResult;
}

export interface PlanTaskInput extends SkillInvocationOptions {
  task: string;
  mode?: "simple" | "complex";
}

export interface PlanTaskOutput {
  success: boolean;
  mode: "simple" | "complex";
  ideas: string[];
  nodes: Array<{ id: string; description: string; dependencies: string[] }>;
}

export interface PlanInsightInput extends SkillInvocationOptions {
  task: string;
}

export interface PlanInsightOutput {
  success: boolean;
  insight?: SixHatsInsight;
}

export interface IndexGraphInput extends SkillInvocationOptions {
  includeExtensions?: string[];
}

export interface IndexGraphOutput {
  success: boolean;
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
}

export interface InspectGraphInput extends SkillInvocationOptions {
  nodeLimit?: number;
  edgeLimit?: number;
}

export interface InspectGraphOutput {
  success: boolean;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCount: Record<string, number>;
  topRelations: Array<{ relation: string; count: number }>;
  sampleNodes: Array<{ id: string; type: string; label: string }>;
  detail?: GraphSnapshotResult;
}

export interface ExpandAnchorInput extends SkillInvocationOptions {
  anchorId: string;
}

export interface ExpandAnchorOutput {
  success: boolean;
  anchorId: string;
  type?: string;
  content?: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceSnippet?: string;
}

export interface RunTaskInput extends SkillInvocationOptions {
  task: string;
}

export interface RunTaskOutput {
  success: boolean;
  status: string;
  attempts: number;
  feedback: string;
  executionDescriptor?: {
    action: string;
    task: string;
    context: string;
    retryHints: string[];
  };
}

export const graphflowSkills = {
  "graphflow.compress": {
    name: "graphflow.compress",
    description: "Compress codebase context using graph-based retrieval and token-efficient packaging.",
    version: "1.0.0",
    async invoke(input: CompressContextInput): Promise<CompressContextOutput> {
      const result = await previewContext(input.query, input.configPath, input.rootDir);
      return {
        success: true,
        compressed: result.summary,
        anchors: result.anchors,
        tokenBudget: result.tokenBudget,
        detail: result,
      };
    },
  },

  "graphflow.plan": {
    name: "graphflow.plan",
    description: "Plan a coding task with graph context, producing structured task nodes with dependencies.",
    version: "1.0.0",
    async invoke(input: PlanTaskInput): Promise<PlanTaskOutput> {
      const result = await planAndBrainstormResult(input.task);
      return {
        success: true,
        mode: result.mode,
        ideas: result.ideas,
        nodes: result.nodes,
      };
    },
  },

  "graphflow.planInsight": {
    name: "graphflow.planInsight",
    description: "Analyze a task using Six Thinking Hats + 5 Whys structured thinking framework.",
    version: "1.0.0",
    async invoke(input: PlanInsightInput): Promise<PlanInsightOutput> {
      const result = await planInsightResult(input.task, input.configPath);
      return {
        success: true,
        insight: result as unknown as SixHatsInsight,
      };
    },
  },

  "graphflow.index": {
    name: "graphflow.index",
    description: "Index a codebase into the knowledge graph for context-aware retrieval.",
    version: "1.0.0",
    async invoke(input: IndexGraphInput = {}): Promise<IndexGraphOutput> {
      const result = await indexGraph(input.rootDir, input.configPath);
      return {
        success: true,
        indexedFiles: result.indexedFiles,
        indexedSymbols: result.indexedSymbols,
        indexedReferences: result.indexedReferences,
      };
    },
  },

  "graphflow.inspect": {
    name: "graphflow.inspect",
    description: "Inspect the current knowledge graph structure and statistics.",
    version: "1.0.0",
    async invoke(input: InspectGraphInput = {}): Promise<InspectGraphOutput> {
      const options: { nodeLimit?: number; edgeLimit?: number; rootDir?: string } = {};
      if (input.nodeLimit !== undefined) options.nodeLimit = input.nodeLimit;
      if (input.edgeLimit !== undefined) options.edgeLimit = input.edgeLimit;
      if (input.rootDir !== undefined) options.rootDir = input.rootDir;
      const result = await inspectGraph(input.configPath, options);
      return {
        success: true,
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        nodeTypeCount: result.nodeTypeCount as Record<string, number>,
        topRelations: result.topRelations as Array<{ relation: string; count: number }>,
        sampleNodes: result.sampleNodes.map((n) => ({
          id: n.id,
          type: n.type,
          label: n.displayLabel,
        })),
        detail: result,
      };
    },
  },

  "graphflow.expandAnchor": {
    name: "graphflow.expandAnchor",
    description: "Expand a graph anchor node to get full content and source location.",
    version: "1.0.0",
    async invoke(input: ExpandAnchorInput): Promise<ExpandAnchorOutput> {
      const result = await expandAnchor(input.anchorId, input.configPath, input.rootDir);
      if (!result) {
        return {
          success: false,
          anchorId: input.anchorId,
        };
      }
      const output: ExpandAnchorOutput = {
        success: true,
        anchorId: result.anchorId,
        type: result.type,
        content: result.content,
      };
      if (result.sourcePath !== undefined) output.sourcePath = result.sourcePath;
      if (result.sourceLine !== undefined) output.sourceLine = result.sourceLine;
      if (result.sourceSnippet !== undefined) output.sourceSnippet = result.sourceSnippet;
      return output;
    },
  },

  "graphflow.run": {
    name: "graphflow.run",
    description: "Run a full task: plan + compress context + return execution descriptor (bridge mode).",
    version: "1.0.0",
    async invoke(input: RunTaskInput): Promise<RunTaskOutput> {
      const result = await runTaskResult(input.task, input.configPath);
      const output: RunTaskOutput = {
        success: result.status === "COMPLETED" || result.status === "HUMAN_REVIEW_REQUIRED",
        status: result.status,
        attempts: result.attempts,
        feedback: result.feedback,
      };
      if (result.executionDescriptor) {
        output.executionDescriptor = {
          action: result.executionDescriptor.action,
          task: result.executionDescriptor.task,
          context: result.executionDescriptor.context,
          retryHints: result.executionDescriptor.retryHints,
        };
      }
      return output;
    },
  },
} as const;

export type GraphFlowSkillName = keyof typeof graphflowSkills;

export type SkillInputByName<K extends GraphFlowSkillName> =
  K extends "graphflow.compress" ? CompressContextInput :
  K extends "graphflow.plan" ? PlanTaskInput :
  K extends "graphflow.planInsight" ? PlanInsightInput :
  K extends "graphflow.index" ? IndexGraphInput :
  K extends "graphflow.inspect" ? InspectGraphInput :
  K extends "graphflow.expandAnchor" ? ExpandAnchorInput :
  K extends "graphflow.run" ? RunTaskInput :
  never;

export type SkillOutputByName<K extends GraphFlowSkillName> =
  K extends "graphflow.compress" ? CompressContextOutput :
  K extends "graphflow.plan" ? PlanTaskOutput :
  K extends "graphflow.planInsight" ? PlanInsightOutput :
  K extends "graphflow.index" ? IndexGraphOutput :
  K extends "graphflow.inspect" ? InspectGraphOutput :
  K extends "graphflow.expandAnchor" ? ExpandAnchorOutput :
  K extends "graphflow.run" ? RunTaskOutput :
  never;

export async function invokeSkill<K extends GraphFlowSkillName>(
  skillName: K,
  input: SkillInputByName<K>
): Promise<SkillOutputByName<K>> {
  const skill = graphflowSkills[skillName];
  if (!skill) {
    throw new Error(`Unknown skill: ${String(skillName)}`);
  }
  return skill.invoke(input as never) as Promise<SkillOutputByName<K>>;
}

export function listSkills(): Array<{ name: string; description: string; version: string }> {
  return Object.values(graphflowSkills).map((s) => ({
    name: s.name,
    description: s.description,
    version: s.version,
  }));
}
