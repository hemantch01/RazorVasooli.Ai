import express, { type Request, type Response } from "express";
import { buildDemoSessions, type TelegramAgent } from "../services/telegram.js";

let agent: TelegramAgent | null = null;
export function setTelegramAgent(a: TelegramAgent | null): void {
  agent = a;
}

export function telegramRoutes(): express.Router {
  const r = express.Router();

  r.get("/status", (_req: Request, res: Response) => {
    res.json({
      enabled: !!agent,
      mode: agent ? (agent.deps.webhookUrl ? "webhook" : "polling") : "disabled",
      hint: agent
        ? "Bot is live — customers can chat with the AI agent on Telegram."
        : "Set TELEGRAM_BOT_TOKEN in .env (from @BotFather) and restart the server.",
    });
  });

  r.get("/sessions", (_req: Request, res: Response) => {
    const real = agent?.getSessionsForMerchant() || [];
    if (real.length > 0) {
      return res.json({ enabled: !!agent, demo: false, sessions: real });
    }
    return res.json({ enabled: !!agent, demo: true, sessions: buildDemoSessions() });
  });

  r.post("/webhook", (req: Request, res: Response) => {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected && req.headers["x-telegram-bot-api-secret-token"] !== expected) {
      return res.status(401).json({ error: "Invalid webhook secret token" });
    }
    if (!agent) return res.status(503).json({ error: "Telegram channel disabled" });
    void agent.handleUpdate(req.body);
    res.json({ ok: true });
  });

  return r;
}
