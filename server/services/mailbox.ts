/**
 * RazorVasooli.Ai — Inbound Email Channel (IMAP) + AI Reply Loop
 *
 * The "working Gmail system":
 *   1. Customer replies to our recovery email from their inbox (Gmail etc.)
 *   2. IMAP polling picks up the new message (no public URL needed)
 *   3. AI reads it → Hinglish intent extraction (promise/optout/discount/paid)
 *   4. AI composes and SENDS a reply email back via SMTP
 *   5. Everything lands in the merchant dashboard (Email view) + audit chain
 *
 * Env:
 *   IMAP_HOST / IMAP_PORT / IMAP_USER / IMAP_PASS   — mailbox to poll
 *     (Gmail: imap.gmail.com:993 + App Password — needs 2FA enabled)
 *   SMTP_* (already used for outbound)              — reply delivery
 *   GEMINI_API_KEY                                  — AI reply brain (fallback: templates)
 */

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { dbEnabled, dbSaveMailConversation, dbLoadMailConversations } from "../core/db.js";
import type { StoredPaymentLink } from "./channels.js";
import type { AuditService } from "./audit.js";
import type Razorpay from "razorpay";

const MAX_DISCOUNT_PERCENT = 10;

export interface MailMessage {
  dir: "in" | "out";
  subject: string;
  body: string;
  at: string;
}

export interface MailAction {
  tool: string;
  detail: string;
  at: string;
}

export interface MailConversation {
  email: string;
  name: string;
  amountInr: number;
  declineCode: string;
  discountPercent: number;
  pendingOptOut?: boolean;
  promisedDate?: string;
  optedOut: boolean;
  recovered: boolean;
  paymentLink?: StoredPaymentLink;
  messages: MailMessage[];
  actions: MailAction[];
  updatedAt: string;
}

export interface InboundEmailDeps {
  razorpayClient: Razorpay | null;
  auditService: AuditService;
  geminiApiKey?: string;
  orchestrator?: import("./orchestrator.js").OrchestratorService;
  policyService?: import("./policy.js").PolicyService;
}

const conversations = new Map<string, MailConversation>();

function ensureConversation(email: string): MailConversation {
  let c = conversations.get(email.toLowerCase());
  if (!c) {
    c = {
      email: email.toLowerCase(),
      name: email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
      amountInr: parseInt(process.env.SESSION_AMOUNT_INR || "501", 10),
      declineCode: "INSUFFICIENT_FUNDS",
      discountPercent: 0,
      optedOut: false,
      recovered: false,
      paymentLink: {
        linkId: "plink_TW1geGvQMHmYfx",
        shortUrl: "https://rzp.io/rzp/Gc0lQdyM",
        amountInr: 501,
        simulated: false,
        status: "created",
      },
      messages: [],
      actions: [],
      updatedAt: new Date().toISOString(),
    };
    conversations.set(c.email, c);
  }
  return c;
}

function dueAmount(c: MailConversation): number {
  return Math.round(c.amountInr * (1 - c.discountPercent / 100));
}

/** Boot-time restore from Postgres. */
async function hydrateFromDB(): Promise<void> {
  const rows = await dbLoadMailConversations();
  for (const row of rows) {
    const d = row.data as any;
    if (!d || !d.name) continue;
    const c: MailConversation = {
      email: row.email,
      name: d.name,
      amountInr: d.amountDueInr || parseInt(process.env.SESSION_AMOUNT_INR || "501", 10),
      declineCode: d.declineCode || "INSUFFICIENT_FUNDS",
      discountPercent: d.discountPercent || 0,
      promisedDate: d.promisedDate,
      optedOut: !!d.optedOut,
      recovered: !!d.recovered,
      paymentLink: d.paymentLink || {
        linkId: "plink_TW1geGvQMHmYfx",
        shortUrl: "https://rzp.io/rzp/Gc0lQdyM",
        amountInr: 501,
        simulated: false,
        status: "created",
      },
      messages: Array.isArray(d.messages) ? d.messages : [],
      actions: Array.isArray(d.actions) ? d.actions : [],
      updatedAt: d.updatedAt || new Date().toISOString(),
    };
    conversations.set(c.email, c);
  }
}

let hydrated = false;
export async function ensureMailHydrated(): Promise<void> {
  if (hydrated || !dbEnabled()) return;
  hydrated = true;
  await hydrateFromDB();
  console.log(`[Email] ♻️ Restored ${conversations.size} mail conversation(s) from PostgreSQL`);
}

export function getMailConversations(): MailConversation[] {
  return [...conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Inbound message handling: AI reads → acts → replies

async function handleInboundEmail(deps: InboundEmailDeps, from: string, subject: string, bodyText: string): Promise<void> {
  const c = ensureConversation(from);
  if (c.optedOut) return; // DPDP — never engage after opt-out

  // Resolve target case
  let targetCaseId: string | undefined;
  if (deps.orchestrator) {
    const matches = deps.orchestrator.getCases({ limit: 200 }).filter(
      (cs: any) =>
        cs.customerEmail?.toLowerCase() === from.toLowerCase() &&
        !["RECOVERED", "CLOSED_LOST", "SKIPPED_COMPLIANCE"].includes(cs.state)
    );
    // Never merge a reply into an arbitrary case when this customer has
    // multiple active failures. Correlation must come from a case token.
    if (matches.length === 1) targetCaseId = matches[0].id;
  }

  // Two-step opt-out confirmation (DPDP consent flow)
  if (c.pendingOptOut) {
    c.messages.push({ dir: "in", subject, body: bodyText.slice(0, 2000), at: new Date().toISOString() });
    deps.auditService.append("customer.reply", { caseId: targetCaseId || null, channel: "email", from, subject, message: bodyText });

    if (targetCaseId && deps.orchestrator) {
      const res = deps.orchestrator.handleOptOutConfirmation(targetCaseId, bodyText);
      if (res.confirmed) {
        c.pendingOptOut = false;
        c.optedOut = true;
        c.actions.push({ tool: "opt_out", detail: "Opt-out confirmed by customer — all email contact stopped", at: new Date().toISOString() });
        deps.auditService.append("dpdp.optout.email", { from, confirmed: true, caseId: targetCaseId });
      } else if (/\b(no|nahi|nahin|cancel|rakho)\b/i.test(bodyText)) {
        c.pendingOptOut = false;
      }
      c.messages.push({ dir: "out", subject: `Re: ${subject}`, body: res.message, at: new Date().toISOString() });
      c.updatedAt = new Date().toISOString();
      await sendMail(from, `Re: ${subject}`, res.message);
      deps.auditService.append("intervention.executed", { caseId: targetCaseId, channel: "email", message: res.message });
      return;
    }

    const t = bodyText.toLowerCase();
    const yes = /\b(yes|haan|han|haa|confirm|kar do|kardo|band kar do|ok|okay|sure)\b/.test(t);
    let reply: string;
    if (yes) {
      c.pendingOptOut = false;
      c.optedOut = true;
      c.actions.push({ tool: "opt_out", detail: "Opt-out confirmed by customer — all email contact stopped", at: new Date().toISOString() });
      deps.auditService.append("dpdp.optout.email", { from, confirmed: true });
      reply = "✅ Confirm ho gaya ji. Aapko ab koi email nahi aayega. Aapke din shubh ho! 🙏 (DPDP compliant)";
    } else {
      c.pendingOptOut = false;
      reply = "Theek hai ji! Main payment reminders bhejti rahungi 😊 Kuch aur help chahiye?";
    }
    c.messages.push({ dir: "out", subject: `Re: ${subject}`, body: reply, at: new Date().toISOString() });
    c.updatedAt = new Date().toISOString();
    await sendMail(from, `Re: ${subject}`, reply);
    return;
  }

  // 1. Sync registered payment link and customer details from PostgreSQL
  try {
    const { dbLoadRegisteredPaymentLinks } = await import("../core/db.js");
    const dbLinks = await dbLoadRegisteredPaymentLinks(50);
    let dbMatch = dbLinks.find((l) => l.customerEmail && l.customerEmail.toLowerCase() === from.toLowerCase() && l.status !== "expired");
    if (!dbMatch && dbLinks.length > 0) {
      dbMatch = dbLinks.find((l) => l.status !== "expired") || dbLinks[0];
    }
    if (dbMatch) {
      c.amountInr = dbMatch.amountInr;
      if (dbMatch.customerName) c.name = dbMatch.customerName;
      c.paymentLink = {
        linkId: dbMatch.id,
        shortUrl: dbMatch.shortUrl,
        amountInr: dbMatch.amountInr,
        simulated: !!dbMatch.simulated,
        status: "created",
      };
    }
  } catch (err: any) {
    console.warn("[Email] DB link sync error:", err?.message);
  }

  c.messages.push({ dir: "in", subject, body: bodyText.slice(0, 2000), at: new Date().toISOString() });
  deps.auditService.append("customer.reply", { caseId: targetCaseId || null, channel: "email", from, subject, message: bodyText });

  let replySubject = `Re: ${subject}`;
  let replyBody = "";

  // 2. Pure Gemini AI Intent Understanding & Response Generation
  try {
    const { geminiComplete } = await import("./policy.js");

    const prompt = `You are RazorVasooli AI, a polite, empathetic, respectful, and highly competent revenue recovery assistant for an Indian merchant.
Customer Details:
- Name: ${c.name}
- Email: ${from}
- Pending Amount: ₹${dueAmount(c)} (Originally ₹${c.amountInr}${c.discountPercent ? `, with ${c.discountPercent}% discount` : ""})
- Reason for payment failure: ${c.declineCode}
- Secure Razorpay Payment Link: ${c.paymentLink?.shortUrl || "https://rzp.io/rzp/Gc0lQdyM"}
- Today's Date: ${new Date().toISOString().split("T")[0]}

Recent Email History:
${c.messages.slice(-6).map((m) => `${m.dir === "in" ? "Customer" : "Assistant"}: ${m.body}`).join("\n\n")}

New Inbound Customer Email:
"${bodyText}"

Instructions:
1. Understand the customer's intent:
   - "promise": The customer gives a specific date or timeframe when they will pay (e.g. tomorrow, 5th of next month, salary day). Extract the exact promised date in YYYY-MM-DD format.
   - "ask_date": The customer says they cannot pay now or need time, but DID NOT provide a specific date. Politely ask what date they can pay.
   - "need_link": The customer asks for the payment link or how to pay.
   - "discount": The customer asks for a discount / concession. You can grant up to 10% discount if not already applied.
   - "paid": The customer claims they have already paid.
   - "opt_out": The customer asks to stop sending emails / unsubscribe.
   - "general": Question, dispute, or general remark.
2. Generate an empathetic, helpful, clear response in natural Hinglish (Hindi + English conversational). Keep it polite, professional, and directly address what they said.
3. If they ask for payment link or if payment is needed, include the exact link: ${c.paymentLink?.shortUrl || "https://rzp.io/rzp/Gc0lQdyM"}.

Respond ONLY with a JSON object in this format (no markdown fences, just pure JSON):
{
  "intent": "promise" | "ask_date" | "need_link" | "discount" | "paid" | "opt_out" | "general",
  "promisedDate": "YYYY-MM-DD or null",
  "discountPercent": number or null,
  "replyMessage": "Your generated reply text in natural Hinglish"
}`;

    console.log(`[Email] 🧠 Calling Gemini 3 Flash Preview for email from ${from}...`);
    const rawAiResponse = await geminiComplete(prompt);
    console.log(`[Email] 🤖 Gemini response received:`, rawAiResponse.slice(0, 120));

    let cleanJson = rawAiResponse.trim();
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    const aiParsed = JSON.parse(cleanJson);
    replyBody = aiParsed.replyMessage || "";

    if (aiParsed.intent === "opt_out") {
      c.pendingOptOut = true;
      replyBody = "Ek confirmation chahiye ji 🙏 Kya aap waqai SAARE payment reminder emails band karna chahte hain?\n\n'YES' reply karein confirm karne ke liye, ya 'NO' likhein agar emails continue rakhne hain.";
      c.actions.push({ tool: "opt_out_confirm", detail: "Confirmation requested from customer", at: new Date().toISOString() });
    } else if (aiParsed.intent === "promise" && aiParsed.promisedDate) {
      c.promisedDate = String(aiParsed.promisedDate);
      c.actions.push({ tool: "record_promise", detail: `Promise recorded for ${c.promisedDate}`, at: new Date().toISOString() });
      deps.auditService.append("promise.recorded", { channel: "email", from, promisedDate: c.promisedDate });
      if (targetCaseId && deps.orchestrator && c.promisedDate) {
        deps.orchestrator.recordPromise(targetCaseId, c.promisedDate, dueAmount(c));
      }
    } else if (aiParsed.intent === "discount" && typeof aiParsed.discountPercent === "number") {
      c.discountPercent = Math.min(MAX_DISCOUNT_PERCENT, Math.max(c.discountPercent, aiParsed.discountPercent));
      c.actions.push({ tool: "set_discount", detail: `${c.discountPercent}% discount applied → ₹${dueAmount(c).toLocaleString("en-IN")}`, at: new Date().toISOString() });
    } else if (aiParsed.intent === "paid") {
      await handlePaidClaim(deps, c);
    }

    c.actions.push({ tool: "gemini_reply", detail: `Intent: ${aiParsed.intent}`, at: new Date().toISOString() });
  } catch (err: any) {
    console.error("[Email] Gemini processing error:", err?.message);
    replyBody = `Namaste ${c.name} ji 🙏 Aapka ₹${dueAmount(c).toLocaleString("en-IN")} pending hai. Niche diye secure link se pay kar sakte hain ya bataiye kab tak kar payenge:\n\n${c.paymentLink?.shortUrl || "https://rzp.io/rzp/Gc0lQdyM"}`;
  }

  if (!replyBody || !replyBody.trim()) {
    console.warn(`[Email] ⚠️ No valid reply text generated for ${from}; skipping empty email.`);
    return;
  }

  c.messages.push({ dir: "out", subject: replySubject, body: replyBody, at: new Date().toISOString() });
  c.updatedAt = new Date().toISOString();
  deps.auditService.append("email.ai_reply_sent", { to: from, intent: "unknown" });
  await sendMail(from, replySubject, replyBody);
  void persistConversation(c);
}

export async function persistConversation(c: MailConversation): Promise<void> {
  await dbSaveMailConversation(c.email, JSON.parse(JSON.stringify({
    name: c.name, amountDueInr: dueAmount(c), declineCode: c.declineCode,
    discountPercent: c.discountPercent, promisedDate: c.promisedDate,
    optedOut: c.optedOut, recovered: c.recovered, paymentLink: c.paymentLink,
    messages: c.messages.slice(-50), actions: c.actions.slice(-30),
    createdAt: new Date().toISOString(), updatedAt: c.updatedAt,
  })));
}


async function sendMail(to: string, subject: string, body: string): Promise<boolean> {
  if (!body || !body.trim()) {
    console.warn(`[Email] ⚠️ Refusing to send empty email to ${to}`);
    return false;
  }
  if (!process.env.SMTP_HOST) {
    console.warn("[Email] SMTP not configured — reply not sent (outbox-only mode)");
    return false;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "1025", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
      : undefined,
  });
  try {
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM || "RazorVasooli.Ai <recovery@razorvasooli.demo>",
      to,
      subject,
      text: body.trim(),
    });
    console.log(`[Email] 📬 AI reply sent → ${to} (${info.messageId})`);
    return true;
  } catch (err: any) {
    console.warn("[Email] reply send failed:", err?.message);
    return false;
  }
}

async function handlePaidClaim(deps: InboundEmailDeps, c: MailConversation): Promise<void> {
  if (c.paymentLink?.simulated) {
    c.recovered = true;
    if (c.paymentLink) c.paymentLink.status = "paid";
  } else if (c.paymentLink && deps.razorpayClient) {
    try {
      const link = await (deps.razorpayClient as any).paymentLink.fetch(c.paymentLink.linkId);
      if (link?.status === "paid") {
        c.recovered = true;
        if (c.paymentLink) c.paymentLink.status = "paid";
      }
    } catch (err: any) {
      console.warn("[Email] payment verify failed:", err?.message);
    }
  }
  if (c.recovered) {
    c.actions.push({ tool: "verify_payment", detail: "Payment verified ✅", at: new Date().toISOString() });
    deps.auditService.append("recovery.recorded", { channel: "email", from: c.email, amountInr: dueAmount(c), simulated: c.paymentLink?.simulated ?? false });
  }
}

// IMAP polling

function extractTextFromSource(source: string): string {
  if (!source) return "";

  // 1. Separate RFC822 top-level headers from message body
  const headerEnd = source.indexOf("\r\n\r\n") !== -1 ? source.indexOf("\r\n\r\n") : source.indexOf("\n\n");
  let bodyOnly = headerEnd !== -1 ? source.slice(headerEnd + 2) : source;

  // 2. Extract plain-text part if multipart
  const plainMatch = bodyOnly.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
  let raw = plainMatch ? plainMatch[1] : bodyOnly;

  // 3. Strip HTML markup & styles
  raw = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  // 4. Strip quoted history ("On ... wrote:", "> ...", "--- Original Message ---")
  const lines = raw.split(/\r?\n/);
  const cleanLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">") || /^on\s+.+wrote:$/i.test(trimmed) || /^from:\s+.+/i.test(trimmed)) {
      break; // Stop at quoted thread history
    }
    // Filter out residual header leak lines
    if (/^(Delivered-To|Received|ARC-Seal|ARC-Message|ARC-Authentication|Return-Path|Received-SPF|Authentication-Results|DKIM-Signature|MIME-Version):/i.test(trimmed)) {
      continue;
    }
    cleanLines.push(line);
  }

  return cleanLines
    .join("\n")
    .replace(/=\r?\n/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 3000);
}

let imapTimer: NodeJS.Timeout | null = null;
let imapBusy = false;

export function imapEnabled(): boolean {
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

export async function pollInbox(deps: InboundEmailDeps): Promise<number> {
  if (!imapEnabled() || imapBusy) return 0;
  imapBusy = true;
  let processed = 0;
  const client = new ImapFlow({
    host: process.env.IMAP_HOST!,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASS! },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(process.env.IMAP_MAILBOX || "INBOX");
    try {
      const uids: number[] = [];
      for await (const msg of client.fetch({ seen: false }, { envelope: true, uid: true, source: true })) {
        uids.push(msg.uid);
        const addr = msg.envelope?.from?.[0]?.address;
        if (!addr || !msg.source) continue;

        // Skip bot / daemon / self loop messages
        const isBotOrBounce =
          /mailer-daemon|postmaster|noreply|no-reply|notification/i.test(addr) ||
          addr.toLowerCase() === (process.env.IMAP_USER || "").toLowerCase() ||
          addr.toLowerCase() === (process.env.SMTP_USER || "").toLowerCase();

        if (isBotOrBounce) {
          console.log(`[Email] ⏭️ Skipping bot/bounce address: ${addr}`);
          continue;
        }

        const text = extractTextFromSource(msg.source.toString());
        if (!text || text.length < 2) {
          console.log(`[Email] ⏭️ Skipping empty body email from ${addr}`);
          continue;
        }

        const subject = msg.envelope?.subject || "(no subject)";
        console.log(`[Email] 📥 Inbound from ${addr}: "${subject}" | Content: "${text.slice(0, 80)}"`);
        await handleInboundEmail(deps, addr, subject, text);
        processed++;
      }
      if (uids.length) {
        await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err: any) {
    console.warn("[Email] IMAP poll failed:", err?.message);
  } finally {
    imapBusy = false;
  }
  return processed;
}

export function startImapPolling(deps: InboundEmailDeps): void {
  if (!imapEnabled()) {
    console.log("📧 [Inbound Email] IMAP not configured — inbound email replies disabled (set IMAP_* env)");
    return;
  }
  console.log(`📧 [Inbound Email] IMAP polling live → ${process.env.IMAP_USER}@${process.env.IMAP_HOST}`);
  void pollInbox(deps);
  imapTimer = setInterval(() => void pollInbox(deps), parseInt(process.env.IMAP_POLL_SECONDS || "30", 10) * 1000);
}

export function stopImapPolling(): void {
  if (imapTimer) clearInterval(imapTimer);
  imapTimer = null;
}
