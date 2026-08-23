// AUTO-GENERATED (Pass 2) — policy routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { classifyErrorCode } from "../services/diagnosis.js";
import { computeAllowedActions } from "../services/policy.js";

import type { PolicyInput } from "../services/policy.js";

export function registerPolicyRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { diagnosisService, policyService } = ctx;

app.post("/api/policy/decide", async (req: Request, res: Response) => {
  const {
    caseId,
    errorCode,
    amount = 10000,
    retryCount = 0,
    paymentMethod,
    isSubscription = false,
    declineCode,
  } = req.body;

  if (!caseId || typeof caseId !== "string") {
    return res.status(400).json({ error: "caseId (string) is required" });
  }

  // First diagnose to get taxonomy + recoverability
  const diagnosis = await diagnosisService.diagnose({
    caseId,
    errorCode: errorCode || declineCode || "UNKNOWN",
    amount,
    retryCount,
    paymentMethod,
    hoursSinceFailure: 0,
    isSubscription,
    rawPayload: req.body,
  });

  const policyInput: PolicyInput = {
    caseId,
    category: diagnosis.taxonomy.category,
    taxonomy: diagnosis.taxonomy,
    recoverability: diagnosis.recoverability,
    amount,
    retryCount,
    paymentMethod,
    isSubscription,
    declineCode: declineCode || errorCode,
  };

  const decision = await policyService.decide(policyInput);

  return res.status(200).json({
    success: true,
    diagnosis: {
      category: diagnosis.taxonomy.category,
      recoverabilityScore: diagnosis.recoverability.score,
      timingHint: diagnosis.recoverability.timingHint,
    },
    decision,
  });
});

app.post("/api/policy/allowed-actions", (req: Request, res: Response) => {
  const {
    errorCode,
    amount = 10000,
    retryCount = 0,
    paymentMethod,
    isSubscription = false,
    declineCode,
  } = req.body;

  const taxonomy = classifyErrorCode(errorCode || declineCode || "UNKNOWN");
  const category = taxonomy?.category || "unknown";

  const allowedActions = computeAllowedActions({
    caseId: "preview",
    category,
    taxonomy: taxonomy || {
      category: "unknown",
      subcategory: "unknown",
      isTransient: true,
      urgency: "standard" as const,
      suggestedChannels: ["email"],
    },
    recoverability: {
      score: 0.5,
      confidence: "medium",
      timingHint: { suggestedDelayHours: 4, reason: "preview", isPaydayWindow: false, isWeekend: false, quietHoursBlocked: false },
      factors: [],
    },
    amount,
    retryCount,
    paymentMethod,
    isSubscription,
    declineCode: declineCode || errorCode,
  });

  return res.status(200).json({
    success: true,
    category,
    allowedActions,
  });
});

app.get("/api/policy/decisions", (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string || "50", 10);
  const decisions = policyService.getDecisions(Math.min(limit, 200));

  return res.status(200).json({
    count: decisions.length,
    decisions,
  });
});

app.get("/api/policy/stats", (_req: Request, res: Response) => {
  return res.status(200).json(policyService.getStats());
});

}
