// AUTO-GENERATED (Pass 2) — system routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { getOutbox } from "../services/channels.js";
import { getAgentMode, setAgentMode, type AgentMode } from "../core/settings.js";
import { getQueueStats } from "../core/queue.js";
import { dbUpsertCaseSnapshot } from "../core/db.js";

export function registerSystemRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { auditService, deduplicator, diagnosisService, orchestrator, policyService, razorpayClient, riskEventBus, pollerState } = ctx;

app.get("/api/health", (_req: Request, res: Response) => {
  const diagStats = diagnosisService.getStats();
  const policyStats = policyService.getStats();
  const orchStats = orchestrator.getStats();
  return res.status(200).json({
    status: "healthy",
    service: "RazorVasooli.Ai Backend API",
    razorpayConfigured: !!razorpayClient,
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    phase2: {
      ingestionService: true,
      deduplicator: { active: true, trackedEvents: deduplicator.size },
      riskEventBus: { active: true, ...riskEventBus.getStats() },
      invoicePoller: { running: pollerState.interval !== null, totalPolls: pollerState.count },
    },
    phase3: {
      diagnosisService: true,
      totalDiagnosed: diagStats.totalDiagnosed,
      avgRecoverabilityScore: diagStats.avgRecoverabilityScore,
      byCategory: diagStats.byCategory,
      bySource: diagStats.bySource,
    },
    phase4: {
      policyEngine: true,
      totalDecisions: policyStats.totalDecisions,
      vetoCount: policyStats.vetoCount,
      bySource: policyStats.bySource,
      byChannel: policyStats.byChannel,
    },
    phase5: {
      orchestrator: true,
      totalCases: orchStats.totalCases,
      totalRecovered: orchStats.totalRecovered,
      totalRecoveredAmount: orchStats.totalRecoveredAmount,
      totalEscalated: orchStats.totalEscalated,
      totalSkippedCompliance: orchStats.totalSkippedCompliance,
      quietHoursDeferrals: orchStats.quietHoursDeferrals,
      dpdpOptOuts: orchStats.dpdpOptOuts,
      byState: orchStats.byState,
    },
    voiceService: {
      active: true,
      geminiAudioModality: !!process.env.GEMINI_API_KEY,
      hinglishParser: true,
    },
    phase6: {
      channelAdapters: true,
      replyIntake: true,
      outboxMessages: getOutbox({ limit: 500 }).length,
      auditLedger: auditService.getStats(),
    },
  });
});

// Phase H1: Durable agent-mode kill-switch
// Previously this lived only in the browser's localStorage; a restart (or a
// second browser) silently flipped the recovery engine's mode. Now it is
// server state: persisted to Postgres and every change lands on the hash chain.

const VALID_MODES: AgentMode[] = ["agentic", "control"];

app.get("/api/system/mode", async (_req: Request, res: Response) => {
  const mode = await getAgentMode();
  return res.status(200).json({ mode, queue: getQueueStats() });
});

app.put("/api/system/mode", async (req: Request, res: Response) => {
  const { mode, changedBy } = req.body ?? {};
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `Invalid mode '${mode}'. Must be one of: ${VALID_MODES.join(", ")}` });
  }
  const previous = await getAgentMode();
  const effective = await setAgentMode(mode as AgentMode);

  // Tamper-evident trail of who flipped the kill-switch, when.
  auditService.append("system.mode_changed", {
    previous,
    mode: effective,
    changedBy: changedBy || req.authUser?.email || "unknown",
  });

  return res.status(200).json({ mode: effective, previous });
});

  app.post("/api/system/seed", async (_req: Request, res: Response) => {
    const dummyCases: any[] = [];
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    
    // Generate a smoother volume of historical dummy cases
    // Base 20-40 cases per day for 30 days
    for (let day = 0; day <= 30; day++) {
      const casesThisDay = 25 + Math.floor(Math.random() * 20); // 25 to 44 cases
      for (let i = 0; i < casesThisDay; i++) {
        const createdAt = new Date(now - day * DAY - Math.random() * DAY).toISOString();
        const states = ["DETECTED", "DIAGNOSED", "POLICY_SELECTED", "INTERVENING", "PAUSED_PROMISE", "RECOVERED", "RECOVERED", "RECOVERED", "ESCALATED", "CLOSED_LOST"];
        const state = states[Math.floor(Math.random() * states.length)]; // skewed towards recovered
        const declineCodes = ["INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS", "BAD_REQUEST_PAYMENT_TIMED_OUT", "CARD_EXPIRED", "BANK_DECLINED", "LIMIT_EXCEEDED"];
        const declineCode = declineCodes[Math.floor(Math.random() * declineCodes.length)];
        const amount = [999, 1499, 2499, 4999, 9999][Math.floor(Math.random() * 5)];
        const id = `case_seed_${Date.now()}_${day}_${i}`;
        
        dummyCases.push({
          id,
          state,
          category: "seed_category",
          customerEmail: `customer${day}_${i}@example.com`,
          customerName: `Customer ${day}-${i}`,
          amount,
          currency: "INR",
          declineCode,
          attemptCount: Math.floor(Math.random() * 3),
          maxAttempts: 3,
          currentDecision: { channel: ["email", "whatsapp", "sms", "whatsapp"][Math.floor(Math.random() * 4)] },
          scheduledJobs: [],
          dpdpOptedOut: false,
          quietHoursDeferred: false,
          transitions: [],
          createdAt,
          updatedAt: createdAt,
          ...(state === "RECOVERED" ? { recoveredAt: createdAt, recoveredAmount: amount } : {})
        });
      }
    }

    // Persist to DB in parallel chunks for speed
    const chunkSize = 50;
    for (let i = 0; i < dummyCases.length; i += chunkSize) {
      const chunk = dummyCases.slice(i, i + chunkSize);
      await Promise.all(chunk.map(c => dbUpsertCaseSnapshot({
        id: c.id,
        state: c.state,
        amount: c.amount,
        updatedAt: c.updatedAt,
        snapshot: c,
      })));
    }
  
  // Hydrate orchestrator in-memory map so it immediately serves them via API
  orchestrator.restoreCases(dummyCases);

  return res.status(200).json({ success: true, seededCount: dummyCases.length });
});

}
