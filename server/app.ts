import express, { type Request } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import { requireAuth } from "./core/auth.js";
import { requestLoggingMiddleware } from "./core/logger.js";
import { metrics, registry } from "./core/metrics.js";
import { dbEnabled } from "./core/db.js";
import { getQueueStats, enqueueRiskEvent } from "./core/queue.js";

// Routes
import { telegramRoutes } from "./routes/telegramRoutes.js";
import { emailRoutes } from "./routes/emailRoutes.js";
import { mandateRoutes } from "./routes/mandateRoutes.js";
import { authRoutes } from "./routes/authRoutes.js";
import { registerWebhookRoutes } from "./routes/webhookRoutes.js";
import { registerRecoveryRoutes } from "./routes/recoveryRoutes.js";
import { registerIngestionRoutes } from "./routes/ingestionRoutes.js";
import { registerDiagnosisRoutes } from "./routes/diagnosisRoutes.js";
import { registerPolicyRoutes } from "./routes/policyRoutes.js";
import { registerCasesRoutes } from "./routes/casesRoutes.js";
import { registerComplianceRoutes } from "./routes/complianceRoutes.js";
import { registerVoiceRoutes } from "./routes/voiceRoutes.js";
import { registerReplyRoutes } from "./routes/replyRoutes.js";
import { registerAuditrRoutes } from "./routes/auditRRoutes.js";
import { registerSystemRoutes } from "./routes/systemRoutes.js";
import { registerAnalyticsRoutes } from "./routes/analyticsRoutes.js";
import { registerLearningRoutes } from "./routes/learningRoutes.js";
import { registerSimulatorRoutes } from "./routes/simulatorRoutes.js";

import type { Container } from "./core/container.js";
import { startPoller, pollInvoices } from "./workers/invoicePoller.js";
import { pollerState } from "./workers/invoicePoller.js";

export function buildApp(container: Container, contextRefs: { telegramAgent: any, runRecoveryPipeline: any }) {
  const app = express();
  app.set("trust proxy", 1);

  // Security: Rate limiting
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600, // Raised to 600 to accommodate Dashboard polling
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const path = req.path;
      if (path.startsWith("/api/webhooks") || path.startsWith("/api/telegram") || path === "/api/health" || path === "/api/ready") return true;
      if (req.headers.cookie?.includes("rv_token=")) return true; // Skip limit for authenticated users
      return false;
    },
    message: { error: "Too many requests, please try again later." },
  });

  // Middleware
  app.use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"] }));
  app.use(apiLimiter);
  app.use(requestLoggingMiddleware);

  // GET /metrics — Prometheus scrape endpoint
  app.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await metrics.render());
    } catch (err) {
      res.status(500).end(`metrics error: ${(err as Error).message}`);
    }
  });

  // GET /api/ready — readiness probe
  // Note: bootReady is managed by the server.ts entrypoint
  app.get("/api/ready", (req, res) => {
    const isReady = req.app.locals.bootReady === true;
    res.status(isReady ? 200 : 503).json({
      ready: isReady,
      db: dbEnabled(),
      queue: getQueueStats(),
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Capture raw body for Webhook HMAC signature verification
  app.use(
    express.json({
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== "false";
  if (REQUIRE_AUTH) {
    app.use("/api", requireAuth);
  }

  // Pre-configured routers
  app.use("/api/auth", authRoutes());
  app.use("/api/telegram", telegramRoutes());
  app.use("/api/email", emailRoutes({ razorpayClient: container.razorpayClient, auditService: container.auditService }));
  app.use("/api/mandate", mandateRoutes({ razorpayClient: container.razorpayClient, auditService: container.auditService }));

  // Shared route context (Legacy compatibility layer for routers)
  const ctx: Record<string, any> = {
    ...container,
    pollerState
  };
  
  Object.defineProperty(ctx, "runRecoveryPipeline", { get: () => contextRefs.runRecoveryPipeline });
  Object.defineProperty(ctx, "telegramAgent", { get: () => contextRefs.telegramAgent });
  Object.defineProperty(ctx, "startPoller", { get: () => () => startPoller(container.razorpayClient, container.deduplicator, container.riskEventBus, container.trackedInvoices) });
  Object.defineProperty(ctx, "pollInvoices", { get: () => () => pollInvoices(container.razorpayClient, container.deduplicator, container.riskEventBus, container.trackedInvoices) });
  ctx.enqueueRiskEvent = enqueueRiskEvent;

  // Mount modular routers
  registerWebhookRoutes(app, ctx);
  registerRecoveryRoutes(app, ctx);
  registerIngestionRoutes(app, ctx);
  registerDiagnosisRoutes(app, ctx);
  registerPolicyRoutes(app, ctx);
  registerCasesRoutes(app, ctx);
  registerComplianceRoutes(app, ctx);
  registerVoiceRoutes(app, ctx);
  registerReplyRoutes(app, ctx);
  registerAuditrRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerAnalyticsRoutes(app, ctx);
  registerLearningRoutes(app, ctx);
  registerSimulatorRoutes(app, ctx);

  // Serve SPA in production
  if (process.env.NODE_ENV === "production") {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.path.startsWith("/api") && req.path !== "/metrics") {
        res.sendFile(path.join(distDir, "index.html"));
        return;
      }
      next();
    });
  }

  return app;
}
