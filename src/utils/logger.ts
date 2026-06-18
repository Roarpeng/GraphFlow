import pino from "pino";

function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info");

  // MCP stdio transport must never write logs to stdout (JSON-RPC uses stdout).
  if (process.env.GRAPHFLOW_MCP_STDIO === "1") {
    return pino({ level }, pino.destination(2));
  }

  if (process.env.GRAPHFLOW_LOG_JSON === "1" || process.env.NODE_ENV === "production") {
    return pino({ level }, pino.destination(2));
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
