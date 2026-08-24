import express, { type Request, type Response } from "express";
import { imapEnabled, pollInbox } from "../services/mailbox.js";
import { getMailConversations } from "../services/mailbox.js";
import type { AuditService } from "../services/audit.js";
import type Razorpay from "razorpay";

export function emailRoutes(deps: {
  razorpayClient: Razorpay | null;
  auditService: AuditService;
}): express.Router {
  const r = express.Router();

  r.get("/conversations", (_req: Request, res: Response) => {
    res.json({
      imapEnabled: imapEnabled(),
      smtpEnabled: !!process.env.SMTP_HOST,
      conversations: getMailConversations(),
    });
  });

  r.post("/check-now", async (_req: Request, res: Response) => {
    if (!imapEnabled()) return res.status(400).json({ error: "IMAP not configured (set IMAP_* env)" });
    const processed = await pollInbox({ razorpayClient: deps.razorpayClient, auditService: deps.auditService, geminiApiKey: process.env.GEMINI_API_KEY });
    res.json({ success: true, processed });
  });

  return r;
}
