import pino from "pino";
import { env } from "@/env";

/**
 * JSON logs in production; pretty-printed in development when pino-pretty is installed.
 * Secrets and PII are redacted by path — never log raw request bodies from webhooks.
 */
const redact = {
  paths: [
    "password",
    "*.password",
    "token",
    "*.token",
    "secret",
    "*.secret",
    "apiKey",
    "*.apiKey",
    "authorization",
    "*.authorization",
    "headers.authorization",
    "headers.cookie",
    "cookie",
    "*.email",
    "email",
    "accessToken",
    "*.accessToken",
    "refreshToken",
    "*.refreshToken",
  ],
  censor: "[redacted]",
};

function createLogger() {
  const pretty = env.NODE_ENV === "development" && process.env.LOG_PRETTY !== "false";
  if (pretty) {
    try {
      return pino({
        level: env.LOG_LEVEL,
        redact,
        transport: { target: "pino-pretty", options: { colorize: true } },
      });
    } catch {
      // pino-pretty is a dev dependency; fall through to JSON output.
    }
  }
  return pino({
    level: env.NODE_ENV === "test" ? (process.env.LOG_LEVEL ?? "silent") : env.LOG_LEVEL,
    redact,
    base: { service: "outcome-ads" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

const globalForLogger = globalThis as unknown as { __oaLogger?: pino.Logger };
export const logger: pino.Logger = globalForLogger.__oaLogger ?? createLogger();
globalForLogger.__oaLogger = logger;
