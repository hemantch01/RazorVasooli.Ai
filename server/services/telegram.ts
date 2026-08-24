/**
 * RazorVasooli.Ai — Telegram Live Channel (Gemini Agent + Razorpay Tools)
 *
 * You = the customer, chatting with the real RazorVasooli agent on Telegram.
 * The agent (Gemini) can:
 *   - look up your dues (guardrailed context)
 *   - create REAL Razorpay test payment links (mock fallback without keys)
 *   - record payment promises (feeds the promise-sweeper flow)
 *   - apply discounts (hard-capped at MAX_DISCOUNT_PERCENT in code)
 *   - honor opt-outs instantly (DPDP)
 *
 * Transport: long-polling (getUpdates) — works from localhost with no public
 * URL. The same handleUpdate() is webhook-ready for production.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather (bot disabled when absent)
 *   GEMINI_API_KEY       — enables the LLM agent (deterministic fallback otherwise)
 *   RAZORPAY_KEY_ID/SECRET — real test payment links (mock links otherwise)
 *   SESSION_AMOUNT_INR   — demo due amount (default 2499)
 */

import { parseHinglishReply, synthesizeSpeech, understandVoiceNote } from "./voice.js";
import { dbSaveTelegramSession, dbLoadTelegramSessions } from "../core/db.js";
import { createRecoveryPaymentLink } from "./channels.js";
import type { AuditService } from "./audit.js";
import type Razorpay from "razorpay";

const MAX_DISCOUNT_PERCENT = 10;
const MAX_TOOL_LOOPS = 5;
const GEMINI_MODEL = "gemini-3.6-flash";

// Session model

type ChatTurn = { role: "user" | "model"; parts: Record<string, unknown>[] };

interface PaymentLinkInfo {
  linkId: string;
  shortUrl: string;
  amountInr: number;
  simulated: boolean;
  status: "pending" | "paid";
  /** Phase H2: watchdog backoff state (safety net for missed webhooks) */
  checkAttempts?: number;
  nextCheckAt?: string;
}

/** Merchant-facing conversation log entry */
export interface TranscriptEntry {
  dir: "in" | "out" | "system";
  text: string;
  payLink?: string;
  at: string;
}

/** Merchant-facing action log (guardrailed tool executions) */
export interface ActionEntry {
  tool: string;
  detail: string;
  at: string;
}

interface TelegramSession {
  chatId: number;
  customerName: string;
  amountInr: number;
  declineCode: string;
  discountPercent: number;
  phone?: string;
  promisedDate?: string;
  optedOut: boolean;
  pendingOptOut?: boolean;
  recovered: boolean;
  /** Phase V1: when true, agent replies are ALSO sent as Hinglish voice notes */
  voiceReplies?: boolean;
  /** Phase C1: cart the customer walked away from (conversational recovery) */
  abandonedCart?: {
    items: Array<{ name: string; qty: number; price: number }>;
    totalInr: number;
    droppedAt: string;
  };
  paymentLink?: PaymentLinkInfo;
  history: ChatTurn[];
  transcript: TranscriptEntry[];
  actions: ActionEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface TelegramAgentDeps {
  razorpayClient: Razorpay | null;
  auditService: AuditService;
  geminiApiKey?: string;
  token?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

/** True when running in webhook transport mode (polling off). */
export function isWebhookMode(agent: TelegramAgent): boolean {
  return !!agent.deps.webhookUrl;
}

export class TelegramAgent {
  private sessions = new Map<number, TelegramSession>();
  private pollOffset = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(public deps: TelegramAgentDeps) {}

  get enabled(): boolean {
    return !!this.deps.token;
  }

  // Transport: long polling
  startPolling(): void {
    if (!this.enabled || this.pollTimer) return;
    console.log("📨 [Telegram] Long-polling started (no public URL needed)");
    const tick = async () => {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${this.deps.token}/getUpdates?timeout=25&offset=${this.pollOffset}`
        );
        const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        for (const update of data.result || []) {
          this.pollOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err: any) {
        console.warn("[Telegram] poll error:", err?.message);
      } finally {
        this.pollTimer = setTimeout(tick, 500);
      }
    };
    tick();

    // Payment status watchdog (Phase H2: backoff safety net, webhook is primary)
    this.startWatchdog();
  }

  /**
   * Phase H2: link-status watchdog — SAFETY NET only. Primary payment
   * detection is the Razorpay `payment_link.paid` webhook → handlePaymentLinkPaid().
   * The watchdog catches missed/delayed webhooks using per-session exponential
   * backoff (5s → 30s → 2m → 10m cap), so idle links cost almost nothing and
   * paid/recovered sessions are never polled again.
   */
  startWatchdog(): void {
    if (this.statusTimer || !this.enabled) return;
    console.log("⏱️ [Telegram] Link watchdog started (webhook primary · backoff 5s→30s→2m→10m fallback)");
    this.statusTimer = setInterval(() => void this.checkPendingLinks(), 2000);
  }

  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.pollTimer = null;
    this.statusTimer = null;
  }

  /** Boot-time restore from Postgres. */
  async hydrateFromDB(): Promise<number> {
    const rows = await dbLoadTelegramSessions();
    for (const row of rows) {
      const d = row.data as any;
      if (!d || !d.customerName) continue;
      this.sessions.set(Number(row.chat_id), {
        chatId: Number(row.chat_id),
        customerName: d.customerName,
        phone: d.phone,
        amountInr: d.amountDueInr || parseInt(process.env.SESSION_AMOUNT_INR || "2499", 10),
        declineCode: d.declineCode || "INSUFFICIENT_FUNDS",
        discountPercent: d.discountPercent || 0,
        promisedDate: d.promisedDate,
        optedOut: !!d.optedOut,
        recovered: !!d.recovered,
        voiceReplies: !!d.voiceReplies,
        abandonedCart: d.abandonedCart,
        paymentLink: d.paymentLink,
        history: Array.isArray(d.history) ? d.history : [],
        transcript: Array.isArray(d.transcript) ? d.transcript : [],
        actions: Array.isArray(d.actions) ? d.actions : [],
        createdAt: d.createdAt || new Date().toISOString(),
        updatedAt: d.updatedAt || new Date().toISOString(),
      });
    }
    return rows.length;
  }

  // Telegram API helpers
  async tgApi(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${this.deps.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  public async sendMessage(chatId: number, text: string, payLink?: string, replyMarkup?: any): Promise<void> {
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    } else if (payLink) {
      payload.reply_markup = {
        inline_keyboard: [[{ text: "💸 Pay Now", url: payLink }, { text: "✅ I've Paid", callback_data: "i_paid" }]],
      };
    }
    await this.tgApi("sendMessage", payload);
    // Merchant-facing transcript
    const s = this.sessions.get(chatId);
    if (s) {
      s.transcript.push({ dir: "out", text, payLink, at: new Date().toISOString() });
      s.updatedAt = new Date().toISOString();
    }
  }

  // Sessions
  private ensureSession(chatId: number, name?: string): TelegramSession {
    let s = this.sessions.get(chatId);
    if (!s) {
      s = {
        chatId,
        customerName: name || "Customer",
        amountInr: 0,
        declineCode: "",
        discountPercent: 0,
        optedOut: false,
        recovered: false,
        history: [],
        transcript: [],
        actions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.sessions.set(chatId, s);
    }
    return s;
  }

  // Update entry point (shared by polling AND future webhook mode)
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    // Inline button presses ("✅ I've Paid" on simulated links)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      if (chatId && cq.data === "i_paid") {
        const s = this.sessions.get(chatId);
        if (s?.paymentLink) {
          if (s.paymentLink.simulated) {
            await this.markPaid(s);
          } else {
            await this.sendMessage(chatId, "Verify kar rahi hoon… ek second 🙏");
            const paid = await this.refreshRealLinkStatus(s);
            if (!paid) await this.sendMessage(chatId, "Abhi payment dikha nahi raha — 1-2 minute me dobara try karein, ya /dues se status dekhein.");
          }
        }
      }
      await this.tgApi("answerCallbackQuery", { callback_query_id: cq.id });
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const s = this.ensureSession(msg.chat.id, msg.from?.first_name);

    // Phase: Contact verification
    if ((msg as any).contact && (msg as any).contact.phone_number) {
      // Normalize phone (strip non-digits)
      s.phone = (msg as any).contact.phone_number.replace(/\D/g, "");
      await this.persistSession(s);
      await this.sendMessage(msg.chat.id, "✅ Verified.", undefined, { remove_keyboard: true });
      return;
    }

    if (msg.text?.startsWith("/start") || !s.phone) {
      const keyboard = {
        keyboard: [[{ text: "📞 Verify My Account (Share Contact)", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      };
      await this.sendMessage(msg.chat.id, "Namaste! 🙏 Security ke liye, please apna account verify karein by sharing your contact number.", undefined, keyboard);
      return;
    }

    // Phase V1: inbound 🎤 voice note → Gemini transcription → intent pipeline
    const voiceMedia: any = (msg as any).voice || (msg as any).audio;
    if (!msg.text && voiceMedia) {
      await this.handleVoiceNote(msg.chat.id, msg.from?.first_name, voiceMedia);
      return;
    }
    if (!msg.text) return;
    if (msg.text.startsWith("/voice")) {
      s.voiceReplies = !s.voiceReplies;
      this.persistSession(s);
      await this.sendMessage(
        msg.chat.id,
        s.voiceReplies
          ? "🎙️ Voice replies ON — ab main kuch important jawab voice note me bhi bhejungi. (/voice se off karein)"
          : "💬 Voice replies OFF — sirf text me reply milega. (/voice se on karein)"
      );
      return;
    }
    if (msg.text.startsWith("/reset")) {
      this.sessions.delete(msg.chat.id);
      await this.sendMessage(msg.chat.id, "🔄 Session reset! /start se dobara shuru karein.");
      return;
    }
    if (msg.text.startsWith("/dues")) {
      await this.sendMessage(msg.chat.id, this.duesSummary(s));
      return;
    }
    await this.handleCustomerMessage(msg.chat.id, msg.from?.first_name, msg.text);
  }

  // Phase V1: Voice notes (inbound understanding + outbound replies)

  /** Inbound 🎤 voice note: download → Gemini transcribe → intent pipeline. */
  private async handleVoiceNote(chatId: number, firstName: string | undefined, voiceMedia: any): Promise<void> {
    const s = this.ensureSession(chatId, firstName);
    if (!this.deps.geminiApiKey) {
      await this.sendMessage(chatId, "🎤 Voice note mila! Par audio sunne ke liye abhi setup nahi hai (GEMINI_API_KEY missing). Text me likh dijiye 🙏");
      return;
    }
    await this.sendMessage(chatId, "🎙️ Aapka voice note sun rahi hoon…");
    try {
      const meta = await this.tgApi("getFile", { file_id: voiceMedia.file_id });
      const filePath = meta?.result?.file_path;
      if (!filePath) throw new Error("getFile returned no file_path");
      const dl = await fetch(`https://api.telegram.org/file/bot${this.deps.token}/${filePath}`);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      const audioBase64 = Buffer.from(await dl.arrayBuffer()).toString("base64");

      const u = await understandVoiceNote(audioBase64, voiceMedia.mime_type || "audio/ogg", this.deps.geminiApiKey);
      if (!u) throw new Error("transcription returned empty");

      // Transcript merchant-facing transcript me bhi jaye (mic badge)
      s.transcript.push({ dir: "in", text: `🎙️ ${u.transcript}`, at: new Date().toISOString() });
      this.deps.auditService.append("voice.note_received", {
        channel: "telegram", chatId,
        transcriptChars: u.transcript.length,
        intent: u.parse.intent,
      });
      await this.sendMessage(chatId, `🎙️ Suna ji: "${u.transcript}"`);

      // Transcript existing text pipeline se flow kare — promise/optout/discount
      // sab intents automatically handle hote hain.
      await this.handleCustomerMessage(chatId, firstName, u.transcript);
    } catch (err: any) {
      console.warn("[Telegram] voice note failed:", err?.message || err);
      await this.sendMessage(chatId, "Sorry ji, voice note samajh nahi aaya 😔 — thoda clear record karke dobara bhejein ya text me likhein.");
    }
  }

  /** Outbound 🎙️: agent reply ko Hinglish voice note me convert karke bhejo. */
  private async maybeSendVoiceNote(chatId: number, text: string): Promise<void> {
    try {
      const out = await synthesizeSpeech(text, this.deps.geminiApiKey);
      if (!out.audioBase64) return; // no key / TTS failed — text already sent
      const wav = Buffer.from(out.audioBase64, "base64");
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", "🎙️ Voice reply");
      form.append("audio", new Blob([wav], { type: "audio/wav" }), `reply_${Date.now()}.wav`);
      const res = await fetch(`https://api.telegram.org/bot${this.deps.token}/sendAudio`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`sendAudio ${res.status}: ${(await res.text()).slice(0, 120)}`);
      console.log(`[Telegram] 🎙️ Voice reply sent to ${chatId} (${Math.round(wav.length / 1024)}KB)`);
    } catch (err: any) {
      console.warn("[Telegram] voice reply skipped:", err?.message || err);
    }
  }

  /** Phase: Handle orchestrated webhook intervention (e.g. from policy engine) */
  async pushWebhookIntervention(params: { amountInr: number; declineCode?: string; paymentLink: string; customerContact?: string }): Promise<boolean> {
    if (!params.customerContact) return false;
    
    // STRICT ROUTING: normalize the incoming webhook contact
    const normalizedTarget = params.customerContact.replace(/\D/g, "");
    
    // Find a session with matching verified phone number
    const candidates = [...this.sessions.values()].filter((c) => !c.recovered && !c.optedOut && c.phone === normalizedTarget);
    if (candidates.length === 0) {
      console.warn(`[Telegram] No verified session found for phone ${normalizedTarget}`);
      return false;
    }
    const s = candidates[candidates.length - 1];

    s.amountInr = params.amountInr;
    s.declineCode = params.declineCode || "PAYMENT_FAILED";
    s.paymentLink = { linkId: "mock", shortUrl: params.paymentLink, simulated: true, amountInr: params.amountInr, status: "pending" };
    this.persistSession(s);

    const text = `Aapka ₹${params.amountInr} ka payment fail ho gaya tha (${s.declineCode}). Pay karne ke liye niche link par click karein:`;
    await this.sendMessage(s.chatId, text, params.paymentLink);
    return true;
  }

  /** Phase C1: beacon fired for an abandoned cart → open an ask-first
   *  conversational recovery in chat (never pushy, always ends in a question). */
  async pushAbandonedCart(cart: {
    items: Array<{ name: string; qty: number; price: number }>;
    totalInr: number;
    customerEmail?: string;
  }): Promise<boolean> {
    // Demo linkage: most recent active session (production would match email/phone)
    const candidates = [...this.sessions.values()].filter((c) => !c.recovered && !c.optedOut);
    if (candidates.length === 0) return false;
    const s = candidates[candidates.length - 1];

    s.abandonedCart = { items: cart.items, totalInr: cart.totalInr, droppedAt: new Date().toISOString() };
    s.amountInr = cart.totalInr;          // dues + payment link align with cart value
    s.declineCode = "CHECKOUT_ABANDONED";
    this.persistSession(s);

    const itemList = cart.items.map((i) => `${i.name} \u00d7${i.qty}`).join(", ");
    this.deps.auditService.append("cart.recovery_started", {
      channel: "telegram", chatId: s.chatId,
      items: cart.items.length, totalInr: cart.totalInr,
    });
    await this.sendMessage(
      s.chatId,
      `\u{1F44B} Namaste${s.customerName ? " " + s.customerName : ""} ji! Aapne apna cart \u20b9${cart.totalInr.toLocaleString("en-IN")} ka (${itemList}) beech me chhod diya tha. Koi problem aayi thi? Main help kar sakti hoon \u{1F60A}`
    );
    return true;
  }

  private duesSummary(s: TelegramSession): string {
    if (s.recovered) return "🎉 Aapka payment received ho gaya hai. Koi dues pending nahi hai!";
    if (s.optedOut) return "Aapke notifications band hain. Dues janne ke liye please opt-in karein.";
    if (!s.amountInr) return "✅ Aapka koi payment pending nahi hai.";
    return `📝 Name: ${s.customerName}\n💰 Dues: ₹${this.dueAmount(s)}\n⚠️ Reason: ${s.declineCode || "N/A"}`;
  }

  private dueAmount(s: TelegramSession): number {
    return Math.round(s.amountInr * (1 - s.discountPercent / 100));
  }

  // Core message handling
  private async handleCustomerMessage(chatId: number, firstName: string | undefined, text: string): Promise<void> {
    const s = this.ensureSession(chatId, firstName);
    s.transcript.push({ dir: "in", text, at: new Date().toISOString() });
    s.updatedAt = new Date().toISOString();

    // Two-step opt-out confirmation (DPDP consent flow)
    if (s.pendingOptOut) {
      s.transcript.push({ dir: "in", text, at: new Date().toISOString() });
      const t = text.toLowerCase();
      const yes = /\b(yes|haan|han|haa|confirm|kar do|kardo|band kar do|ok|okay|sure)\b/.test(t);
      const no = /\b(no|nahi|nahin|cancel|rakho|rakhna|mat)\b/.test(t);
      if (yes) {
        s.pendingOptOut = false;
        await this.executeTool("opt_out_customer", { confirmed: true }, s);
        await this.sendMessage(chatId, "✅ Confirm ho gaya ji. Aapko ab koi message nahi aayega — aapke din shubh ho! 🙏 (DPDP compliant)");
      } else if (no) {
        s.pendingOptOut = false;
        await this.sendMessage(chatId, "Theek hai ji! Main aapko payment reminders bhejti rahungi 😊 Kuch aur help chahiye?");
      } else {
        await this.sendMessage(chatId, "Confirm karne ke liye 'YES' likhein, ya reminders continue rakhne ke liye 'NO' likhein 🙏");
      }
      return;
    }

    if (s.optedOut) {
      await this.sendMessage(chatId, "Aapki request par saare reminders band kar diye gaye hain. 🙏 (DPDP compliant)");
      return;
    }
    if (s.recovered) {
      await this.sendMessage(chatId, "🎉 Aapka payment already receive ho gaya hai — dhanyavaad! Kuch pending nahi hai.");
      return;
    }

    try {
      if (this.deps.geminiApiKey) {
        await this.geminiReply(s, text);
      } else {
        await this.fallbackReply(s, text);
      }
    } catch (err: any) {
      console.warn("[Telegram] reply failed:", err?.message);
      await this.fallbackReply(s, text);
    } finally {
      void this.persistSession(s);
    }
  }

  /** Durable snapshot → Postgres (restart-survival). */
  private async persistSession(s: TelegramSession): Promise<void> {
    const snap = (this.getSessionsForMerchant().find((x) => x.chatId === s.chatId)) as Record<string, unknown> | undefined;
    if (!snap) return;
    await dbSaveTelegramSession(s.chatId, { ...snap, history: s.history });
  }

  // Guardrailed tools (the ONLY actions Gemini can take)
  private async executeTool(name: string, args: any, s: TelegramSession): Promise<Record<string, unknown>> {
    this.deps.auditService.append("agent_chat.tool_call", { chatId: s.chatId, tool: name, args });
    const result = await this.executeToolInner(name, args, s);
    const detail =
      name === "create_payment_link" ? `Payment link created (₹${(result as any).amount_inr ?? this.dueAmount(s)})`
      : name === "record_promise" ? `Promise recorded for ${(result as any).promised_date || args?.date}`
      : name === "set_discount" ? `Discount ${args?.percent}% applied → ₹${(result as any).new_amount_inr}`
      : name === "opt_out_customer" ? "DPDP opt-out — all contact stopped"
      : name === "get_customer_dues" ? "Checked customer dues"
      : name;
    s.actions.push({ tool: name, detail: (result as any).error ? `${name} rejected: ${(result as any).error}` : detail, at: new Date().toISOString() });
    if ((result as any).error) {
      // Guardrail veto is merchant-visible
      this.deps.auditService.append("agent_chat.tool_vetoed", { chatId: s.chatId, tool: name, error: (result as any).error });
    }
    return result;
  }

  private async executeToolInner(name: string, args: any, s: TelegramSession): Promise<Record<string, unknown>> {
    switch (name) {
      case "get_customer_dues":
        return {
          customer_name: s.customerName,
          amount_due_inr: this.dueAmount(s),
          original_amount_inr: s.amountInr,
          decline_reason: s.declineCode,
          discount_applied_percent: s.discountPercent,
          max_discount_allowed_percent: MAX_DISCOUNT_PERCENT,
          promised_date: s.promisedDate || null,
          status: s.recovered ? "paid" : "pending",
        };

      case "create_payment_link": {
        if (s.paymentLink && !s.recovered) {
          return { short_url: s.paymentLink.shortUrl, simulated: s.paymentLink.simulated, note: "Existing link re-sent" };
        }
        const link = await createRecoveryPaymentLink(this.deps.razorpayClient, {
          amountInr: this.dueAmount(s),
          customerName: s.customerName,
          customerEmail: `${s.customerName.toLowerCase().replace(/\s+/g, ".")}@telegram.demo`,
          customerContact: `+91${String(s.chatId).slice(-10)}`,
          description: `RazorVasooli Telegram recovery — ${s.customerName}`,
          notes: { channel: "telegram" },
        });
        s.paymentLink = { linkId: link.linkId, shortUrl: link.shortUrl, amountInr: this.dueAmount(s), simulated: link.simulated, status: "pending" };
        return { short_url: link.shortUrl, simulated: link.simulated, amount_inr: this.dueAmount(s) };
      }

      case "record_promise": {
        const date = String(args?.date || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "date must be YYYY-MM-DD" };
        s.promisedDate = date;
        this.deps.auditService.append("promise.recorded", { channel: "telegram", chatId: s.chatId, promisedDate: date });
        return { recorded: true, promised_date: date };
      }

      case "set_discount": {
        const pct = Math.round(Number(args?.percent ?? 0));
        if (!Number.isFinite(pct) || pct < 0 || pct > MAX_DISCOUNT_PERCENT) {
          return { error: `Discount must be 0–${MAX_DISCOUNT_PERCENT}% (hard cap)` };
        }
        s.discountPercent = pct;
        return { applied_percent: pct, new_amount_inr: this.dueAmount(s) };
      }

      case "opt_out_customer": {
        // Two-step consent: never opt out without explicit confirmation
        if (!args?.confirmed) {
          s.pendingOptOut = true;
          return {
            needs_confirmation: true,
            message: "Ask the customer to reply YES to confirm stopping all messages (or NO to continue).",
          };
        }
        s.optedOut = true;
        s.pendingOptOut = false;
        this.deps.auditService.append("dpdp.optout.telegram", { chatId: s.chatId });
        return { opted_out: true };
      }

      case "get_cart_details": {
        if (!s.abandonedCart) return { error: "No abandoned cart on this session." };
        return {
          items: s.abandonedCart.items.map((i) => `${i.name} x${i.qty} @ ₹${i.price}`),
          total_inr: s.abandonedCart.totalInr,
          dropped_at: s.abandonedCart.droppedAt,
        };
      }

      case "toggle_voice_replies": {
        // Phase V1: customer asked in natural language for voice/audio replies
        s.voiceReplies = !!args?.enabled;
        this.persistSession(s);
        this.deps.auditService.append("voice.replies_toggled", {
          channel: "telegram", chatId: s.chatId,
          enabled: s.voiceReplies, via: "agent",
        });
        return {
          voice_replies: s.voiceReplies,
          message: s.voiceReplies
            ? "Voice replies enabled — important answers will also arrive as voice notes."
            : "Voice replies disabled — replies will be text-only.",
        };
      }

      default:
        return { error: `Unknown tool ${name}` };
    }
  }

  // Gemini agent loop (function calling)
  private static TOOL_DECLS = [
    {
      name: "get_customer_dues",
      description: "Get the customer's pending dues: amount, decline reason, discounts, promise status.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "create_payment_link",
      description: "Create a Razorpay payment link for the current due amount. It is delivered to the customer as a Pay Now button automatically.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "get_cart_details",
      description: "Get the items and value of the cart the customer abandoned (available when they walked away mid-checkout).",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "record_promise",
      description: "Record the customer's payment promise for a date (YYYY-MM-DD). Pauses reminders until then.",
      parameters: { type: "OBJECT", properties: { date: { type: "STRING", description: "YYYY-MM-DD" } }, required: ["date"] },
    },
    {
      name: "set_discount",
      description: `Apply loyalty discount percent (0-${MAX_DISCOUNT_PERCENT} max, hard cap).`,
      parameters: { type: "OBJECT", properties: { percent: { type: "NUMBER" } }, required: ["percent"] },
    },
    {
      name: "opt_out_customer",
      description: "Customer explicitly refuses all contact — permanently stop messaging (DPDP compliance).",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "toggle_voice_replies",
      description: "Enable or disable voice-note replies when the customer asks to be responded to in audio/voice (e.g. 'voice me batao', 'audio me sunao', 'bol ke batao'). Confirm back in text after toggling.",
      parameters: {
        type: "OBJECT",
        properties: {
          enabled: { type: "BOOLEAN", description: "true = send voice-note replies, false = text-only" },
        },
        required: ["enabled"],
      },
    },
  ];

  private async geminiReply(s: TelegramSession, userText: string): Promise<void> {
    const apiKey = this.deps.geminiApiKey!;
    s.history.push({ role: "user", parts: [{ text: userText }] });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    let payLinkSent = false;

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: s.history.slice(-20),
          tools: [{ functionDeclarations: TelegramAgent.TOOL_DECLS }],
        }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      const parts: any[] = data.candidates?.[0]?.content?.parts || [];

      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const textOut = parts.filter((p) => p.text).map((p) => p.text).join("\n").trim();

      if (calls.length === 0) {
        s.history.push({ role: "model", parts: [{ text: textOut || "…" }] });
        if (textOut || (s.paymentLink && !payLinkSent)) {
          await this.sendMessage(s.chatId, textOut || "Yeh lijiye payment link ji 👇", !payLinkSent ? s.paymentLink?.shortUrl : undefined);
          // Phase V1: voice-replies ON ho to final answer ka audio bhi bhejo
          if (s.voiceReplies && textOut && !s.recovered) {
            await this.maybeSendVoiceNote(s.chatId, textOut);
          }
        }
        return;
      }

      // Execute tools, feed results back to Gemini
      s.history.push({ role: "model", parts });
      const responseParts: Record<string, unknown>[] = [];
      for (const call of calls) {
        const result = await this.executeTool(call.name, call.args || {}, s);
        responseParts.push({ functionResponse: { name: call.name, response: result } });
      }
      s.history.push({ role: "user", parts: responseParts });
    }
  }

  // Deterministic fallback (no GEMINI_API_KEY)
  private async fallbackReply(s: TelegramSession, text: string): Promise<void> {
    const intent = parseHinglishReply(text);

    switch (intent.intent) {
      case "optout": {
        // Two-step consent: ask before stopping (DPDP consent flow)
        s.pendingOptOut = true;
        await this.sendMessage(
          s.chatId,
          "Ek confirmation chahiye ji 🙏 Kya aap waqai SAARE payment reminders band karna chahte hain?\n\n'YES' likhein confirm karne ke liye, ya 'NO' likhein agar reminders continue rakhne hain."
        );
        return;
      }
      case "promise": {
        const date = intent.promisedDate || new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
        await this.executeTool("record_promise", { date }, s);
        await this.sendMessage(s.chatId, `Done ji! 📌 Maine aapka promise ${date} ke liye note kar liya. Us din reminder bhejungi. Tab tak service active rahegi 😊`);
        return;
      }
      case "discount_request": {
        if (!s.paymentLink) {
          const capped = Math.min(MAX_DISCOUNT_PERCENT, 10);
          await this.executeTool("set_discount", { percent: capped }, s);
          await this.executeTool("create_payment_link", {}, s);
        }
        await this.sendMessage(
          s.chatId,
          `Ji bilkul! 🎁 Humne ${Math.min(MAX_DISCOUNT_PERCENT, 10)}% loyalty discount apply kar diya hai — naya amount sirf ₹${this.dueAmount(s).toLocaleString("en-IN")} hai.`,
          s.paymentLink?.shortUrl
        );
        return;
      }
      case "paid": {
        if (s.paymentLink?.simulated) {
          await this.markPaid(s);
          return;
        }
        const paid = s.paymentLink ? await this.refreshRealLinkStatus(s) : false;
        await this.sendMessage(
          s.chatId,
          paid ? "🎉 Confirm! Payment receive ho gaya hai — dhanyavaad ji!" : "Ek second… abhi payment dikha nahi raha. Agar aapne pay kiya hai to 5-10 minute me reflect ho jayega. 🙏"
        );
        return;
      }
      default: {
        if (!s.paymentLink) {
          const link = await createRecoveryPaymentLink(this.deps.razorpayClient, {
            amountInr: this.dueAmount(s),
            customerName: s.customerName,
            description: "RazorVasooli Telegram recovery",
          });
          s.paymentLink = { linkId: link.linkId, shortUrl: link.shortUrl, amountInr: this.dueAmount(s), simulated: link.simulated, status: "pending" };
        }
        await this.sendMessage(
          s.chatId,
          `Koi baat nahi ji, samajh sakti hoon 🙏 Aapka ₹${this.dueAmount(s).toLocaleString("en-IN")} pending hai ` +
            `(${s.declineCode === "INSUFFICIENT_FUNDS" ? "balance issue" : "payment failure"} ki wajah se). ` +
            `Jab comfortable ho, niche diye secure link se ek minute me pay kar sakte hain 👇 Ya bataiye kab tak kar payenge?`,
          s.paymentLink.shortUrl
        );
      }
    }
  }

  // Payment detection
  private async refreshRealLinkStatus(s: TelegramSession): Promise<boolean> {
    if (!s.paymentLink || s.paymentLink.simulated || !this.deps.razorpayClient) return false;
    try {
      const link = await (this.deps.razorpayClient as any).paymentLink.fetch(s.paymentLink.linkId);
      if (link?.status === "paid") {
        await this.markPaid(s);
        return true;
      }
    } catch (err: any) {
      console.warn("[Telegram] link status check failed:", err?.message);
    }
    return false;
  }

  private async markPaid(s: TelegramSession): Promise<void> {
    if (s.recovered) return;
    s.recovered = true;
    if (s.paymentLink) s.paymentLink.status = "paid";
    s.transcript.push({ dir: "system", text: `✅ PAYMENT RECEIVED — ₹${(s.paymentLink?.amountInr ?? this.dueAmount(s)).toLocaleString("en-IN")}`, at: new Date().toISOString() });
    this.deps.auditService.append("recovery.recorded", {
      channel: "telegram",
      chatId: s.chatId,
      customerName: s.customerName,
      amountInr: s.paymentLink?.amountInr ?? this.dueAmount(s),
      simulated: s.paymentLink?.simulated ?? true,
      linkId: s.paymentLink?.linkId,
    });
    await this.sendMessage(
      s.chatId,
      `🎉 Payment received ji — ₹${(s.paymentLink?.amountInr ?? this.dueAmount(s)).toLocaleString("en-IN")}!\n\nDhanyavaad! Aapka account clear hai ✅ (/reset se demo dobara shuru karein)`
    );
  }

  /** Watchdog for REAL Razorpay links — per-session exponential backoff.
   *  Phase H2: this is only a fallback for missed payment_link.paid webhooks;
   *  each pending link is checked at 5s → 30s → 2m → 10m (cap), and never
   *  once recovered or paid. */
  private async checkPendingLinks(): Promise<void> {
    const now = Date.now();
    const delaysMs = [5000, 30000, 120000, 600000];
    for (const s of this.sessions.values()) {
      if (!s.paymentLink || s.paymentLink.simulated || s.recovered || s.paymentLink.status !== "pending") continue;
      const attempts = s.paymentLink.checkAttempts ?? 0;
      const delay = delaysMs[Math.min(attempts, delaysMs.length - 1)];
      if (s.paymentLink.nextCheckAt && Date.parse(s.paymentLink.nextCheckAt) > now) continue; // not due yet
      s.paymentLink.checkAttempts = attempts + 1;
      s.paymentLink.nextCheckAt = new Date(now + delay).toISOString();
      await this.refreshRealLinkStatus(s);
    }
  }

  /**
   * Phase H2: PRIMARY payment detection path — invoked when Razorpay delivers
   * a verified `payment_link.paid` webhook. Matches the session by link id and
   * marks it paid instantly (no polling). Returns true when a session matched.
   */
  async handlePaymentLinkPaid(linkId: string): Promise<boolean> {
    for (const s of this.sessions.values()) {
      if (s.paymentLink?.linkId === linkId && !s.recovered) {
        s.paymentLink.status = "paid";
        await this.markPaid(s);
        console.log(`[Telegram] ✅ payment_link.paid webhook → session ${s.chatId} marked recovered`);
        return true;
      }
    }
    console.warn(`[Telegram] payment_link.paid webhook for unknown link ${linkId} — no matching session`);
    return false;
  }
  /** Merchant dashboard feed — sanitized session summaries with transcripts. */
  getSessionsForMerchant(): Array<{
    chatId: number;
    customerName: string;
    amountDueInr: number;
    discountPercent: number;
    declineCode: string;
    promisedDate?: string;
    optedOut: boolean;
    recovered: boolean;
    paymentLink?: { shortUrl: string; simulated: boolean; status: string };
    transcript: TranscriptEntry[];
    actions: ActionEntry[];
    createdAt: string;
    updatedAt: string;
  }> {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        chatId: s.chatId,
        customerName: s.customerName,
        phone: s.phone,
        amountDueInr: this.dueAmount(s),
        discountPercent: s.discountPercent,
        declineCode: s.declineCode,
        promisedDate: s.promisedDate,
        optedOut: s.optedOut,
        recovered: s.recovered,
        paymentLink: s.paymentLink
          ? { shortUrl: s.paymentLink.shortUrl, simulated: s.paymentLink.simulated, status: s.paymentLink.status }
          : undefined,
        transcript: s.transcript.slice(-100),
        actions: s.actions.slice(-50),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
  }
}

// Demo sessions (shown in merchant dashboard when bot has no live traffic)

export function buildDemoSessions(): Array<ReturnType<TelegramAgent["getSessionsForMerchant"]>[number]> {
  const now = Date.now();
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60000).toISOString();
  return [
    {
      chatId: 552001,
      customerName: "Priya Sharma",
      amountDueInr: 2374,
      discountPercent: 5,
      declineCode: "INSUFFICIENT_FUNDS",
      promisedDate: new Date(now + 5 * 864e5).toISOString().slice(0, 10),
      optedOut: false,
      recovered: false,
      paymentLink: { shortUrl: "https://rzp.io/i/demo-priya", simulated: true, status: "pending" },
      transcript: [
        { dir: "out", text: "Namaste Priya ji! 🙏 Main RazorVasooli AI hoon. Aapka ₹2,499 ka payment fail hua tha (balance issue). Kya main help kar sakti hoon?", at: iso(42) },
        { dir: "in", text: "arre yaar paise nahi hai abhi 😅", at: iso(40) },
        { dir: "out", text: "Koi baat nahi ji, samajh sakti hoon! Salary kab aa rahi hai? Tab tak main reminder set kar dungi 😊", at: iso(39) },
        { dir: "in", text: "5 tarikh ko aayegi salary, tab pakka de dungi", at: iso(38) },
        { dir: "out", text: "Done ji! 📌 Promise note ho gaya — 5 tarikh. Aur dekhiye, aapke liye 5% loyalty discount bhi lagaya hai, naya amount sirf ₹2,374. Link niche hai 👇", payLink: "https://rzp.io/i/demo-priya", at: iso(37) },
        { dir: "in", text: "ok thank you! 🙏", at: iso(36) },
      ],
      actions: [
        { tool: "get_customer_dues", detail: "Checked customer dues", at: iso(41) },
        { tool: "record_promise", detail: "Promise recorded (5 tarikh)", at: iso(38) },
        { tool: "set_discount", detail: "Discount 5% applied → ₹2,374", at: iso(37) },
        { tool: "create_payment_link", detail: "Payment link created (₹2,374)", at: iso(37) },
      ],
      createdAt: iso(43),
      updatedAt: iso(36),
    },
    {
      chatId: 617340,
      customerName: "Rohit Verma",
      amountDueInr: 1899,
      discountPercent: 0,
      declineCode: "CARD_EXPIRED",
      optedOut: false,
      recovered: false,
      paymentLink: { shortUrl: "https://rzp.io/i/demo-rohit", simulated: true, status: "pending" },
      transcript: [
        { dir: "out", text: "Hello Rohit ji! Lagta hai aapka card expire ho gaya hai 💳. Subscription uninterrupted rakhne ke liye instant UPI link bhej deti hoon?", at: iso(120) },
        { dir: "in", text: "haan bhejo", at: iso(118) },
        { dir: "out", text: "Yeh lijiye ji 👇 UPI se 1 minute me ho jayega!", payLink: "https://rzp.io/i/demo-rohit", at: iso(117) },
      ],
      actions: [
        { tool: "get_customer_dues", detail: "Checked customer dues", at: iso(121) },
        { tool: "create_payment_link", detail: "Payment link created (₹1,899)", at: iso(117) },
      ],
      createdAt: iso(122),
      updatedAt: iso(117),
    },
    {
      chatId: 704115,
      customerName: "Meera Iyer",
      amountDueInr: 999,
      discountPercent: 0,
      declineCode: "BANK_DECLINED",
      optedOut: true,
      recovered: false,
      transcript: [
        { dir: "out", text: "Namaste Meera ji! Aapka ₹999 ka payment pending hai. Help kar sakti hoon?", at: iso(300) },
        { dir: "in", text: "abhi pareshaan mat karo, message band karo", at: iso(298) },
        { dir: "out", text: "Ek confirmation chahiye ji 🙏 Kya aap waqai SAARE payment reminders band karna chahte hain? 'YES' ya 'NO' likhein.", at: iso(297) },
        { dir: "in", text: "haan band kar do", at: iso(296) },
        { dir: "system", text: "🛑 DPDP opt-out confirmed — all contact stopped permanently", at: iso(295) },
      ],
      actions: [
        { tool: "opt_out_customer", detail: "Opt-out confirmed by customer — all contact stopped", at: iso(295) },
      ],
      createdAt: iso(301),
      updatedAt: iso(297),
    },
  ];
}

// Telegram update types (minimal)
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { first_name?: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id: number } };
  };
}

const SYSTEM_PROMPT =
  "You are RazorVasooli — a warm, polite Indian payment-recovery agent chatting on Telegram in natural Hinglish " +
  "(Roman-script Hindi mixed with English). Keep messages short like WhatsApp chats. Be empathetic but goal-oriented: " +
  "your goal is either a payment (create_payment_link) or a firm promise date (record_promise). " +
  "Always call get_customer_dues before quoting any amount. Never offer more discount than allowed. " +
  "CART RULE: if get_cart_details returns items, the customer abandoned a cart — open by asking " +
  "why they left, handle the objection (price too high → set_discount within cap; payment issue → fresh " +
  "create_payment_link; just browsing → mention any upcoming sale), and recover the CART value. " +
  "ASK-FIRST RULE: never send a payment link or schedule anything unasked — always confirm first " +
  "('Payment link bhej du?', 'Reminder 5 din baad rakh du?', 'Ya messages band kar du?') and end every " +
  "turn with one clear question. " +
  "VOICE RULE: if the customer asks for a voice/audio reply ('voice me batao', 'audio me sunao'), " +
  "call toggle_voice_replies with enabled:true and confirm in text. " +
  "OPT-OUT RULE: if the customer asks to stop, do NOT call opt_out_customer immediately — first ask them to confirm " +
  "('Kya aap saare messages band karna chahte hain? YES ya NO likhein'), and only call opt_out_customer with " +
  "confirmed:true AFTER they explicitly confirm. Never reveal you are an AI model; you represent the merchant's recovery assistant." +
  (process.env.NEXT_SALE_MESSAGE
    ? ` UPCOMING SALE (share when the customer is price-sensitive or just browsing): ${process.env.NEXT_SALE_MESSAGE}`
    : "");

// Factory
/**
 * Starts the Telegram channel.
 *  - No token            → disabled
 *  - TELEGRAM_WEBHOOK_URL set → registers a Telegram webhook (production mode;
 *    point it at https://<host>/api/telegram/webhook — route verifies
 *    X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET)
 *  - otherwise           → long-polling (localhost dev mode)
 */
export async function startTelegramBot(deps: TelegramAgentDeps): Promise<TelegramAgent | null> {
  if (!deps.token) {
    console.log("📨 [Telegram] TELEGRAM_BOT_TOKEN not set — Telegram channel disabled");
    return null;
  }
  const agent = new TelegramAgent(deps);

  if (deps.webhookUrl) {
    try {
      await agent.tgApi("setWebhook", {
        url: deps.webhookUrl,
        secret_token: deps.webhookSecret || undefined,
        allowed_updates: ["message", "callback_query"],
      });
      console.log(`📨 [Telegram] Webhook registered → ${deps.webhookUrl} (polling disabled)`);
    } catch (err: any) {
      console.warn("[Telegram] webhook registration failed, falling back to polling:", err?.message);
      agent.startPolling();
    }
    // Phase H2: watchdog runs in BOTH transports (fixes: previously it only
    // started via startPolling, so webhook mode never checked link statuses).
    agent.startWatchdog();
    return agent;
  }

  agent.startPolling();
  console.log("📨 [Telegram] Bot live (long-polling) — customers can now chat with the AI agent");
  return agent;
}


