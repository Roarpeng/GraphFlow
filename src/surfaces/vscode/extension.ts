import { orchestrate } from "../../core/orchestrator";
import type { TaskRunResult } from "../../core/types";

export interface VsCodeSurfaceState {
  commands: string[];
}

export function registerVsCodeSurface(): VsCodeSurfaceState {
  return {
    commands: ["graphflow.runTask", "graphflow.showRuns"],
  };
}

export interface VsCodeRunRecord extends TaskRunResult {
  task: string;
  timestamp: number;
}

export interface VsCodeRuntime {
  commands: string[];
  runTask(task: string): Promise<VsCodeRunRecord>;
  showRuns(): VsCodeRunRecord[];
}

export type RunExecutor = (task: string) => Promise<TaskRunResult>;

export function createVsCodeRuntime(executor?: RunExecutor): VsCodeRuntime {
  const state = registerVsCodeSurface();
  const runs: VsCodeRunRecord[] = [];

  const runExecutor: RunExecutor =
    executor ??
    (async (task: string) => {
      return orchestrate({ task });
    });

  return {
    commands: state.commands,
    async runTask(task: string): Promise<VsCodeRunRecord> {
      const result = await runExecutor(task);
      const record: VsCodeRunRecord = {
        ...result,
        task,
        timestamp: Date.now(),
      };
      runs.push(record);
      return record;
    },
    showRuns(): VsCodeRunRecord[] {
      return [...runs];
    },
  };
}
