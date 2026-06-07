export class GraphFlowError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class IndexingError extends GraphFlowError {}
export class ModelCallError extends GraphFlowError {}
export class PlanningError extends GraphFlowError {}
export class ConfigurationError extends GraphFlowError {}
export class ExecutionError extends GraphFlowError {}
