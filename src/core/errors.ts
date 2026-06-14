export enum ErrorCode {
  // 通用与基础错误
  UNKNOWN = 'UNKNOWN',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  // 索引与上下文错误
  INDEXING_ERROR = 'INDEXING_ERROR',
  CONTEXT_ERROR = 'CONTEXT_ERROR',

  // 模型调用与路由错误
  MODEL_CALL_ERROR = 'MODEL_CALL_ERROR',
  ROUTING_ERROR = 'ROUTING_ERROR',

  // 规划与执行错误
  PLANNING_ERROR = 'PLANNING_ERROR',
  EXECUTION_ERROR = 'EXECUTION_ERROR',
}

export class GraphFlowError extends Error {
  public readonly code: ErrorCode;
  public readonly recovery: string | undefined;

  constructor(
    message: string,
    public readonly details?: unknown,
    code: ErrorCode = ErrorCode.UNKNOWN,
    recovery?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.recovery = recovery;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class IndexingError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.INDEXING_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}

export class ModelCallError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.MODEL_CALL_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}

export class PlanningError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.PLANNING_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}

export class ConfigurationError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.CONFIGURATION_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}

export class ExecutionError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.EXECUTION_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}

export class RoutingError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.ROUTING_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}

export class ValidationError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.VALIDATION_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}

export class ContextError extends GraphFlowError {
  constructor(
    message: string,
    details?: unknown,
    code: ErrorCode = ErrorCode.CONTEXT_ERROR,
    recovery?: string
  ) {
    super(message, details, code, recovery);
  }
}
