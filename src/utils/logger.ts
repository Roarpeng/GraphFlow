import pino from "pino";

function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || "info";

  if (process.env.GRAPHFLOW_LOG_JSON === "1" || process.env.NODE_ENV === "production") {
    return pino({ level });
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
