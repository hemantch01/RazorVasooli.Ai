// AUTO-GENERATED (Pass 2) — webhook routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { classifyRiskSeverity, type RiskEvent, type RiskEventType } from "../services/ingestion.js";
import crypto from "node:crypto";
import { metrics } from "../core/metrics.js";

interface WebhookRecord {
  id: string;
  event: string;
  payload: any;
  receivedAt: string;
  signatureVerified: boolean;
  aiAction?: string;
  paymentLink?: string;
}

import { dbSaveWebhookLog, dbLoadWebhookLogs } from "../core/db.js";

const webhookEventLog: WebhookRecord[] = [];

export function registerWebhookRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { auditService, deduplicator, razorpayClient, riskEventBus, trackedInvoices, webhook_secret, enqueueRiskEvent } = ctx;

app.post("/api/webhooks/razorpay", async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const signature = req.headers["x-razorpay-signature"] as string | undefined;
  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

  let isVerified = false;

  // Task 1.2: Cryptographic Signature Verification
  if (webhook_secret && signature) {
    try {
      const expectedSignature = crypto
        .createHmac("sha256", webhook_secret)
        .update(rawBody)
        .digest("hex");

      const bufA = Buffer.from(expectedSignature, "utf8");
      const bufB = Buffer.from(signature, "utf8");

      if (bufA.length === bufB.length) {
        isVerified = crypto.timingSafeEqual(bufA, bufB);
      } else {
        isVerified = false;
      }
    } catch (err) {
      console.error("[Webhook] Signature verification error:", err);
      isVerified = false;
    }
  } else if (!webhook_secret) {
    // In dev simulation mode without webhook secret set
    console.warn("[Webhook] Warning: RAZORPAY_WEBHOOK_SECRET not configured. Accepting event in simulation mode.");
    isVerified = true;
  }

  // If signature provided but invalid, reject per security rules
  if (signature && !isVerified) {
    console.error("[Webhook] Invalid HMAC SHA256 signature received!");
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const eventType = req.body.event || "payment.failed";
  const payloadData = req.body.payload || req.body;
  const eventId = req.body.id || `evt_${Date.now()}`;

  // Phase 2: Deduplication Check
  if (deduplicator.isDuplicate(eventId)) {
    console.log(`[Webhook] Duplicate event skipped: ${eventId}`);
    return res.status(200).json({
      status: "duplicate",
      message: "Event already processed (idempotent)",
      event: eventType,
      eventId,
    });
  }

  console.log(`[Webhook] Received event: ${eventType} (ID: ${eventId}) | Signature Verified: ${isVerified}`);

  // Task 1.1: Automatic AI Agent Trigger upon failure events
  let aiAction = "";
  let generatedPaymentLink = "";

  if (eventType === "payment.failed" || eventType === "subscription.halted" || eventType === "invoice.expired") {
    const paymentEntity = payloadData.payment?.entity || payloadData;
    const amount = paymentEntity.amount ? paymentEntity.amount / 100 : 24999;
    const customerEmail = paymentEntity.email || "customer@example.com";
    const customerContact = paymentEntity.contact || "+919876543210";
    const errorCode = paymentEntity.error_code || "INSUFFICIENT_FUNDS";

    // Task 1.3: Generate dynamic recovery link
    try {
      if (razorpayClient) {
        const linkResponse = await razorpayClient.paymentLink.create({
          amount: Math.round(amount * 100), // in paise
          currency: "INR",
          accept_partial: false,
          description: `RazorVasooli Recovery for Failed Invoice (${errorCode})`,
          customer: {
            name: "Subscriber",
            email: customerEmail,
            contact: customerContact,
          },
          notify: {
            sms: true,
            email: true,
          },
          reminder_enable: true,
          notes: {
            recovery_agent: "RazorVasooli.Ai",
            decline_reason: errorCode,
          },
        });
        generatedPaymentLink = linkResponse.short_url;
      } else {
        generatedPaymentLink = `https://rzp.io/i/vasooli-${Math.random().toString(36).substring(2, 8)}`;
      }

      aiAction = `Autonomous AI intercepted ${errorCode} → Applied 5% discount → Generated Razorpay UPI intent link: ${generatedPaymentLink}`;
    } catch (linkErr: any) {
      console.error("[Razorpay Link Error]:", linkErr?.message || linkErr);
      generatedPaymentLink = `https://rzp.io/i/vasooli-sim-${Date.now().toString(36)}`;
      aiAction = `Autonomous AI intercepted failure → Generated backup payment link: ${generatedPaymentLink}`;
    }

    // Update or add to tracked failed invoices
    const existingInv = trackedInvoices.find((i: any) => i.customerEmail === customerEmail);
    if (existingInv) {
      existingInv.status = "ai_contacted";
      existingInv.retryCount += 1;
      existingInv.paymentLink = generatedPaymentLink;
    } else {
      trackedInvoices.unshift({
        id: `inv_${Date.now().toString(36)}`,
        customerName: "Subscriber",
        customerEmail: customerEmail.replace(/^(.)(.*)(@.*)$/, "$1***$3"),
        customerPhone: customerContact,
        amount,
        currency: "INR",
        declineCode: errorCode as any,
        status: "ai_contacted",
        subscriptionId: `sub_${Date.now().toString(36)}`,
        failedAt: new Date().toISOString(),
        retryCount: 1,
        channel: "whatsapp",
        paymentLink: generatedPaymentLink,
      });
    }
  } else if (eventType === "payment.captured" || eventType === "invoice.paid") {
    aiAction = `Payment successfully captured! Updated subscription status to active.`;
  }

  const record: WebhookRecord = {
    id: eventId,
    event: eventType,
    payload: req.body,
    receivedAt: new Date().toISOString(),
    signatureVerified: isVerified,
    aiAction,
    paymentLink: generatedPaymentLink,
  };

  webhookEventLog.unshift(record);
  if (webhookEventLog.length > 50) webhookEventLog.pop();

  // Task 6.4: Audit trail — webhook ingestion recorded on hash chain
  const webhookAmountEntity = payloadData.payment?.entity || payloadData;
  auditService.append("webhook.received", {
    eventId,
    eventType,
    signatureVerified: isVerified,
    amount: webhookAmountEntity.amount ? webhookAmountEntity.amount / 100 : 0,
  });

  // Phase 2: Publish to Risk Event Bus
  const paymentEntity = payloadData.payment?.entity || payloadData;
  // Phase H2: payment_link.paid carries a payment_link entity (not payment)
  const linkEntity = payloadData.payment_link?.entity;
  const riskEvent: RiskEvent = {
    id: eventId,
    type: eventType as RiskEventType,
    severity: classifyRiskSeverity(
      eventType,
      paymentEntity.amount ? paymentEntity.amount / 100 : undefined,
      paymentEntity.retry_count
    ),
    source: "webhook",
    payload: payloadData,
    customerId: paymentEntity.customer_id,
    customerEmail: linkEntity?.customer_details?.email || paymentEntity.email,
    amount: (linkEntity?.amount ?? paymentEntity.amount) ? (linkEntity?.amount ?? paymentEntity.amount) / 100 : undefined,
    currency: paymentEntity.currency || "INR",
    declineCode: paymentEntity.error_code,
    subscriptionId: paymentEntity.subscription_id,
    invoiceId: paymentEntity.invoice_id,
    receivedAt: new Date().toISOString(),
    deduplicated: false,
    metadata: {
      signatureVerified: isVerified,
      aiAction,
      // Phase H2: route payment_link.paid to its session/case via link id + notes
      ...(eventType === "payment_link.paid" && linkEntity
        ? { linkId: linkEntity.id, notes: linkEntity.notes ?? {} }
        : {}),
    },
  };

  // Phase H3: Save raw webhook immediately to DB
  dbSaveWebhookLog({
    id: eventId,
    event: eventType,
    payload: payloadData,
    signatureVerified: isVerified,
    aiAction,
    paymentLink: generatedPaymentLink,
  }).catch((err) => console.error("Failed to save webhook log to DB:", err));


  // Phase H1: Publish via durable BullMQ queue when Redis is available,
  // direct bus publish otherwise (graceful fallback).
  metrics.riskEvent("webhook", String(eventType), riskEvent.severity);
  if (typeof enqueueRiskEvent === "function") {
    await enqueueRiskEvent(riskEvent, () => riskEventBus.publish(riskEvent));
  } else {
    await riskEventBus.publish(riskEvent);
  }

  return res.status(200).json({
    status: "success",
    message: "Webhook processed successfully",
    event: eventType,
    verified: isVerified,
    aiAction,
    paymentLink: generatedPaymentLink,
  });
});

app.get("/api/webhooks/events", async (_req: Request, res: Response) => {
  const logs = await dbLoadWebhookLogs(50);
  return res.status(200).json({
    count: logs.length,
    events: logs,
  });
});

}
