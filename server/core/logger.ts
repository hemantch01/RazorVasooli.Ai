/**
 * RazorVasooli.Ai — Structured Logger (pino)
 *
 * JSON logs in production, pretty-colored dev output otherwise.
 * Usage:
 *   import { logger } from "../core/logger.js";
 *   logger.info({ caseId, amount }, "case recovered");
 *
 * A child logger per module keeps `module` on every line:
 *   const log = logger.child({ module: "orchestrator" });
 */

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  base: { service: "razorvasooli-api" },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,service" },
        },
      }
    : {}),
});

/** Express middleware: assigns a request id + child logger per request. */
export function requestLoggingMiddleware(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  const requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  (req as import("express").Request & { log?: pino.Logger }).log = logger.child({
    module: "http",
    requestId,
    method: req.method,
    path: req.path,
  });
  const start = Date.now();
  res.on("finish", () => {
    (req as import("express").Request & { log?: pino.Logger }).log?.info({
      status: res.statusCode,
      durationMs: Date.now() - start,
    }, "request completed");
  });
  next();
}

import crypto from "crypto";
