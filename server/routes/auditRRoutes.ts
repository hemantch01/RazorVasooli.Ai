// AUTO-GENERATED (Pass 2) — auditR routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { getOutbox, type OutboxChannel } from "../services/channels.js";

export function registerAuditrRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { auditService } = ctx;

app.get("/api/audit/verify", (_req: Request, res: Response) => {
  return res.status(200).json(auditService.verifyChain());
});

app.get("/api/audit/entries", (req: Request, res: Response) => {
  const eventType = req.query.eventType as string | undefined;
  const limit = parseInt(req.query.limit as string || "100", 10);

  const entries = auditService.getEntries({
    eventType,
    limit: Math.min(limit, 500),
  });

  return res.status(200).json({
    count: entries.length,
    entries,
  });
});

app.get("/api/audit/stats", (_req: Request, res: Response) => {
  return res.status(200).json(auditService.getStats());
});

app.get("/api/outbox", (req: Request, res: Response) => {
  const channel = req.query.channel as OutboxChannel | undefined;
  const limit = parseInt(req.query.limit as string || "50", 10);

  const messages = getOutbox({ channel, limit: Math.min(limit, 200) });

  return res.status(200).json({
    count: messages.length,
    messages,
  });
});

}
