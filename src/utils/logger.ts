import { Writable } from "node:stream";
import pino from "pino";

type LogSink = (level: string, message: string) => void;

let mcpSink: LogSink | undefined;

/**
 * Mirror pino log events into a custom sink (e.g. MCP logging notifications).
 * Sink receives (mcpLevel, message) with mcpLevel in debug|info|warning|error|critical.
 * Must be attached before logs are emitted; safe to call once per process.
 */
export function attachMcpLogSink(sink: LogSink): void {
  mcpSink = sink;
}

function toMcpLogLevel(level: number): string {
  if (level <= 20) {
    return "debug";
  }
  if (level === 40) {
    return "warning";
  }
  if (level === 50) {
    return "error";
  }
  if (level >= 60) {
    return "critical";
  }
  return "info";
}

/** Tee destination: forwards JSON log lines to stderr and mirrors them to the MCP sink. */
const teeDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    const line = String(chunk);
    if (mcpSink) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) {
        try {
          const record = JSON.parse(trimmed) as { level?: number; msg?: unknown };
          if (record.msg !== undefined) {
            mcpSink(toMcpLogLevel(record.level ?? 30), String(record.msg));
          }
        } catch {
          // Non-JSON line; skip mirroring.
        }
      }
    }
    process.stderr.write(line, callback);
  },
});
teeDestination.on("error", () => {
  // Never crash the process on a stderr write failure.
});

function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info");

  // MCP stdio transport must never write logs to stdout (JSON-RPC uses stdout).
  if (
    process.env.GRAPHFLOW_MCP_STDIO === "1" ||
    process.env.GRAPHFLOW_LOG_JSON === "1" ||
    process.env.NODE_ENV === "production"
  ) {
    return pino({ level }, teeDestination);
  }

  try {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          destination: 2,
        },
      },
    });
  } catch {
    return pino({ level });
  }
}

export const logger = createLogger();
