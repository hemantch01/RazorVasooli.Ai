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

// TODO: complete implementation step 14
