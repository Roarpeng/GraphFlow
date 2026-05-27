export interface WorkerInput {
  task: string;
  outputHint?: string;
}

export function runWorker(input: WorkerInput): string {
  if (input.outputHint !== undefined) {
    return input.outputHint;
  }

  return `Simulated change for task: ${input.task}`;
}
