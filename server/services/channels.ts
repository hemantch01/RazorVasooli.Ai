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
        expire_by: Math.floor(Date.now() / 1000) + (params.expirySeconds || 15 * 60),
        notes: { recovery_agent: "RazorVasooli.Ai", ...(params.notes || {}) },
      } as any);
      return { linkId: response.id, shortUrl: response.short_url, simulated: false };
    } catch (err: any) {
      console.warn("[Channels] Razorpay payment link API error, using mock:", err?.message);
    }
  }
  return {
    linkId: `plink_sim_${Date.now().toString(36)}`,
    shortUrl: `https://rzp.io/i/vasooli-${Math.random().toString(36).substring(2, 9)}`,
    simulated: true,
  };
}

/**
 * Create a Subscription Update-Payment-Method link for halted subscriptions.
 */
export async function createSubscriptionUpdateMethodLink(
  client: Razorpay | null,
  params: { subscriptionId: string; customerEmail?: string; description?: string }
): Promise<PaymentLinkResult> {
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
      });
      return { linkId: response.id, shortUrl: response.short_url, simulated: false };
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
  paymentLink: string;
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

  const body =
    `Namaste ${name},\n\n` +
    `Aapka recent payment of ${amt} successfully complete nahi ho paya` +
    `${params.declineCode ? ` (${params.declineCode})` : ""}.${discountLine}\n\n` +
    `✅ Pay now (1-click): ${params.actionUrls.pay}\n` +
    `📅 Baad me pay karna hai? Promise karein: ${params.actionUrls.promise}\n` +
    `🔗 Direct payment link: ${params.paymentLink}\n\n` +
    `Agar aap aur messages nahi chahte, yahan opt-out karein: ${params.actionUrls.optout}\n\n` +
    `— RazorVasooli.AI (automated recovery assistant)\n` +
    `Sent at ${new Date().toISOString()} | DPDP compliant | Quiet hours respected`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); background-color: #ffffff;">
      <h2 style="color: #0f172a; margin-top: 0;">Namaste ${name},</h2>
      
      <p style="color: #334155; font-size: 16px; line-height: 1.6;">
        Aapka recent payment of <strong>${amt}</strong> successfully complete nahi ho paya${params.declineCode ? ` (<em>${params.declineCode}</em>)` : ""}.
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

  // Real Telegram dispatch
  if (globalTelegramAgent && params.customerPhone) {
    void globalTelegramAgent.pushWebhookIntervention({
      amountInr: params.amountInr,
      declineCode: params.declineCode,
      paymentLink: params.paymentLink,
      customerContact: params.customerPhone,
    });
  }

  return entry;
}
