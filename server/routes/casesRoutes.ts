// AUTO-GENERATED (Pass 2) — cases routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { createRecoveryPaymentLink } from "../services/channels.js";
import type { CaseState } from "../services/orchestrator.js";

export function registerCasesRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { auditService, orchestrator, razorpayClient } = ctx;

app.get("/api/orchestrator/cases", (req: Request, res: Response) => {
  const state = req.query.state as string | undefined;
  const limit = parseInt(req.query.limit as string || "50", 10);

  const cases = orchestrator.getCases({
    state: state as CaseState | undefined,
    limit: Math.min(limit, 200),
  });

  return res.status(200).json({
    count: cases.length,
    cases,
  });
});

app.get("/api/orchestrator/cases/:caseId", (req: Request, res: Response) => {
  const rawId = req.params.caseId;
  const caseId = Array.isArray(rawId) ? rawId[0] : (rawId || "");
  const caseData = orchestrator.getCase(caseId);

  if (!caseData) {
    return res.status(404).json({ error: "Case not found" });
  }

  return res.status(200).json({
    success: true,
    case: caseData,
  });
});

app.post("/api/orchestrator/cases/:caseId/transition", (req: Request, res: Response) => {
  const rawId = req.params.caseId;
  const caseId = Array.isArray(rawId) ? rawId[0] : (rawId || "");
  const { newState, reason = "Manual transition" } = req.body;

  if (!newState) {
    return res.status(400).json({ error: "newState is required" });
  }

  const result = orchestrator.transitionState(caseId, newState, reason);

  if (!result) {
    return res.status(400).json({ error: "Invalid transition or case not found" });
  }

  return res.status(200).json({
    success: true,
    case: result,
  });
});

app.post("/api/orchestrator/cases/:caseId/recover", (req: Request, res: Response) => {
  const rawId = req.params.caseId;
  const caseId = Array.isArray(rawId) ? rawId[0] : (rawId || "");
  const { recoveredAmount, paymentId } = req.body;

  const result = orchestrator.recordRecovery(caseId, recoveredAmount, paymentId);

  if (!result) {
    return res.status(404).json({ error: "Case not found" });
  }

  return res.status(200).json({
    success: true,
    case: result,
  });
});

app.post("/api/orchestrator/cases/:caseId/promise", (req: Request, res: Response) => {
  const rawId = req.params.caseId;
  const caseId = Array.isArray(rawId) ? rawId[0] : (rawId || "");
  const { promisedDate, promisedAmount } = req.body;

  if (!promisedDate) {
    return res.status(400).json({ error: "promisedDate (ISO date) is required" });
  }

  const result = orchestrator.recordPromise(caseId, promisedDate, promisedAmount);

  if (!result) {
    return res.status(404).json({ error: "Case not found" });
  }

  return res.status(200).json({
    success: true,
    case: result,
  });
});

app.post("/api/orchestrator/cases/:caseId/sweep-promise", (req: Request, res: Response) => {
  const rawId = req.params.caseId;
  const caseId = Array.isArray(rawId) ? rawId[0] : (rawId || "");
  const { wasPaid = false } = req.body;

  const result = orchestrator.sweepPromise(caseId, wasPaid);

  if (!result) {
    return res.status(404).json({ error: "Case not found or no promise recorded" });
  }

  return res.status(200).json({
    success: true,
    case: result,
  });
});

app.get("/api/orchestrator/jobs", (req: Request, res: Response) => {
  const caseId = req.query.caseId as string | undefined;
  const status = req.query.status as string | undefined;
  const limit = parseInt(req.query.limit as string || "50", 10);

  const jobs = orchestrator.getJobs({
    caseId,
    status: status as any,
    limit: Math.min(limit, 200),
  });

  return res.status(200).json({
    count: jobs.length,
    jobs,
  });
});

app.get("/api/orchestrator/stats", (_req: Request, res: Response) => {
  return res.status(200).json(orchestrator.getStats());
});

app.post("/api/orchestrator/cases/:caseId/escalation-action", async (req: Request, res: Response) => {
  const rawId = req.params.caseId;
  const caseId = Array.isArray(rawId) ? rawId[0] : (rawId || "");
  const { action } = req.body;

  const caseData = orchestrator.getCase(caseId);
  if (!caseData) {
    return res.status(404).json({ error: "Case not found" });
  }

  switch (action) {
    case "mark_resolved": {
      const result = orchestrator.recordRecovery(caseId, caseData.amount, "manual_resolution");
      auditService.append("escalation.resolved", { caseId, amount: caseData.amount, method: "manual" });
      return res.status(200).json({ success: true, action, case: result });
    }
    case "offer_discount": {
      const discountedAmount = Math.round(caseData.amount * 0.95); // 5% discount
      const link = await createRecoveryPaymentLink(razorpayClient, {
        amountInr: discountedAmount,
        customerName: caseData.customerName,
        customerEmail: caseData.customerEmail,
        customerContact: caseData.customerPhone,
        description: `Settlement offer with 5% discount for ${caseId}`,
        notes: { case_id: caseId, discount: "5%" },
      });
      auditService.append("escalation.discount_offered", {
        caseId,
        discountedAmount,
        paymentLink: link.shortUrl,
      });
      return res.status(200).json({
        success: true,
        action,
        caseId,
        discountedAmount,
        paymentLink: link.shortUrl,
        simulated: link.simulated,
      });
    }
    case "write_off": {
      const result = orchestrator.transitionState(caseId, "CLOSED_LOST", "Manually written off by merchant");
      auditService.append("escalation.written_off", { caseId, amountLost: caseData.amount });
      return res.status(200).json({ success: !!result, action, case: result });
    }
    default:
      return res.status(400).json({ error: "action must be one of: mark_resolved, offer_discount, write_off" });
  }
});

}
