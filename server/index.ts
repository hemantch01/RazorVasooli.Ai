import express, { type Request } from "express";
import cors from "cors";
import dotenv from "dotenv";
import Razorpay from "razorpay";
import rateLimit from "express-rate-limit";
import {
  EventDeduplicator,
  RiskEventBus,
  classifyRiskSeverity,
  DEFAULT_POLLER_CONFIG,
  type RiskEvent,
  type InvoicePollerConfig,
} from "./services/ingestion.js";
import { DiagnosisService, type DiagnosisResult } from "./services/diagnosis.js";
import { PolicyService, type PolicyInput } from "./services/policy.js";
import { OrchestratorService } from "./services/orchestrator.js";
import { AuditService } from "./services/audit.js";
import {
  buildActionUrls,
  createRecoveryPaymentLink,
  createSubscriptionUpdateMethodLink,
  sendInterventionMessage,
  setGlobalTelegramAgent,
  type OutboxChannel,
} from "./services/channels.js";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "5000", 10);
const HOST = process.env.HOST || "127.0.0.1"; // MUST listen on localhost/127.0.0.1 for security

// Initialize Razorpay Client (Task 1.3)
const key_id = process.env.RAZORPAY_KEY_ID || "";
const key_secret = process.env.RAZORPAY_KEY_SECRET || "";
const webhook_secret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

let razorpayClient: Razorpay | null = null;
if (key_id && key_secret && !key_id.includes("YourKeyId")) {
  try {
    razorpayClient = new Razorpay({
      key_id,
      key_secret,
    });
    console.log("[Razorpay] Client initialized with Key ID:", key_id.slice(0, 8) + "...");
  } catch {
    console.warn("[Razorpay] Could not initialize client with provided keys, running in simulation mode");
  }
} else {
  console.log("[Razorpay] Running in simulation mode (Set RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET in .env for live API calls)");
}

// Security: Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Middleware
app.use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"] }));
app.use(apiLimiter);
app.use(requestLoggingMiddleware);

// Hardening Phase H1: probes & metrics
// GET /metrics — Prometheus scrape endpoint (root-level, unauthenticated).
app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", registry.contentType);
    res.end(await metrics.render());
  } catch (err) {
    res.status(500).end(`metrics error: ${(err as Error).message}`);
  }
});

// GET /api/ready — readiness probe: 503 until boot completes.
let bootReady = false;
app.get("/api/ready", (_req, res) => {
  res.status(bootReady ? 200 : 503).json({
    ready: bootReady,
    db: dbEnabled(),
    queue: getQueueStats(),
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Capture raw body for Webhook HMAC signature verification (Task 1.2)
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// AUTH + PERSISTENCE BOOTSTRAP
import { requireAuth, ensureDefaultAdmin } from "./core/auth.js";
import {
  dbEnabled, initDb, dbLoadAuditTail,
  dbUpsertCaseSnapshot, dbLoadCaseSnapshots,
  dbUpsertJob, dbLoadPendingJobs,
} from "./core/db.js";
import {
  startTelegramBot,
  type TelegramAgent,
} from "./services/telegram.js";
import { pollInbox, startImapPolling, ensureMailHydrated } from "./services/mailbox.js";

let telegramAgent: TelegramAgent | null = null;

const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== "false";
if (REQUIRE_AUTH) {
  app.use("/api", requireAuth);
}

// Modular routers (Phase P4 refactor — chhote files per domain)
import { telegramRoutes, setTelegramAgent } from "./routes/telegramRoutes.js";
// buildDemoSessions ab routes/telegramRoutes.ts ke through serve hota hai
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

// Hardening Phase H1: observability + durability + prod serving
import path from "path";
import { logger, requestLoggingMiddleware } from "./core/logger.js";
import { metrics, registry } from "./core/metrics.js";
import { initQueue, enqueueRiskEvent, getQueueStats } from "./core/queue.js";
import { hydrateSettings } from "./core/settings.js";
import { loadDpdpOptOuts } from "./services/orchestrator.js";
import { hydrateOutcomeMemory } from "./services/outcomeMemory.js";
import { registerLearningRoutes } from "./routes/learningRoutes.js";

app.use("/api/auth", authRoutes());
app.use("/api/telegram", telegramRoutes());

// Auth endpoints — routes/authRoutes.ts me move ho gaye

// Telegram/Email/Mandate routes — routes/ me move ho gaye (neeche mount hote hain)




// State & Core Services (Phases 1, 2, 3, Voice)

interface WebhookRecord {
  id: string;
  event: string;
  payload: any;
  receivedAt: string;
  signatureVerified: boolean;
  aiAction?: string;
  paymentLink?: string;
}



// Phase 2: Ingestion Services
const deduplicator = new EventDeduplicator(60); // 60-minute TTL
const riskEventBus = new RiskEventBus(200);

// Phase 3: Diagnosis Service
const diagnosisService = new DiagnosisService(200);

// Phase 4: Policy Engine
const policyService = new PolicyService(200);

// Phase 5: Orchestrator
const orchestrator = new OrchestratorService();
// Job durability: har schedule/fire/cancel Postgres me persist (restart-safe)
orchestrator.setJobPersistenceHook((job) => {
  void dbUpsertJob({
    id: job.id,
    caseId: job.caseId,
    type: job.type,
    executeAt: job.executeAt,
    status: job.status,
    payload: {
      channel: job.channel,
      escalationLevel: job.escalationLevel,
      discountPercent: job.discountPercent,
    },
  });
});

// Phase 6: Hash-Chained Audit Ledger (Task 6.4)
const auditService = new AuditService(2000);
app.use("/api/email", emailRoutes({ razorpayClient, auditService }));
app.use("/api/mandate", mandateRoutes({ razorpayClient, auditService }));




// Phase 6: Intervention execution via channel adapters (Tasks 6.1 & 6.2)
orchestrator.setInterventionHandler(async (caseData, job) => {
  const channel = job.channel || "email";
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;

  // Create payment link — or subscription update-method link for halted subs
  const linkResult =
    caseData.subscriptionId && channel === "subscription_update_link"
      ? await createSubscriptionUpdateMethodLink(razorpayClient, {
        subscriptionId: caseData.subscriptionId,
        customerEmail: caseData.customerEmail,
      })
      : await createRecoveryPaymentLink(razorpayClient, {
        amountInr: caseData.amount,
        customerName: caseData.customerName,
        customerEmail: caseData.customerEmail,
        customerContact: caseData.customerPhone,
        description: `RazorVasooli recovery for ${caseData.id}`,
        notes: { case_id: caseData.id },
      });

  const outboxChannel: OutboxChannel =
    channel === "email" ? "email" : channel === "sms" ? "sms" : "whatsapp";

  const msg = sendInterventionMessage({
    channel: outboxChannel,
    caseId: caseData.id,
    customerName: caseData.customerName || "Customer",
    customerEmail: caseData.customerEmail,
    customerPhone: caseData.customerPhone,
    amountInr: caseData.amount,
    declineCode: caseData.declineCode,
    discountPercent: job.discountPercent,
    paymentLink: linkResult.shortUrl,
    actionUrls: buildActionUrls(baseUrl, caseData.id),
  });

  auditService.append("intervention.executed", {
    caseId: caseData.id,
    jobId: job.id,
    channel,
    attempt: caseData.attemptCount,
    amount: caseData.amount,
    paymentLink: linkResult.shortUrl,
    simulated: linkResult.simulated,
    messageId: msg.id,
  });

  console.log(`[Channels] ✅ Intervention executed for ${caseData.id} via ${channel} → ${linkResult.shortUrl}`);
});

// Invoice Poller State
const pollerState: {
  config: InvoicePollerConfig; interval: ReturnType<typeof setInterval> | null;
  lastPoll: string | null; count: number;
} = { config: { ...DEFAULT_POLLER_CONFIG }, interval: null, lastPoll: null, count: 0 };

// Register RiskEventBus listeners
riskEventBus.on("*", (event: RiskEvent) => {
  const icon =
    event.severity === "critical" ? "🔴" :
      event.severity === "high" ? "🟠" :
        event.severity === "medium" ? "🟡" : "🟢";
  console.log(
    `[RiskBus] ${icon} ${event.type} | severity=${event.severity} | source=${event.source} | amt=₹${event.amount || 0} | customer=${event.customerEmail || "unknown"}`
  );
});

// Auto-diagnose failure events via RiskEventBus
// Full pipeline: Diagnosis → Policy → Orchestrator
async function runRecoveryPipeline(event: RiskEvent, diagnosis: DiagnosisResult): Promise<void> {
  // Create/update orchestrator case
  orchestrator.createCase({
    id: event.id,
    customerEmail: event.customerEmail,
    amount: event.amount || 0,
    currency: event.currency,
    declineCode: event.declineCode,
    paymentMethod: event.payload?.payment?.entity?.method,
    subscriptionId: event.subscriptionId,
    invoiceId: event.invoiceId,
    category: diagnosis.taxonomy.category, // Phase L1: learning-memory key
  });

  // Transition to DIAGNOSED
  orchestrator.transitionState(event.id, "DIAGNOSED",
    `Classified as ${diagnosis.taxonomy.category} (score=${diagnosis.recoverability.score})`
  );

  // Task 6.4: Audit trail — diagnosis recorded on hash chain
  auditService.append("case.diagnosed", {
    caseId: event.id,
    category: diagnosis.taxonomy.category,
    recoverabilityScore: diagnosis.recoverability.score,
    diagnosisSource: diagnosis.diagnosisSource,
    amount: event.amount || 0,
  });

  // Run policy engine
  const policyInput: PolicyInput = {
    caseId: event.id,
    category: diagnosis.taxonomy.category,
    taxonomy: diagnosis.taxonomy,
    recoverability: diagnosis.recoverability,
    amount: event.amount || 0,
    retryCount: event.payload?.payment?.entity?.retry_count || 0,
    paymentMethod: event.payload?.payment?.entity?.method,
    isSubscription: !!event.subscriptionId,
    declineCode: event.declineCode,
  };

  const decision = await policyService.decide(policyInput);

  console.log(
    `[Pipeline] 🔄 ${event.id}: ${diagnosis.taxonomy.category} → ${decision.channel}/${decision.delayHours}h (${decision.decisionSource}) | ${decision.narration}`
  );

  // Task 6.4: Audit trail — policy decision recorded on hash chain
  auditService.append("policy.decision", {
    caseId: event.id,
    channel: decision.channel,
    delayHours: decision.delayHours,
    decisionSource: decision.decisionSource,
    escalationLevel: decision.escalationLevel,
    discountIncentive: decision.discountIncentive || null,
    narration: decision.narration,
  });

  // Apply decision to orchestrator (schedules job, checks compliance)
  orchestrator.applyDecision(event.id, decision);
}

riskEventBus.on("payment.failed", async (event: RiskEvent) => {
  if (event.declineCode) {
    const failedAt = new Date(event.receivedAt).getTime();
    const hoursSinceFailure = (Date.now() - failedAt) / 3600000;

    const diagnosis = await diagnosisService.diagnose({
      caseId: event.id,
      errorCode: event.declineCode,
      amount: event.amount || 0,
      retryCount: event.payload?.payment?.entity?.retry_count || 0,
      paymentMethod: event.payload?.payment?.entity?.method,
      hoursSinceFailure,
      isSubscription: !!event.subscriptionId,
      rawPayload: event.payload,
    });

    console.log(
      `[Diagnosis] 🔬 ${event.id} → category=${diagnosis.taxonomy.category} | score=${diagnosis.recoverability.score} | source=${diagnosis.diagnosisSource} | timing=${diagnosis.recoverability.timingHint.reason}`
    );

    // Feed into recovery pipeline (Phase 4+5)
    await runRecoveryPipeline(event, diagnosis);
  }
});

riskEventBus.on("subscription.halted", async (event: RiskEvent) => {
  const diagnosis = await diagnosisService.diagnose({
    caseId: event.id,
    errorCode: event.declineCode || "SUBSCRIPTION_HALTED",
    amount: event.amount || 0,
    retryCount: 0,
    hoursSinceFailure: 0,
    isSubscription: true,
    rawPayload: event.payload,
  });

  console.log(
    `[Diagnosis] 🔬 Subscription halted ${event.id} → score=${diagnosis.recoverability.score} | ${diagnosis.recoverability.timingHint.reason}`
  );

  await runRecoveryPipeline(event, diagnosis);
});

riskEventBus.on("checkout.abandoned", async (event: RiskEvent) => {
  // Phase C1: conversational cart recovery on Telegram (if a session exists)
  const cartItems = event.payload?.cartItems;
  if (Array.isArray(cartItems) && cartItems.length > 0 && telegramAgent) {
    const total = event.amount || cartItems.reduce((sum: number, i: any) => sum + (i.price * i.qty), 0);
    void telegramAgent.pushAbandonedCart({
      items: cartItems,
      totalInr: total,
      customerEmail: event.customerEmail,
    });
  }
  const diagnosis = await diagnosisService.diagnose({
    caseId: event.id,
    errorCode: "CHECKOUT_ABANDONED",
    amount: event.amount || 0,
    retryCount: 0,
    hoursSinceFailure: 0,
    rawPayload: event.payload,
  });

  console.log(
    `[Diagnosis] 🔬 Checkout abandoned ${event.id} → score=${diagnosis.recoverability.score}`
  );

  await runRecoveryPipeline(event, diagnosis);
});

riskEventBus.on("invoice.poll.overdue", async (event: RiskEvent) => {
  const diagnosis = await diagnosisService.diagnose({
    caseId: event.id,
    errorCode: "INVOICE_OVERDUE",
    amount: event.amount || 0,
    retryCount: event.payload?.invoice?.retryCount || 0,
    hoursSinceFailure: event.payload?.overdueHours || 24,
    rawPayload: event.payload,
  });

  console.log(
    `[Diagnosis] 🔬 Overdue invoice ${event.id} → score=${diagnosis.recoverability.score}`
  );

  await runRecoveryPipeline(event, diagnosis);
});

// Auto-reconcile successful payments
riskEventBus.on("payment.captured", async (event: RiskEvent) => {
  // Check if there is an open recovery case for this payment
  const relatedCases = orchestrator.getCases({ limit: 100 });
  for (const c of relatedCases) {
    if (
      c.customerEmail === event.customerEmail &&
      c.state !== "RECOVERED" &&
      c.state !== "CLOSED_LOST" &&
      c.state !== "SKIPPED_COMPLIANCE"
    ) {
      orchestrator.recordRecovery(c.id, event.amount);
      auditService.append("recovery.recorded", {
        caseId: c.id,
        amount: event.amount,
        trigger: "payment.captured",
        paymentEventId: event.id,
      });
      console.log(`[Reconciliation] ✅ Payment captured → case ${c.id} recovered (₹${event.amount})`);
    }
  }
});

riskEventBus.on("invoice.paid", async (event: RiskEvent) => {
  const relatedCases = orchestrator.getCases({ limit: 100 });
  for (const c of relatedCases) {
    if (
      c.invoiceId === event.invoiceId &&
      c.state !== "RECOVERED" &&
      c.state !== "CLOSED_LOST" &&
      c.state !== "SKIPPED_COMPLIANCE"
    ) {
      orchestrator.recordRecovery(c.id, event.amount);
      auditService.append("recovery.recorded", {
        caseId: c.id,
        amount: event.amount,
        trigger: "invoice.paid",
        invoiceId: event.invoiceId,
      });
      console.log(`[Reconciliation] ✅ Invoice paid → case ${c.id} recovered (₹${event.amount})`);
    }
  }
});

// Phase H2: payment_link.paid — PRIMARY payment-completion path.
// Razorpay delivers this webhook when a recovery payment link is paid:
//   • Telegram session matched by linkId → markPaid() instantly
//   • Orchestrator case reconciled via the link's notes.case_id
riskEventBus.on("payment_link.paid", async (event: RiskEvent) => {
  const linkId = event.metadata?.linkId as string | undefined;
  const notes = (event.metadata?.notes ?? {}) as Record<string, unknown>;
  const amountInr = event.amount || 0;

  auditService.append("payment.link_paid", {
    linkId,
    amount: amountInr,
    caseIdFromNotes: typeof notes.case_id === "string" ? notes.case_id : undefined,
  });

  // 1. Telegram session completion (instant, replaces the old 5s polling)
  if (telegramAgent && linkId) {
    await telegramAgent.handlePaymentLinkPaid(linkId);
  }

  // 2. Orchestrator case reconciliation — direct case_id match from link notes
  const caseIdFromNotes = typeof notes.case_id === "string" ? notes.case_id : undefined;
  const targetCase = caseIdFromNotes
    ? orchestrator.getCase(caseIdFromNotes)
    : undefined;
  if (
    targetCase &&
    targetCase.state !== "RECOVERED" &&
    targetCase.state !== "CLOSED_LOST" &&
    targetCase.state !== "SKIPPED_COMPLIANCE"
  ) {
    orchestrator.recordRecovery(targetCase.id, amountInr || undefined);
    auditService.append("recovery.recorded", {
      caseId: targetCase.id,
      amount: amountInr,
      trigger: "payment.link_paid",
      paymentLink: linkId,
    });
    console.log(`[Reconciliation] ✅ Payment link paid → case ${targetCase.id} recovered (₹${amountInr})`);
  }
});

const trackedInvoices = [
  {
    id: "inv_Rz4k8mPqN2x7Lb",
    customerName: "A***a Sharma",
    customerEmail: "a***a@techcorp.in",
    customerPhone: "+91 98765 43210",
    amount: 24999,
    currency: "INR",
    declineCode: "INSUFFICIENT_FUNDS",
    status: "ai_contacted",
    subscriptionId: "sub_Rz4k8mPqN2x7",
    failedAt: new Date(Date.now() - 3600000).toISOString(),
    retryCount: 2,
    channel: "whatsapp",
    paymentLink: "https://rzp.io/i/vasooli-Rz4k8m",
  },
  {
    id: "inv_Qw9j7nRsM1y6Ka",
    customerName: "R***j Patel",
    customerEmail: "r***j@startup.io",
    customerPhone: "+91 98111 22233",
    amount: 49999,
    currency: "INR",
    declineCode: "BAD_REQUEST_PAYMENT_TIMED_OUT",
    status: "link_sent",
    subscriptionId: "sub_Qw9j7nRsM1y6",
    failedAt: new Date(Date.now() - 86400000).toISOString(),
    retryCount: 1,
    channel: "email",
    paymentLink: "https://rzp.io/i/vasooli-Qw9j7n",
  },
  {
    id: "inv_Uw3g5pTuJ4a9Ic",
    customerName: "S***n Reddy",
    customerEmail: "s***n@saasly.in",
    customerPhone: "+91 99000 88776",
    amount: 14999,
    currency: "INR",
    declineCode: "BANK_DECLINED",
    status: "pending",
    subscriptionId: "sub_Uw3g5pTuJ4a9",
    failedAt: new Date().toISOString(),
    retryCount: 0,
    channel: "whatsapp",
  },
];

// Shared route context (Pass 2 refactor) — sab services ab declared hain
const ctx: Record<string, any> = {
  razorpayClient, key_id, webhook_secret, deduplicator, riskEventBus,
  diagnosisService, policyService, orchestrator, auditService,
  trackedInvoices, pollerState, HOST, PORT,
};
Object.defineProperty(ctx, "runRecoveryPipeline", { get: () => runRecoveryPipeline });
Object.defineProperty(ctx, "telegramAgent", { get: () => telegramAgent });
Object.defineProperty(ctx, "startPoller", { get: () => startPoller });
Object.defineProperty(ctx, "pollInvoices", { get: () => pollInvoices });
// Phase H1: durable risk-event enqueue (BullMQ when Redis up, direct fallback)
ctx.enqueueRiskEvent = enqueueRiskEvent;

// Modular routers (Pass 2) — full paths ke saath root pe mount
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



// Trigger AI Recovery for a specific invoice

// Get Webhook Stream Events

// Get Tracked Failed Invoices


// PHASE 2: Invoice Poller — poll Razorpay for missed/overdue invoices
async function pollInvoices(): Promise<{ polled: number; risksFound: number }> {
  pollerState.count++;
  pollerState.lastPoll = new Date().toISOString();
  let risksFound = 0;

  console.log(`[InvoicePoller] Poll #${pollerState.count} at ${pollerState.lastPoll}`);

  try {
    if (razorpayClient) {
      // Live mode: query Razorpay Invoice API
      try {
        const invoices = await (razorpayClient as any).invoices.all({
          count: pollerState.config.maxInvoicesToPoll,
        });

        for (const inv of invoices.items || []) {
          if (inv.status === "expired" || inv.status === "cancelled") {
            const pollEventId = `poll_${inv.id}_${inv.status}`;
            if (!deduplicator.isDuplicate(pollEventId)) {
              const riskEvent: RiskEvent = {
                id: pollEventId,
                type: "invoice.poll.missed",
                severity: classifyRiskSeverity("invoice.poll.missed", inv.amount ? inv.amount / 100 : undefined),
                source: "poller",
                payload: inv,
                customerEmail: inv.customer_details?.email,
                amount: inv.amount ? inv.amount / 100 : undefined,
                currency: inv.currency || "INR",
                invoiceId: inv.id,
                receivedAt: new Date().toISOString(),
                deduplicated: false,
              };
              await riskEventBus.publish(riskEvent);
              risksFound++;
            }
          }
        }
      } catch (apiErr: any) {
        console.warn("[InvoicePoller] Razorpay API error (test keys may not support invoice listing):", apiErr?.message);
      }
    }

    // Simulation mode: check tracked in-memory invoices for overdue items
    const now = Date.now();
    const overdueThreshold = pollerState.config.overdueThresholdHours * 3600000;

    for (const inv of trackedInvoices) {
      if (inv.status === "pending" || inv.status === "failed") {
        const failedAge = now - new Date(inv.failedAt).getTime();
        if (failedAge > overdueThreshold) {
          const pollEventId = `poll_${inv.id}_overdue`;
          if (!deduplicator.isDuplicate(pollEventId)) {
            const riskEvent: RiskEvent = {
              id: pollEventId,
              type: "invoice.poll.overdue",
              severity: classifyRiskSeverity("invoice.poll.overdue", inv.amount),
              source: "poller",
              payload: { invoice: inv, overdueHours: Math.round(failedAge / 3600000) },
              customerEmail: inv.customerEmail,
              amount: inv.amount,
              currency: inv.currency || "INR",
              invoiceId: inv.id,
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            };
            await riskEventBus.publish(riskEvent);
            risksFound++;
          }
        }
      }
    }
  } catch (err) {
    console.error("[InvoicePoller] Error during poll:", err);
  }

  console.log(`[InvoicePoller] Poll #${pollerState.count} complete — ${risksFound} new risks found`);
  return { polled: pollerState.count, risksFound };
}

function startPoller(): void {
  if (pollerState.interval) return;
  if (!pollerState.config.enabled) {
    console.log("[InvoicePoller] Poller is disabled");
    return;
  }

  console.log(`[InvoicePoller] Starting — interval=${pollerState.config.intervalMs}ms, overdueThreshold=${pollerState.config.overdueThresholdHours}h`);
  pollInvoices(); // Run immediately on start
  pollerState.interval = setInterval(() => pollInvoices(), pollerState.config.intervalMs);
}


// Poller control endpoints







// PHASE 3: Diagnosis Service API Endpoints

// On-demand diagnosis for a specific error code

// Classify an error code without full scoring

// Get recent diagnosis results

// Get diagnosis service stats

// PHASE 4: Policy Engine API Endpoints

// On-demand policy decision for a diagnosed case

// Get allowed actions for a given category/attempt

// Get recent policy decisions

// Get policy engine stats

// PHASE 5: Orchestrator API Endpoints

// Get all recovery cases

// Get a specific recovery case

// Manually transition a case state

// Record a payment recovery for a case

// Record a customer payment promise

// Sweep a promise (check if paid)

// Get scheduled jobs

// Get orchestrator stats

// DPDP Opt-Out Management

// Register a DPDP opt-out

// Check opt-out status

// Remove opt-out (re-consent)

// List all opt-outs

// Run compliance check for a case

// Get/update compliance config
// Mandate sequencer route — routes/mandateRoutes.ts me move ho gaya (neeche mounted)



// VOICE & HINGLISH RECOVERY ENDPOINTS (Task 6.3 & Gemini Voice Modality)

// Generate Hinglish voice script & Gemini direct audio bytes

// Get fast text script without generating audio

// Parse inbound customer reply in Hinglish/English (Task 6.3)

// PHASE 6: Customer Reply Intake & Intent Actions (Task 6.3)

// Inbound customer reply webhook (Hinglish & English)

// Deterministic 1-click action via signed token URL (zero-AI guarantee)

// PHASE 6: Audit Ledger API (Task 6.4)

// Verify the entire hash chain integrity

// Browse ledger entries (newest first)

// Ledger stats (head hash, counts by event type)

// PHASE 6: Communication Outbox (Task 6.2 — Mailpit-style delivery log)


// PHASE 7: Escalation Queue — 1-click human resolution actions

// Start Server strictly bound to 127.0.0.1
// Phase H1: serve the built React SPA in production (single artifact)
if (process.env.NODE_ENV === "production") {
  const distDir = path.resolve(process.cwd(), "dist");
  app.use(express.static(distDir));
  // SPA fallback: any non-API GET serves index.html (Express 5-safe middleware form)
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && req.path !== "/metrics") {
      res.sendFile(path.join(distDir, "index.html"));
      return;
    }
    next();
  });
}

app.listen(PORT, HOST, async () => {
  console.log(`\n⚡ RazorVasooli.Ai Backend Server running at http://${HOST}:${PORT}`);

  // Persistence bootstrap (Postgres via DATABASE_URL — see docker-compose.yml)
  if (process.env.DATABASE_URL) {
    try {
      await initDb();
      // Case directory sync: persist every case create/transition, restore on boot
      orchestrator.setCasePersistenceHook((c) => {
        void dbUpsertCaseSnapshot({
          id: c.id,
          state: c.state,
          amount: c.amount,
          updatedAt: c.updatedAt,
          snapshot: c as unknown as Record<string, unknown>,
        });
      });
      const snapshots = await dbLoadCaseSnapshots();
      if (snapshots.length > 0) {
        orchestrator.restoreCases(
          snapshots.map((r) => r.customer as never)
        );
      }
      // Scheduled retry jobs restart-survival
      const pendingJobs = await dbLoadPendingJobs();
      if (pendingJobs.length > 0) {
        orchestrator.restoreScheduledJobs(
          pendingJobs.map((j) => ({ ...j, payload: j.payload as Record<string, unknown> }))
        );
      }
      // Mail conversations + A/B batches restore (restart-survival)
      await ensureMailHydrated();

      const tail = await dbLoadAuditTail();
      if (tail.length > 0) {
        auditService.loadExternalEntries(tail);
        console.log(`[DB] 🔗 Restored ${tail.length} audit chain entries from PostgreSQL`);
      } else {
        console.log("[DB] 🔗 Audit ledger will persist to PostgreSQL from now on");
      }
    } catch (err: any) {
      console.error("[DB] ⚠️ Postgres unavailable — continuing in-memory:", err?.message);
    }
  }

  // Hardening Phase H1 bootstraps
  // DPDP opt-out registry hydration (restart-survival for legal opt-outs)
  try {
    const nOptOuts = await loadDpdpOptOuts();
    if (nOptOuts > 0) console.log(`[DPDP] ♻️ Restored ${nOptOuts} opt-out(s) from PostgreSQL`);
  } catch (err) {
    console.warn("[DPDP] opt-out hydration skipped:", (err as Error).message);
  }

  // Kill-switch mode + durable BullMQ risk-event queue
  await hydrateSettings();
  await initQueue((event) => riskEventBus.publish(event));

  // Phase L1: learning memory hydration (restart-survival for outcome stats)
  try {
    const n = await hydrateOutcomeMemory();
    if (n === 0) console.log("[Learning] 💤 Memory cold — POST /api/learning/seed to bootstrap with synthetic personas");
  } catch (err) {
    console.warn("[Learning] hydration skipped:", (err as Error).message);
  }

  // Auth bootstrap
  try {
    await ensureDefaultAdmin();
  } catch (err: any) {
    console.warn("[Auth] default admin seeding skipped:", err?.message);
  }

  // Telegram live channel (you = customer, Gemini = agent)
  telegramAgent = await startTelegramBot({
    razorpayClient,
    auditService,
    geminiApiKey: process.env.GEMINI_API_KEY,
    token: process.env.TELEGRAM_BOT_TOKEN,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  });
  setTelegramAgent(telegramAgent);
  setGlobalTelegramAgent(telegramAgent);
  if (dbEnabled() && telegramAgent) {
    const n = await telegramAgent.hydrateFromDB();
    if (n) console.log(`[Telegram] ♻️ Restored ${n} session(s) from PostgreSQL`);
  }

  // Inbound email channel (IMAP poll → AI read → SMTP reply)
  const emailDeps = {
    razorpayClient,
    auditService,
    geminiApiKey: process.env.GEMINI_API_KEY,
  };
  startImapPolling(emailDeps);
  void pollInbox(emailDeps);

  console.log(`📡 Webhook Receiver: http://${HOST}:${PORT}/api/webhooks/razorpay`);

  console.log(`🔗 Payment Links:   http://${HOST}:${PORT}/api/recovery/create-payment-link`);
  console.log(`📥 Beacon Ingress:  http://${HOST}:${PORT}/api/ingestion/beacon`);
  console.log(`📊 Risk Events:     http://${HOST}:${PORT}/api/ingestion/risk-events`);
  console.log(`🔄 Invoice Poller:  http://${HOST}:${PORT}/api/ingestion/poller/status`);
  console.log(`🔬 Diagnosis:       http://${HOST}:${PORT}/api/diagnosis/stats`);
  console.log(`📋 Policy Engine:   http://${HOST}:${PORT}/api/policy/stats`);
  console.log(`🎯 Orchestrator:    http://${HOST}:${PORT}/api/orchestrator/stats`);
  console.log(`🛡️ Compliance:      http://${HOST}:${PORT}/api/compliance/config`);
  console.log(`🎙️ Voice Engine:    http://${HOST}:${PORT}/api/voice/generate`);
  console.log(`🇮🇳 Hinglish Parser: http://${HOST}:${PORT}/api/replies/parse-hinglish\n`);

  // Auto-start the invoice poller
  startPoller();

  bootReady = true;
  logger.info({ db: dbEnabled(), queue: getQueueStats() }, "server boot complete — readiness probe now 200");
});
