/**
 * RazorVasooli.Ai — Channel Adapters (Tasks 6.1 & 6.2)
 *
 * Executes interventions via real Razorpay APIs when keys are configured,
 * falling back to realistic mock responses in simulation mode.
 *
 *  - Razorpay Payment Links (POST /v1/payment_links) with auto-expiry
 *  - Subscription Update-Payment-Method links for halted subscriptions
 *  - Invoice reminders
 *  - Email adapter (Mailpit-style outbox)
 *  - SMS / WhatsApp mock with tokenized payment/promise/opt-out links
 *  - Signed token URLs for deterministic 1-click customer actions
 */

import crypto from "crypto";
import type Razorpay from "razorpay";

// Real SMTP email delivery (optional — enabled when SMTP_HOST is configured)
// Works out-of-the-box with Mailpit from docker-compose.yml:
//   SMTP_HOST=localhost, SMTP_PORT=1025 (web UI on :8025)
// Production: set SMTP_HOST/PORT/USER/PASS to SES/SendGrid/Resend SMTP creds.

import nodemailer from "nodemailer";

let smtpTransporter: nodemailer.Transporter | null = null;
if (process.env.SMTP_HOST) {
  smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "1025", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
      : undefined,
  });
  console.log(`[Email] ✉️ SMTP delivery enabled → ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || "1025"}`);
}

async function deliverViaSmtp(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!smtpTransporter) return false;
  try {
    const info = await smtpTransporter.sendMail({
      from: process.env.SMTP_FROM || "RazorVasooli.Ai <recovery@razorvasooli.demo>",
      to,
      subject,
      text,
      html,
    });
    console.log(`[Email] 📬 Delivered via SMTP → ${to} (${info.messageId})`);
    return true;
  } catch (err: any) {
    console.warn("[Email] SMTP delivery failed:", err?.message);
    return false;
  }
}

// Outbox (Email + SMS/WhatsApp delivery log)

export type OutboxChannel = "email" | "sms" | "whatsapp";

export interface OutboxEntry {
  id: string;
  channel: OutboxChannel;
  to: string;
  subject?: string;
  body: string;
  paymentLink?: string;
  actionUrls?: { pay?: string; promise?: string; optout?: string };
  caseId?: string;
  sentAt: string;
}

const outbox: OutboxEntry[] = [];

export function recordOutbox(entry: Omit<OutboxEntry, "id" | "sentAt">): OutboxEntry {
  const full: OutboxEntry = {
    ...entry,
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
    sentAt: new Date().toISOString(),
  };
  outbox.unshift(full);
  if (outbox.length > 500) outbox.pop();
  console.log(`[Outbox] 📤 ${full.channel} → ${full.to} | ${full.subject || full.body.slice(0, 60)}`);
  return full;
}

export function getOutbox(filters?: { channel?: OutboxChannel; limit?: number }): OutboxEntry[] {
  let results = [...outbox];
  if (filters?.channel) results = results.filter((m) => m.channel === filters.channel);
  return results.slice(0, filters?.limit || 100);
}

// Signed Token URLs — deterministic 1-click actions (zero-AI guarantee)

export type OneClickAction = "pay" | "promise" | "optout";

export interface TokenPayload {
  action: OneClickAction;
  caseId: string;
  /** Expiry (epoch ms) */
  exp: number;
}

function getTokenSecret(): string {
  return process.env.TOKEN_SIGNING_SECRET || "razorvasooli-dev-secret";
}

let globalTelegramAgent: any = null;
export function setGlobalTelegramAgent(agent: any) {
  globalTelegramAgent = agent;
}

/** Create an HMAC-signed token for a 1-click customer action */
export function signActionToken(action: OneClickAction, caseId: string, ttlMinutes = 15): string {
  const payload: TokenPayload = {
    action,
    caseId,
    exp: Date.now() + ttlMinutes * 60000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", getTokenSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verify a signed token; returns the payload or null if invalid/expired */
export function verifyActionToken(token: string): TokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = crypto.createHmac("sha256", getTokenSecret()).update(body).digest("base64url");
  const bufA = Buffer.from(expected);
  const bufB = Buffer.from(sig);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface ActionLinks {
  pay: string;
  promise: string;
  optout: string;
}

/** Build all three 1-click action URLs for a case */
export function buildActionUrls(baseUrl: string, caseId: string): ActionLinks {
  return {
    pay: `${baseUrl}/api/replies/action/${signActionToken("pay", caseId)}`,
    promise: `${baseUrl}/api/replies/action/${signActionToken("promise", caseId)}`,
    optout: `${baseUrl}/api/replies/action/${signActionToken("optout", caseId)}`,
  };
}

// Task 6.1: Razorpay Channel Adapter

export interface PaymentLinkResult {
  linkId: string;
  shortUrl: string;
  simulated: boolean;
  amountInr: number;
  /** ISO expiry supplied by Razorpay (or generated for a simulated link). */
  expiresAt: string;
  status: "created";
}

/** Durable link data stored on a recovery case or channel session. */
export interface StoredPaymentLink {
  linkId: string;
  shortUrl: string;
  simulated: boolean;
  amountInr: number;
  expiresAt?: string;
  status: "created" | "pending" | "partially_paid" | "paid" | "expired" | "cancelled";
}

/**
 * Create a Razorpay Payment Link with auto-expiry.
 * Falls back to a mock link when no client is available.
 */
export async function createRecoveryPaymentLink(
  client: Razorpay | null,
  params: {
    amountInr: number;
    customerName?: string;
    customerEmail?: string;
    customerContact?: string;
    description?: string;
    expirySeconds?: number;
    notes?: Record<string, string>;
  }
): Promise<PaymentLinkResult> {
  // Razorpay requires expire_by to be strictly > 15 minutes in the future.
  // We default to 24 hours (86400s) or ensure at least 30 minutes (1800s) buffer.
  const expirySec = Math.max(params.expirySeconds || 86400, 1800);
  const expiresAt = new Date(Date.now() + expirySec * 1000).toISOString();
  if (client) {
    try {
      const response = await client.paymentLink.create({
        amount: Math.round(params.amountInr * 100),
        currency: "INR",
        accept_partial: false,
        description: params.description || "RazorVasooli AI Revenue Recovery",
        customer: {
          name: params.customerName || "Customer",
          email: params.customerEmail || "customer@example.com",
          contact: params.customerContact || "+919876543210",
        },
        notify: { sms: true, email: true },
        reminder_enable: true,
        expire_by: Math.floor(new Date(expiresAt).getTime() / 1000),
        notes: { recovery_agent: "RazorVasooli.Ai", ...(params.notes || {}) },
      } as any);
      return {
        linkId: response.id,
        shortUrl: response.short_url,
        simulated: false,
        amountInr: params.amountInr,
        expiresAt: response.expire_by ? new Date(Number(response.expire_by) * 1000).toISOString() : expiresAt,
        status: "created",
      };
    } catch (err: any) {
      console.warn("[Channels] Razorpay payment link API error, using mock:", err?.message);
    }
  }
  return {
    linkId: `plink_sim_${Date.now().toString(36)}`,
    shortUrl: `https://rzp.io/i/vasooli-${Math.random().toString(36).substring(2, 9)}`,
    simulated: true,
    amountInr: params.amountInr,
    expiresAt,
    status: "created",
  };
}

/**
 * Reuse a still-active link for the same amount. A failed status lookup never
 * creates a duplicate link: we retain the known-unexpired link instead.
 */
export async function getOrCreateRecoveryPaymentLink(
  client: Razorpay | null,
  existing: StoredPaymentLink | undefined,
  params: Parameters<typeof createRecoveryPaymentLink>[1]
): Promise<{ link: PaymentLinkResult; reused: boolean }> {
  // 1. Check existing case-specific link
  if (existing && existing.amountInr === params.amountInr) {
    let status = existing.status;
    let expiresAt = existing.expiresAt;

    if (!existing.simulated && client) {
      try {
        const remote = await (client as any).paymentLink.fetch(existing.linkId);
        status = String(remote?.status || status) as StoredPaymentLink["status"];
        if (remote?.expire_by) expiresAt = new Date(Number(remote.expire_by) * 1000).toISOString();
      } catch (err: any) {
        console.warn(`[Channels] Could not refresh link ${existing.linkId}; reusing known link:`, err?.message);
      }
    }

    const expiredByTime = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
    const reusable = !expiredByTime && ["created", "pending", "partially_paid"].includes(status);
    if (reusable) {
      return {
        link: {
          linkId: existing.linkId,
          shortUrl: existing.shortUrl,
          simulated: existing.simulated,
          amountInr: existing.amountInr,
          expiresAt: expiresAt || new Date(Date.now() + 86400 * 1000).toISOString(),
          status: "created",
        },
        reused: true,
      };
    }
  }

  // 2. Query PostgreSQL registered payment links before creating new links
  try {
    const { dbLoadRegisteredPaymentLinks } = await import("../core/db.js");
    const dbLinks = await dbLoadRegisteredPaymentLinks(100);
    const caseId = params.notes?.case_id;

    // Look for exact match (by email, phone, caseId, or unassigned matching amount)
    const match = dbLinks.find((l) => {
      if (l.amountInr !== params.amountInr) return false;
      if (l.status === "expired" || l.status === "cancelled") return false;
      if (caseId && l.caseId === caseId) return true;
      if (params.customerEmail && l.customerEmail && l.customerEmail.toLowerCase() === params.customerEmail.toLowerCase()) return true;
      if (params.customerContact && l.customerPhone && l.customerPhone === params.customerContact) return true;
      return false;
    }) || dbLinks.find((l) => l.amountInr === params.amountInr && l.status === "created" && !l.customerEmail && !l.caseId);

    if (match) {
      console.log(`[Channels] ♻️ Reusing DB registered payment link for ₹${params.amountInr}: ${match.shortUrl} (${match.id})`);
      return {
        link: {
          linkId: match.id,
          shortUrl: match.shortUrl,
          simulated: match.simulated || false,
          amountInr: match.amountInr,
          expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
          status: "created",
        },
        reused: true,
      };
    }
  } catch (err: any) {
    console.warn("[Channels] DB link lookup skipped:", err?.message);
  }

  // 3. Fallback: Create new link via live Razorpay API and save to DB
  const newLink = await createRecoveryPaymentLink(client, params);
  try {
    const { dbSaveRegisteredPaymentLink } = await import("../core/db.js");
    await dbSaveRegisteredPaymentLink({
      id: newLink.linkId,
      shortUrl: newLink.shortUrl,
      amountInr: newLink.amountInr,
      customerName: params.customerName || null,
      customerEmail: params.customerEmail || null,
      customerPhone: params.customerContact || null,
      caseId: params.notes?.case_id || null,
      notes: params.description || null,
      status: "created",
      simulated: newLink.simulated,
    });
  } catch (err: any) {
    console.warn("[Channels] Failed to save new link to DB:", err?.message);
  }

  return { link: newLink, reused: false };
}

/**
 * Create a Subscription Update-Payment-Method link for halted subscriptions.
 */
export async function createSubscriptionUpdateMethodLink(
  client: Razorpay | null,
  params: { subscriptionId: string; customerEmail?: string; description?: string }
): Promise<PaymentLinkResult> {
  const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
  if (client) {
    try {
      // Razorpay: create a payment link tied to the subscription for method update
      const response = await (client as any).paymentLink.create({
        amount: 100, // ₹1 placeholder for method update authorization
        currency: "INR",
        accept_partial: false,
        description: params.description || "Update payment method for your subscription",
        subscription_id: params.subscriptionId,
        customer: { email: params.customerEmail || "customer@example.com" },
        notify: { sms: true, email: true },
        reminder_enable: true,
        expire_by: Math.floor(new Date(expiresAt).getTime() / 1000),
      });
      return {
        linkId: response.id,
        shortUrl: response.short_url,
        simulated: false,
        amountInr: 1,
        expiresAt: response.expire_by ? new Date(Number(response.expire_by) * 1000).toISOString() : expiresAt,
        status: "created",
      };
    } catch (err: any) {
      console.warn("[Channels] Subscription UPM link API error, using mock:", err?.message);
    }
  }
  return {
    linkId: `upm_sim_${Date.now().toString(36)}`,
    shortUrl: `https://rzp.io/i/upm-${params.subscriptionId.slice(-6)}-${Math.random()
      .toString(36)
      .substring(2, 6)}`,
    simulated: true,
    amountInr: 1,
    expiresAt,
    status: "created",
  };
}

/**
 * Send/resend a Razorpay Invoice reminder.
 */
export async function sendInvoiceReminder(
  client: Razorpay | null,
  invoiceId: string
): Promise<{ success: boolean; simulated: boolean }> {
  if (client) {
    try {
      await (client as any).invoices.notifyBy(invoiceId, { medium: "email" });
      return { success: true, simulated: false };
    } catch (err: any) {
      console.warn("[Channels] Invoice reminder API error, simulating:", err?.message);
    }
  }
  console.log(`[Channels] 📨 Simulated invoice reminder sent for ${invoiceId}`);
  return { success: true, simulated: true };
}

// Task 6.2: Communication Channels (Email & SMS/WhatsApp)

export interface InterventionMessageParams {
  channel: OutboxChannel;
  caseId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  amountInr: number;
  declineCode?: string;
  discountPercent?: number;
  customMessage?: string;
  paymentLink: string;
  paymentLinkId?: string;
  simulated?: boolean;
  actionUrls: ActionLinks;
}

/** Render a personalized Hinglish recovery message body */
export function renderRecoveryMessage(params: InterventionMessageParams): {
  subject: string;
  body: string;
  htmlBody: string;
} {
  const name = params.customerName.split(" ")[0] || "ji";
  const amt = `₹${params.amountInr.toLocaleString("en-IN")}`;
  const discountLine = params.discountPercent
    ? `\n🎁 Aapke liye ${params.discountPercent}% discount bhi apply hai — sirf is link par!`
    : "";

  const subject = `Action needed: ${amt} payment pending (${params.declineCode || "payment failed"})`;

  let body = "";
  if (params.customMessage) {
    body = params.customMessage.replace(/\{\{PAYMENT_LINK\}\}/g, params.paymentLink) +
      `\n\n— RazorVasooli.AI\nSent at ${new Date().toISOString()}`;
  } else {
    body =
      `Namaste ${name},\n\n` +
      `Aapka recent payment of ${amt} successfully complete nahi ho paya` +
      `${params.declineCode ? ` (${params.declineCode})` : ""}.${discountLine}\n\n` +
      `✅ Pay now (1-click): ${params.actionUrls.pay}\n` +
      `📅 Baad me pay karna hai? Promise karein: ${params.actionUrls.promise}\n` +
      `🔗 Direct payment link: ${params.paymentLink}\n\n` +
      `Agar aap aur messages nahi chahte, yahan opt-out karein: ${params.actionUrls.optout}\n\n` +
      `— RazorVasooli.AI (automated recovery assistant)\n` +
      `Sent at ${new Date().toISOString()} | DPDP compliant | Quiet hours respected`;
  }

  const formattedBody = params.customMessage
    ? params.customMessage.replace(/\{\{PAYMENT_LINK\}\}/g, `<a href="${params.paymentLink}">${params.paymentLink}</a>`).replace(/\n/g, "<br/>")
    : `Aapka recent payment of <strong>${amt}</strong> successfully complete nahi ho paya${params.declineCode ? ` (<em>${params.declineCode}</em>)` : ""}.`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); background-color: #ffffff;">
      <h2 style="color: #0f172a; margin-top: 0;">Namaste ${name},</h2>
      
      <p style="color: #334155; font-size: 16px; line-height: 1.6;">
        ${formattedBody}
      </p>
      
      ${params.discountPercent ? `
      <div style="margin: 20px 0; padding: 15px; background-color: #ecfdf5; border-radius: 8px; border-left: 4px solid #10b981; color: #065f46; font-weight: 500;">
        🎁 Aapke liye ${params.discountPercent}% discount bhi apply hai — sirf niche diye gaye link par!
      </div>` : ""}
      
      <div style="margin: 35px 0;">
        <a href="${params.actionUrls.pay}" style="display: block; padding: 14px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; text-align: center; font-weight: 600; font-size: 18px; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2);">
          ✅ Pay Now (1-click)
        </a>
        
        <div style="display: flex; gap: 15px; justify-content: center; margin-top: 15px;">
          <a href="${params.actionUrls.promise}" style="flex: 1; padding: 12px 15px; background-color: #f8fafc; color: #475569; text-decoration: none; border-radius: 8px; text-align: center; border: 1px solid #cbd5e1; font-weight: 500; font-size: 15px;">
            📅 Promise to Pay
          </a>
          <a href="${params.paymentLink}" style="flex: 1; padding: 12px 15px; background-color: #f8fafc; color: #475569; text-decoration: none; border-radius: 8px; text-align: center; border: 1px solid #cbd5e1; font-weight: 500; font-size: 15px;">
            🔗 Direct Link
          </a>
        </div>
      </div>
      
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;" />
      
      <p style="color: #64748b; font-size: 13px; margin-bottom: 5px;">
        — RazorVasooli.AI (Automated Recovery Assistant)
      </p>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 0;">
        Sent at ${new Date().toISOString()} &nbsp;|&nbsp; DPDP compliant &nbsp;|&nbsp; <a href="${params.actionUrls.optout}" style="color: #94a3b8; text-decoration: underline;">Opt-out from emails</a>
      </p>
    </div>
  `;

  return { subject, body, htmlBody };
}

/**
 * Send an intervention message via Email or SMS/WhatsApp.
 * Email goes to the Mailpit-style outbox; SMS/WhatsApp records delivery.
 */
export function sendInterventionMessage(params: InterventionMessageParams): OutboxEntry {
  const { subject, body, htmlBody } = renderRecoveryMessage(params);

  const entry = recordOutbox({
    channel: params.channel,
    to: params.channel === "email" ? params.customerEmail || "unknown@example.com" : params.customerPhone || "+910000000000",
    subject: params.channel === "email" ? subject : undefined,
    body,
    paymentLink: params.paymentLink,
    actionUrls: params.actionUrls,
    caseId: params.caseId,
  });

  // Real SMTP side-channel for email (outbox entry still recorded either way)
  if (smtpTransporter && params.customerEmail) {
    void deliverViaSmtp(params.customerEmail, subject, body, htmlBody);
  }

  if (globalTelegramAgent && params.customerPhone) {
    void globalTelegramAgent.pushWebhookIntervention({
      amountInr: params.amountInr,
      declineCode: params.declineCode,
      paymentLink: params.paymentLink,
      paymentLinkId: params.paymentLinkId,
      simulated: params.simulated,
      customerContact: params.customerPhone,
    });
  }

  return entry;
}
