// AUTO-GENERATED (Pass 2) — reply routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { verifyActionToken } from "../services/channels.js";
import { registerDpdpOptOut } from "../services/orchestrator.js";
import { parseHinglishReply } from "../services/voice.js";

export function registerReplyRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { auditService, orchestrator } = ctx;

app.post("/api/replies/parse-hinglish", (req: Request, res: Response) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  const parsed = parseHinglishReply(message);

  return res.status(200).json({
    success: true,
    ...parsed,
  });
});

app.post("/api/replies/inbound", (req: Request, res: Response) => {
  const { message, customerEmail, caseId, channel = "whatsapp" } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  const parsed = parseHinglishReply(message);

  // Resolve target case: explicit caseId, else match by email on open cases
  let targetCaseId: string | undefined = caseId;
  if (!targetCaseId && customerEmail) {
    const match = orchestrator
      .getCases({ limit: 200 })
      .find(
        (c: any) =>
          c.customerEmail?.toLowerCase() === customerEmail.toLowerCase() &&
          !["RECOVERED", "CLOSED_LOST", "SKIPPED_COMPLIANCE"].includes(c.state)
      );
    if (match) targetCaseId = match.id;
  }

  let actionTaken = "no_action";
  let details: Record<string, unknown> = {};

  if (parsed.intent === "optout") {
    if (customerEmail) registerDpdpOptOut(customerEmail);
    if (targetCaseId) {
      orchestrator.transitionState(targetCaseId, "SKIPPED_COMPLIANCE",
        "Customer opted out via inbound reply (DPDP)"
      );
    }
    actionTaken = "dpdp_optout_registered";
    details = { email: customerEmail };
  } else if (parsed.intent === "promise" && targetCaseId) {
    const promisedDate =
      parsed.promisedDate ||
      new Date(Date.now() + 3 * 24 * 3600000).toISOString().split("T")[0];
    orchestrator.recordPromise(targetCaseId, promisedDate, parsed.promisedAmount);
    actionTaken = "promise_recorded";
    details = { promisedDate };
  } else if (parsed.intent === "paid" && targetCaseId) {
    const caseData = orchestrator.getCase(targetCaseId);
    if (caseData) {
      orchestrator.recordRecovery(targetCaseId, caseData.amount);
      actionTaken = "recovery_recorded";
    }
  } else if (parsed.intent === "discount_request") {
    actionTaken = "discount_request_logged";
  } else if (parsed.intent === "dispute" && targetCaseId) {
    orchestrator.transitionState(targetCaseId, "ESCALATED",
      "Customer disputed the charge via reply — human review needed"
    );
    actionTaken = "escalated_for_review";
  } else if (parsed.intent === "question") {
    actionTaken = "question_logged";
  }

  // Task 6.4: Audit trail — reply + action taken
  auditService.append("customer.reply", {
    caseId: targetCaseId || null,
    channel,
    intent: parsed.intent,
    confidence: parsed.confidence,
    actionTaken,
    messagePreview: message.slice(0, 120),
  });

  return res.status(200).json({
    success: true,
    parsed,
    resolvedCaseId: targetCaseId || null,
    actionTaken,
    details,
  });
});

app.get("/api/replies/action/:token", (req: Request, res: Response) => {
  const rawToken = req.params.token;
  const token = Array.isArray(rawToken) ? rawToken[0] : (rawToken || "");
  const payload = verifyActionToken(token);

  if (!payload) {
    return res.status(400).json({ error: "Invalid or expired action token" });
  }

  const { action, caseId } = payload;
  const caseData = orchestrator.getCase(caseId);

  if (action === "optout") {
    if (caseData?.customerEmail) registerDpdpOptOut(caseData.customerEmail);
    if (caseData) {
      orchestrator.transitionState(caseId, "SKIPPED_COMPLIANCE",
        "Customer opted out via 1-click token link (DPDP)"
      );
    }
    auditService.append("customer.reply", {
      caseId,
      channel: "token_link",
      intent: "optout",
      confidence: 1,
      actionTaken: "dpdp_optout_registered",
    });
    return res.status(200).json({ success: true, action, caseId, result: "opted_out" });
  }

  if (action === "pay" && caseData) {
    orchestrator.recordRecovery(caseId, caseData.amount);
    auditService.append("recovery.recorded", {
      caseId,
      amount: caseData.amount,
      trigger: "one_click_token_link",
    });
    return res.status(200).json({ success: true, action, caseId, result: "recovered" });
  }

  if (action === "promise" && caseData) {
    const promisedDate = new Date(Date.now() + 3 * 24 * 3600000).toISOString().split("T")[0];
    orchestrator.recordPromise(caseId, promisedDate);
    auditService.append("customer.reply", {
      caseId,
      channel: "token_link",
      intent: "promise",
      confidence: 1,
      actionTaken: "promise_recorded",
      promisedDate,
    });
    return res.status(200).json({ success: true, action, caseId, result: "promise_recorded", promisedDate });
  }

  return res.status(404).json({ error: "Case not found for token action" });
});

}
