export type ErrorCode =
  | "MCP_INSTALL_FAILED"
  | "MCP_CONFIG_READ_FAILED"
  | "MCP_CONFIG_WRITE_FAILED"
  | "SKILL_INSTALL_FAILED"
  | "SKILL_READ_FAILED"
  | "SKILL_VALIDATION_FAILED"
  | "GRAPH_INDEX_FAILED"
  | "GRAPH_READ_FAILED"
  | "GRAPH_WRITE_FAILED"
  | "CONTEXT_QUERY_FAILED"
  | "CONTEXT_EXPAND_FAILED"
  | "PLAN_FAILED"
  | "RUN_FAILED"
  | "PROVIDER_CONFIG_ERROR"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "CONFIG_PARSE_ERROR"
  | "PATH_RESOLVE_ERROR"
  | "PERMISSION_DENIED"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export interface GraphFlowErrorOptions {
  code: ErrorCode;
  message: string;
  cause?: Error | undefined;
  details?: Record<string, unknown> | undefined;
}

export class GraphFlowError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(options: GraphFlowErrorOptions) {
    super(options.message);
    this.name = "GraphFlowError";
    this.code = options.code;
    this.details = options.details;
    if (options.cause) {
      this.cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      stack: this.stack,
    };
  }

  override toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}

export interface ErrorResult<T = unknown> {
  ok: boolean;
  error?: GraphFlowError;
  data?: T;
}

export function ok<T>(data: T): ErrorResult<T> {
  return { ok: true, data };
}

export function err<T = unknown>(error: GraphFlowError): ErrorResult<T> {
  return { ok: false, error };
}

export function errCode<T = unknown>(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  cause?: Error
): ErrorResult<T> {
  return {
    ok: false,
    error: new GraphFlowError({ code, message, details, cause }),
  };
}

export function isGraphFlowError(error: unknown): error is GraphFlowError {
  return error instanceof GraphFlowError;
}

export function wrapError<T = unknown>(
  code: ErrorCode,
  message: string,
  error: unknown
): ErrorResult<T> {
  if (isGraphFlowError(error)) {
    return err(error);
  }
  return errCode(code, `${message}: ${String(error)}`, undefined, error as Error);
}

export function catchToResult<T>(fn: () => T): ErrorResult<T> {
  try {
    return ok(fn());
  } catch (error) {
    return wrapError("INTERNAL_ERROR", "Unexpected error", error);
  }
}

export async function catchToResultAsync<T>(fn: () => Promise<T>): Promise<ErrorResult<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return wrapError("INTERNAL_ERROR", "Unexpected error", error);
  }
}

export const errorMessages: Record<ErrorCode, string> = {
  MCP_INSTALL_FAILED: "MCP server installation failed",
  MCP_CONFIG_READ_FAILED: "Failed to read MCP configuration",
  MCP_CONFIG_WRITE_FAILED: "Failed to write MCP configuration",
  SKILL_INSTALL_FAILED: "Skill installation failed",
  SKILL_READ_FAILED: "Failed to read skill file",
  SKILL_VALIDATION_FAILED: "Skill file validation failed",
  GRAPH_INDEX_FAILED: "Graph indexing failed",
  GRAPH_READ_FAILED: "Failed to read from graph",
  GRAPH_WRITE_FAILED: "Failed to write to graph",
  CONTEXT_QUERY_FAILED: "Context query failed",
  CONTEXT_EXPAND_FAILED: "Context expand failed",
  PLAN_FAILED: "Task planning failed",
  RUN_FAILED: "Task execution failed",
  PROVIDER_CONFIG_ERROR: "Provider configuration error",
  PROVIDER_TIMEOUT: "Provider request timed out",
  PROVIDER_UNAVAILABLE: "Provider is unavailable",
  CONFIG_PARSE_ERROR: "Configuration parsing error",
  PATH_RESOLVE_ERROR: "Path resolution error",
  PERMISSION_DENIED: "Permission denied",
  CANCELLED: "Operation cancelled",
  INTERNAL_ERROR: "Internal error",
};
