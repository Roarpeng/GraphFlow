export interface VsCodeSurfaceState {
  commands: string[];
}

export function registerVsCodeSurface(): VsCodeSurfaceState {
  return {
    commands: ["graphflow.runTask", "graphflow.showRuns"],
  };
}
