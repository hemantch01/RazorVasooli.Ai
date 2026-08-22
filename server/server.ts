import dotenv from "dotenv";
dotenv.config();

import { createContainer } from "./core/container.js";
import { buildApp } from "./app.js";
import { logger } from "./core/logger.js";

// Core bootstraps
import { ensureDefaultAdmin } from "./core/auth.js";
import {
  dbEnabled, initDb, dbLoadAuditTail,
  dbUpsertCaseSnapshot, dbLoadCaseSnapshots,
  dbUpsertJob, dbLoadPendingJobs,
} from "./core/db.js";
import { startTelegramBot, type TelegramAgent } from "./services/telegram.js";
import { setGlobalTelegramAgent } from "./services/channels.js";
import { setTelegramAgent } from "./routes/telegramRoutes.js";
import { pollInbox, startImapPolling, ensureMailHydrated } from "./services/mailbox.js";
import { initQueue, getQueueStats } from "./core/queue.js";
import { hydrateSettings } from "./core/settings.js";
import { loadDpdpOptOuts } from "./services/orchestrator.js";
import { hydrateOutcomeMemory } from "./services/outcomeMemory.js";
import { startPoller } from "./workers/invoicePoller.js";
import { buildActionUrls, createRecoveryPaymentLink, createSubscriptionUpdateMethodLink, sendInterventionMessage, type OutboxChannel } from "./services/channels.js";
import { registerEventHandlers } from "./services/eventHandlers.js";

async function bootstrap() {
  const container = createContainer();
  const PORT = container.PORT;
  const HOST = container.HOST;

  const contextRefs: { telegramAgent: TelegramAgent | null, runRecoveryPipeline: any } = { 
    telegramAgent: null, 
    runRecoveryPipeline: null 
  };

  // 1. Build the Express App with Dependency Injection
  const app = buildApp(container, contextRefs);
  app.locals.bootReady = false;

  // 2. Start HTTP Server
  const server = app.listen(PORT, HOST, async () => {
    console.log(`\n⚡ RazorVasooli.Ai Backend Server running at http://${HOST}:${PORT}`);

    // 3. Database & Persistence Bootstrap
    if (process.env.DATABASE_URL) {
      try {
        await initDb();
        
        // Wire up Orchestrator hooks
        container.orchestrator.setCasePersistenceHook((c) => {
          void dbUpsertCaseSnapshot({
            id: c.id,
            state: c.state,
            amount: c.amount,
            updatedAt: c.updatedAt,
            snapshot: c as unknown as Record<string, unknown>,
          });
        });
        container.orchestrator.setJobPersistenceHook((job) => {
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

        // Restore State
        const snapshots = await dbLoadCaseSnapshots();
        if (snapshots.length > 0) {
          container.orchestrator.restoreCases(snapshots.map((r) => r.customer as never));
        }
        
        const pendingJobs = await dbLoadPendingJobs();
        if (pendingJobs.length > 0) {
          container.orchestrator.restoreScheduledJobs(
            pendingJobs.map((j) => ({ ...j, payload: j.payload as Record<string, unknown> }))
          );
        }

        await ensureMailHydrated();

        const tail = await dbLoadAuditTail();
        if (tail.length > 0) {
          container.auditService.loadExternalEntries(tail);
          console.log(`[DB] 🔗 Restored ${tail.length} audit chain entries from PostgreSQL`);
        } else {
          console.log("[DB] 🔗 Audit ledger will persist to PostgreSQL from now on");
        }
      } catch (err: any) {
        console.error("[DB] ⚠️ Postgres unavailable — continuing in-memory:", err?.message);
      }
    }

    // 4. Hardening & Background Service Bootstraps
    try {
      const nOptOuts = await loadDpdpOptOuts();
      if (nOptOuts > 0) console.log(`[DPDP] ♻️ Restored ${nOptOuts} opt-out(s) from PostgreSQL`);
    } catch (err) {
      console.warn("[DPDP] opt-out hydration skipped:", (err as Error).message);
    }

    await hydrateSettings();
    await initQueue((event) => container.riskEventBus.publish(event));

    try {
      const n = await hydrateOutcomeMemory();
      if (n === 0) console.log("[Learning] 💤 Memory cold — POST /api/learning/seed to bootstrap with synthetic personas");
    } catch (err) {
      console.warn("[Learning] hydration skipped:", (err as Error).message);
    }

    try {
      await ensureDefaultAdmin();
    } catch (err: any) {
      console.warn("[Auth] default admin seeding skipped:", err?.message);
    }

    // 5. Wire Up Orchestrator Actions (Channels)
    container.orchestrator.setInterventionHandler(async (caseData, job) => {
      const channel = job.channel || "email";
      const baseUrl = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;

      const linkResult = caseData.subscriptionId && channel === "subscription_update_link"
        ? await createSubscriptionUpdateMethodLink(container.razorpayClient, {
            subscriptionId: caseData.subscriptionId,
            customerEmail: caseData.customerEmail,
          })
        : await createRecoveryPaymentLink(container.razorpayClient, {
            amountInr: caseData.amount,
            customerName: caseData.customerName,
            customerEmail: caseData.customerEmail,
            customerContact: caseData.customerPhone,
            description: `RazorVasooli recovery for ${caseData.id}`,
            notes: { case_id: caseData.id },
          });

      const outboxChannel: OutboxChannel = channel === "email" ? "email" : channel === "sms" ? "sms" : "whatsapp";

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

      container.auditService.append("intervention.executed", {
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

    // 6. Register Event Handlers
    const { runRecoveryPipeline } = registerEventHandlers({
      riskEventBus: container.riskEventBus,
      diagnosisService: container.diagnosisService,
      policyService: container.policyService,
      orchestrator: container.orchestrator,
      auditService: container.auditService,
      telegramAgent: contextRefs.telegramAgent // Will be updated if started below
    });
    contextRefs.runRecoveryPipeline = runRecoveryPipeline;

    // 7. Initialize External Channels (Telegram / Mail)
    contextRefs.telegramAgent = await startTelegramBot({
      razorpayClient: container.razorpayClient,
      auditService: container.auditService,
      geminiApiKey: process.env.GEMINI_API_KEY,
      token: process.env.TELEGRAM_BOT_TOKEN,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    });
    setTelegramAgent(contextRefs.telegramAgent);
    setGlobalTelegramAgent(contextRefs.telegramAgent);

    if (dbEnabled() && contextRefs.telegramAgent) {
      const n = await contextRefs.telegramAgent.hydrateFromDB();
      if (n) console.log(`[Telegram] ♻️ Restored ${n} session(s) from PostgreSQL`);
    }

    const emailDeps = {
      razorpayClient: container.razorpayClient,
      auditService: container.auditService,
      geminiApiKey: process.env.GEMINI_API_KEY,
    };
    startImapPolling(emailDeps);
    void pollInbox(emailDeps);

    console.log(`📡 Webhook Receiver: http://${HOST}:${PORT}/api/webhooks/razorpay`);
    console.log(`🔗 Payment Links:   http://${HOST}:${PORT}/api/recovery/create-payment-link`);
    console.log(`📥 Beacon Ingress:  http://${HOST}:${PORT}/api/ingestion/beacon`);
    console.log(`📊 Risk Events:     http://${HOST}:${PORT}/api/ingestion/risk-events`);
    console.log(`🔄 Invoice Poller:  http://${HOST}:${PORT}/api/ingestion/poller/status`);

    startPoller(container.razorpayClient, container.deduplicator, container.riskEventBus, container.trackedInvoices);

    app.locals.bootReady = true;
    logger.info({ db: dbEnabled(), queue: getQueueStats() }, "server boot complete — readiness probe now 200");
  });

  // Graceful Shutdown
  const shutdown = () => {
    logger.info("SIGTERM/SIGINT received. Shutting down gracefully...");
    server.close(() => {
      logger.info("HTTP server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  console.error("Failed to bootstrap application:", err);
  process.exit(1);
});
