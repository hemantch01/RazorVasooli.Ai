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
import { parseHinglishReply } from "./voice.js";
import { dbEnabled, dbSaveMailConversation, dbLoadMailConversations } from "../core/db.js";
import { createRecoveryPaymentLink } from "./channels.js";
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
  paymentLink?: { linkId: string; shortUrl: string; simulated: boolean; status: "pending" | "paid" };
  messages: MailMessage[];
  actions: MailAction[];
  updatedAt: string;
}

export interface InboundEmailDeps {
  razorpayClient: Razorpay | null;
  auditService: AuditService;
  geminiApiKey?: string;
}

const conversations = new Map<string, MailConversation>();

function ensureConversation(email: string): MailConversation {
  let c = conversations.get(email.toLowerCase());
  if (!c) {
    c = {
      email: email.toLowerCase(),
      name: email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
      amountInr: parseInt(process.env.SESSION_AMOUNT_INR || "2499", 10),
      declineCode: "INSUFFICIENT_FUNDS",
      discountPercent: 0,
      optedOut: false,
      recovered: false,
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
      amountInr: d.amountDueInr || parseInt(process.env.SESSION_AMOUNT_INR || "2499", 10),
      declineCode: d.declineCode || "INSUFFICIENT_FUNDS",
      discountPercent: d.discountPercent || 0,
      promisedDate: d.promisedDate,
      optedOut: !!d.optedOut,
      recovered: !!d.recovered,
      paymentLink: d.paymentLink,
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

  // Two-step opt-out confirmation (DPDP consent flow)
  if (c.pendingOptOut) {
    c.messages.push({ dir: "in", subject, body: bodyText.slice(0, 2000), at: new Date().toISOString() });
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

  c.messages.push({ dir: "in", subject, body: bodyText.slice(0, 2000), at: new Date().toISOString() });
  deps.auditService.append("email.inbound_received", { from, subject });

  const intent = parseHinglishReply(bodyText);
  const replySubject = `Re: ${subject}`;
  let replyBody = "";

  const sendLinkIfNeeded = async () => {
    if (!c.paymentLink) {
      const link = await createRecoveryPaymentLink(deps.razorpayClient, {
        amountInr: dueAmount(c),
        customerName: c.name,
        customerEmail: c.email,
        description: "RazorVasooli email recovery",
      });
      c.paymentLink = { linkId: link.linkId, shortUrl: link.shortUrl, simulated: link.simulated, status: "pending" };
    }
    replyBody += `\n\n💳 Secure payment link: ${c.paymentLink.shortUrl}`;
  };

  switch (intent.intent) {
    case "optout": {
      // Two-step consent: ask before stopping (DPDP consent flow)
      c.pendingOptOut = true;
      c.actions.push({ tool: "opt_out_confirm", detail: "Confirmation requested from customer", at: new Date().toISOString() });
      replyBody = "Ek confirmation chahiye ji 🙏 Kya aap waqai SAARE payment reminder emails band karna chahte hain?\n\n'YES' reply karein confirm karne ke liye, ya 'NO' likhein agar emails continue rakhne hain.";
      break;
    }
    case "promise": {
      c.promisedDate = intent.promisedDate || new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
      c.actions.push({ tool: "record_promise", detail: `Promise recorded for ${c.promisedDate}`, at: new Date().toISOString() });
      deps.auditService.append("promise.recorded", { channel: "email", from, promisedDate: c.promisedDate });
      replyBody = `Namaste ${c.name} ji! 📌 Maine aapka promise note kar liya hai — ${c.promisedDate} tak. Us din ek gentle reminder bhej dungi. Tab tak service chalti rahegi 😊`;
      break;
    }
    case "discount_request": {
      c.discountPercent = Math.min(MAX_DISCOUNT_PERCENT, 10);
      c.actions.push({ tool: "set_discount", detail: `${c.discountPercent}% discount applied → ₹${dueAmount(c).toLocaleString("en-IN")}`, at: new Date().toISOString() });
      await sendLinkIfNeeded();
      replyBody = `Ji bilkul! 🎁 Humne aapke liye ${c.discountPercent}% loyalty discount apply kar diya hai. Naya amount sirf ₹${dueAmount(c).toLocaleString("en-IN")} hai.`;
      break;
    }
    case "paid": {
      await handlePaidClaim(deps, c);
      replyBody = c.recovered
        ? "🎉 Bahut bahut dhanyavaad ji! Payment receive ho gaya. Aapka account clear hai ✅"
        : "Ji, check kar rahi hoon… Payment gateway me abhi reflect nahi hua. 10–15 minute me confirm karke bataungi 🙏";
      break;
    }
    default: {
      if (deps.geminiApiKey) {
        replyBody = await geminiCompose(deps.geminiApiKey, c, bodyText);
      } else {
        replyBody =
          `Namaste ${c.name} ji! 🙏 Aapka ₹${dueAmount(c).toLocaleString("en-IN")} ka payment pending hai ` +
          `(last transaction fail hui thi: ${c.declineCode.replace(/_/g, " ")}). Jab aap comfortable hon, ` +
          `niche diye link se instant pay kar sakte hain. Ya mujhe bataiye kab tak kar payenge — main reminder set kar dungi 😊`;
      }
      await sendLinkIfNeeded();
      c.actions.push({ tool: "ai_reply", detail: deps.geminiApiKey ? "Gemini composed recovery reply" : "Template recovery reply", at: new Date().toISOString() });
    }
  }

  c.messages.push({ dir: "out", subject: replySubject, body: replyBody, at: new Date().toISOString() });
  c.updatedAt = new Date().toISOString();
  deps.auditService.append("email.ai_reply_sent", { to: from, intent: intent.intent });
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
      text: body,
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

/** Single-shot Gemini compose with dues context. */
async function geminiCompose(apiKey: string, c: MailConversation, customerText: string): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: "You are RazorVasooli, a warm polite Indian payment-recovery assistant replying over EMAIL in natural Hinglish " +
            "(Roman Hindi mixed with English). Keep it short (4-6 lines), empathetic, goal-oriented: get either a firm promise " +
            "date or a payment. If the customer clearly refuses all contact, politely accept and say no more emails will come. " +
            "Never mention being an AI; you represent the merchant.",
        }],
      },
      contents: [{
        role: "user",
        parts: [{
          text: `Customer: ${c.name}\nPending amount: Rs.${dueAmount(c).toLocaleString("en-IN")} (failure reason: ${c.declineCode})\n` +
            `Discount applied: ${c.discountPercent}%\nPromise on record: ${c.promisedDate || "none"}\n\n` +
            `Customer's latest email:\n"""\n${customerText.slice(0, 1500)}\n"""\n\nWrite your reply now.`,
        }],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data: any = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("").trim();
  if (!text) throw new Error("empty Gemini response");
  return text;
}

// IMAP polling

function extractTextFromSource(source: string): string {
  // Prefer the plain-text part if present, else strip HTML tags from the rest
  const decoded = source
    .replace(/------=_Part[\s\S]*?(?=--|\n\n|$)/g, " ") // drop MIME boundary noise
    .replace(/base64,[\s\S]*?(?==?\n|$)/g, " ");
  const plainMatch = decoded.match(/Content-Type: text\/plain[\s\S]*?\n\n([\s\S]*?)(?:\n--|\n\.|$)/i);
  const raw = plainMatch ? plainMatch[1] : decoded.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return raw
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
        const text = extractTextFromSource(msg.source.toString());
        const subject = msg.envelope?.subject || "(no subject)";
        console.log(`[Email] 📥 Inbound from ${addr}: "${subject}"`);
        await handleInboundEmail(deps, addr, subject, text || "(empty)");
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
