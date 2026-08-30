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

app.post("/api/replies/inbound", async (req: Request, res: Response) => {
  const { message, customerEmail, customerPhone, caseId, channel = "whatsapp" } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  // Resolve target case: explicit caseId, else match by email or phone on open cases
  let targetCaseId: string | undefined = caseId;
  if (!targetCaseId && customerEmail) {
    const matches = orchestrator
      .getCases({ limit: 200 })
      .filter(
        (c: any) =>
          c.customerEmail?.toLowerCase() === customerEmail.toLowerCase() &&
          !["RECOVERED", "CLOSED_LOST", "SKIPPED_COMPLIANCE"].includes(c.state)
      );
    // Do not guess when one customer has more than one open recovery case.
    // A sender must then supply the signed case id from their outreach link.
    if (matches.length === 1) targetCaseId = matches[0].id;
  }
  if (!targetCaseId && customerPhone) {
    const normalizedTarget = customerPhone.replace(/\D/g, "");
    if (normalizedTarget) {
      const matches = orchestrator
        .getCases({ limit: 200 })
        .filter(
          (c: any) =>
            c.customerPhone &&
            c.customerPhone.replace(/\D/g, "") === normalizedTarget &&
            !["RECOVERED", "CLOSED_LOST", "SKIPPED_COMPLIANCE"].includes(c.state)
        );
      if (matches.length === 1) targetCaseId = matches[0].id;
    }
  }

  let actionTaken = "no_action";
  let details: Record<string, unknown> = {};
  let parsed = { intent: "unknown", confidence: 0 };
  let replyMessage = "";

  if (targetCaseId) {
    const caseData = orchestrator.getCase(targetCaseId);
    if (caseData) {
      // 1. Two-step confirmation handling
      if (caseData.pendingOptOutConfirm) {
        const conf = orchestrator.handleOptOutConfirmation(targetCaseId, message);
        auditService.append("customer.reply", {
          caseId: targetCaseId,
          channel,
          messagePreview: message.slice(0, 120),
          actionTaken: conf.confirmed ? "SKIPPED_COMPLIANCE" : "OPT_OUT_PENDING",
        });
        return res.status(200).json({
          success: true,
          resolvedCaseId: targetCaseId,
          actionTaken: conf.confirmed ? "SKIPPED_COMPLIANCE" : "OPT_OUT_PENDING",
          message: conf.message,
          confirmed: conf.confirmed,
        });
      }

      // 2. Deterministic reconcile: "already paid / de diya"
      const isPaidClaim = /\b(already paid|de diya|bhar diya|paid|ho gaya|paise de diye)\b/i.test(message);
      if (isPaidClaim) {
        auditService.append("customer.reply", {
          caseId: targetCaseId,
          channel,
          messagePreview: message.slice(0, 120),
          actionTaken: "claim_paid",
        });
        const isActuallyPaid = caseData.state === "RECOVERED";
        if (isActuallyPaid) {
          orchestrator.recordRecovery(targetCaseId);
          return res.status(200).json({
            success: true,
            resolvedCaseId: targetCaseId,
            actionTaken: "RECOVERED",
            message: "🎉 Aapka payment hamare records me verify ho chuka hai. Dhanyavaad!",
          });
        } else {
          return res.status(200).json({
            success: true,
            resolvedCaseId: targetCaseId,
            actionTaken: "INTERVENING",
            message: "Humne check kiya par payment reflect nahi hua hai. Agar aap pay kar chuke hain toh please reference number share karein.",
          });
        }
      }

      const allowedActions = {
        channels: ["telegram", "email"] as any,
        delayWindows: [0, 4, 24],
        maxAttempts: 3,
        currentAttempt: caseData.attemptCount,
        escalationThresholds: { softReminderAfterAttempts: 1, urgentReminderAfterAttempts: 2, humanEscalationAfterAttempts: 3 },
        maxDiscountPercent: 10,
        allowSubscriptionUpdate: false,
        reasoning: "reply inbound"
      };

      const decision = await ctx.policyService.conversationalTurn(
        targetCaseId,
        caseData.state,
        message,
        channel as any,
        allowedActions
      );

      actionTaken = decision.state || "INTERVENING";
      parsed.intent = decision.metadata?.intent || decision.state || "unknown";
      replyMessage = decision.message || decision.narration;

      if (decision.metadata?.reason === "opt_out") {
        caseData.pendingOptOutConfirm = true;
        actionTaken = "CONFIRMATION_REQUIRED";
        replyMessage = "Kya aap waqai SAARE recovery reminders band karna chahte hain? Confirm karne ke liye 'YES' reply karein, ya continue rakhne ke liye 'NO' likhein 🙏";
      } else if (decision.metadata?.reason === "hostile") {
        orchestrator.transitionState(targetCaseId, "CLOSED_LOST", "Hostile customer reply");
        orchestrator.cancelCaseJobs(targetCaseId);
      } else if (decision.state === "PAUSED_PROMISE" && decision.metadata?.date) {
        const recorded = orchestrator.recordPromise(targetCaseId, decision.metadata.date, caseData.amount);
        if (recorded) {
          details = { promisedDate: decision.metadata.date };
        } else {
          replyMessage = "Aapka promise accept nahi ho paya (date invalid ya maximum 3 promises limit reach ho gayi hai).";
        }
      } else if (decision.metadata?.intent === "generate_link") {
        details = { generateLink: true };
      }

      if (decision.state && decision.state !== "CLOSED_LOST" && !caseData.pendingOptOutConfirm) {
        orchestrator.transitionState(targetCaseId, decision.state, decision.narration);
      }
    }
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
    resolvedCaseId: targetCaseId || null,
    actionTaken,
    message: replyMessage,
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
    // A click is not payment confirmation. RECOVERED remains webhook/payment
    // gateway-only; this endpoint merely records that the customer opened it.
    auditService.append("payment_link.opened", {
      caseId,
      amount: caseData.amount,
      trigger: "one_click_token_link",
    });
    return res.status(200).json({ success: true, action, caseId, result: "payment_pending" });
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
