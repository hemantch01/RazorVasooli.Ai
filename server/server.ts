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
import { startPoller } from "./workers/invoicePoller.js";
import { buildActionUrls, createSubscriptionUpdateMethodLink, getOrCreateRecoveryPaymentLink, sendInterventionMessage } from "./services/channels.js";
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
      await ensureDefaultAdmin();
    } catch (err: any) {
      console.warn("[Auth] default admin seeding skipped:", err?.message);
    }

    // 5. Wire Up Orchestrator Actions (Channels & Transcripts)
    container.orchestrator.setConversationProvider((caseId: string) => {
      const entries = container.auditService.getEntries({ limit: 2000 })
        .filter((e) => e.payload && (e.payload.caseId === caseId || (e.payload as any).case_id === caseId))
        .sort((a, b) => a.seq - b.seq);

      if (entries.length === 0) return "";

      const lines: string[] = [];
      for (const entry of entries) {
        if (entry.eventType === "customer.reply") {
          const ch = entry.payload.channel || "inbound";
          const text = entry.payload.message || entry.payload.messagePreview || "";
          lines.push(`[CUSTOMER via ${ch}] ${text}`);
        } else if (entry.eventType === "intervention.executed") {
          const ch = entry.payload.channel || "outbound";
          const msg = entry.payload.customMessage || entry.payload.message || (entry.payload.paymentLink ? `Payment link: ${entry.payload.paymentLink}` : "");
          lines.push(`[AGENT via ${ch}] ${msg}`);
        } else if (entry.eventType === "policy.decision") {
          lines.push(`[DECISION] ${entry.payload.narration || ""}`);
        } else if (entry.eventType === "promise.recorded") {
          lines.push(`[PROMISE] Customer promised payment on ${entry.payload.promisedDate}`);
        }
      }

      return lines.join("\n");
    });

    container.orchestrator.setPromiseReminderProvider(async (caseData) => {
      const date = caseData.promise?.promisedDate || "today";
      const fallback = `Namaste ji, aapne ${date} tak payment ka promise kiya tha. Aaj woh date aa gayi hai—kya aap abhi payment complete kar sakte hain? {{PAYMENT_LINK}}`;
      try {
        const message = await container.policyService.composePromiseReminder({
          caseId: caseData.id,
          customerName: caseData.customerName,
          amount: caseData.amount,
          promisedDate: date,
          transcript: container.auditService.getEntries({ limit: 2000 })
            .filter((e) => e.payload?.caseId === caseData.id)
            .map((e) => String(e.payload?.message || e.payload?.messagePreview || ""))
            .filter(Boolean)
            .slice(-6),
        });
        return message || fallback;
      } catch (err) {
        console.warn(`[Orchestrator] Promise-reminder generation failed for ${caseData.id}:`, (err as Error).message);
        return fallback;
      }
    });

    container.orchestrator.setInterventionHandler(async (caseData, job) => {
      const baseUrl = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;

      const linkOutcome = caseData.subscriptionId && job.channel === "subscription_update_link"
        ? { link: await createSubscriptionUpdateMethodLink(container.razorpayClient, {
            subscriptionId: caseData.subscriptionId,
            customerEmail: caseData.customerEmail,
          }), reused: false }
        : await getOrCreateRecoveryPaymentLink(container.razorpayClient, caseData.paymentLink, {
            amountInr: caseData.amount,
            customerName: caseData.customerName,
            customerEmail: caseData.customerEmail,
            customerContact: caseData.customerPhone,
            description: `RazorVasooli recovery for ${caseData.id}`,
            notes: { case_id: caseData.id },
          });
      const linkResult = linkOutcome.link;
      if (!caseData.subscriptionId || job.channel !== "subscription_update_link") {
        container.orchestrator.recordPaymentLink(caseData.id, linkResult);
      }

      const deliveredChannels: string[] = [];

      // 1. Deliver to Email (if customerEmail exists)
      if (caseData.customerEmail) {
        sendInterventionMessage({
          channel: "email",
          caseId: caseData.id,
          customerName: caseData.customerName || "Customer",
          customerEmail: caseData.customerEmail,
          customerPhone: caseData.customerPhone,
          amountInr: caseData.amount,
          declineCode: caseData.declineCode,
          discountPercent: job.discountPercent,
          customMessage: job.customMessage,
          paymentLink: linkResult.shortUrl,
          paymentLinkId: linkResult.linkId,
          simulated: linkResult.simulated,
          actionUrls: buildActionUrls(baseUrl, caseData.id),
        });
        deliveredChannels.push("email");
      }

      // 2. Deliver to Telegram (simultaneous push if customerPhone exists and agent is active)
      if (contextRefs.telegramAgent && caseData.customerPhone) {
        const telegramDelivered = await contextRefs.telegramAgent.pushWebhookIntervention({
          caseId: caseData.id,
          amountInr: caseData.amount,
          declineCode: caseData.declineCode,
          paymentLink: linkResult.shortUrl,
          paymentLinkId: linkResult.linkId,
          simulated: linkResult.simulated,
          customerContact: caseData.customerPhone,
          customMessage: job.customMessage,
        });
        if (telegramDelivered) deliveredChannels.push("telegram");
      }

      container.auditService.append("intervention.executed", {
        caseId: caseData.id,
        jobId: job.id,
        channel: deliveredChannels.join(",") || "none",
        attempt: caseData.attemptCount,
        amount: caseData.amount,
        paymentLink: linkResult.shortUrl,
        paymentLinkReused: linkOutcome.reused,
        customMessage: job.customMessage,
        simulated: linkResult.simulated,
      });

      console.log(`[Channels] Intervention dispatched for ${caseData.id} via ${deliveredChannels.join(" + ") || "no channel"} → ${linkResult.shortUrl}`);
    });

    // 6. Register Event Handlers
    const { runRecoveryPipeline } = registerEventHandlers({
      riskEventBus: container.riskEventBus,
      diagnosisService: container.diagnosisService,
      policyService: container.policyService,
      orchestrator: container.orchestrator,
      auditService: container.auditService,
      getTelegramAgent: () => contextRefs.telegramAgent
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
      orchestrator: container.orchestrator,
      policyService: container.policyService,
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
      orchestrator: container.orchestrator,
      policyService: container.policyService,
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
