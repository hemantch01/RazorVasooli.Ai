// AUTO-GENERATED (Pass 2) — ingestion routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";


import type { CheckoutBeacon, RiskEventType, RiskEvent } from "../services/ingestion.js";
import { classifyRiskSeverity } from "../services/ingestion.js";

export function registerIngestionRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { deduplicator, riskEventBus, pollerState, startPoller, pollInvoices } = ctx;

app.post("/api/ingestion/beacon", async (req: Request, res: Response) => {
  const beacon: CheckoutBeacon = req.body;

  // Validate required fields
  if (!beacon.sessionId || !beacon.event) {
    return res.status(400).json({ error: "sessionId and event are required" });
  }

  // Map beacon events to risk events
  let riskEventType: RiskEventType | null = null;
  if (beacon.event === "page_abandoned" || beacon.event === "session_timeout") {
    riskEventType = "checkout.abandoned";
  } else if (beacon.event === "payment_failed_client") {
    riskEventType = "checkout.payment_page_dropout";
  }

  if (riskEventType) {
    const beaconEventId = `beacon_${beacon.sessionId}_${beacon.event}`;

    if (!deduplicator.isDuplicate(beaconEventId)) {
      const riskEvent: RiskEvent = {
        id: beaconEventId,
        type: riskEventType,
        severity: classifyRiskSeverity(riskEventType, beacon.amount),
        source: "beacon",
        payload: {
          sessionId: beacon.sessionId,
          lastStage: beacon.event,
          paymentMethod: beacon.paymentMethod,
          errorMessage: beacon.errorMessage,
          ...beacon.metadata,
        },
        customerEmail: beacon.customerEmail,
        amount: beacon.amount,
        currency: beacon.currency || "INR",
        receivedAt: beacon.timestamp || new Date().toISOString(),
        deduplicated: false,
      };

      await riskEventBus.publish(riskEvent);
    }
  }

  return res.status(200).json({
    status: "accepted",
    sessionId: beacon.sessionId,
    event: beacon.event,
  });
});

app.post("/api/ingestion/poller/start", (_req: Request, res: Response) => {
  startPoller();
  return res.status(200).json({ status: "started", config: pollerState.config });
});

app.post("/api/ingestion/poller/stop", (_req: Request, res: Response) => {
  if (pollerState.interval) { clearInterval(pollerState.interval); pollerState.interval = null; }
  return res.status(200).json({ status: "stopped" });
});

app.post("/api/ingestion/poller/poll-now", async (_req: Request, res: Response) => {
  const result = await pollInvoices();
  return res.status(200).json({ status: "polled", ...result });
});

app.get("/api/ingestion/poller/status", (_req: Request, res: Response) => {
  return res.status(200).json({
    running: pollerState.interval !== null,
    config: pollerState.config,
    lastPollAt: pollerState.lastPoll,
    totalPolls: pollerState.count,
  });
});

app.put("/api/ingestion/poller/config", (req: Request, res: Response) => {
  const { intervalMs, enabled, overdueThresholdHours, maxInvoicesToPoll } = req.body;

  if (intervalMs !== undefined) pollerState.config.intervalMs = Math.max(10000, intervalMs); // min 10s
  if (enabled !== undefined) pollerState.config.enabled = enabled;
  if (overdueThresholdHours !== undefined) pollerState.config.overdueThresholdHours = Math.max(1, overdueThresholdHours);
  if (maxInvoicesToPoll !== undefined) pollerState.config.maxInvoicesToPoll = Math.max(1, Math.min(100, maxInvoicesToPoll));

  // Restart poller if running with new interval
  if (pollerState.interval) {
    if (pollerState.interval) { clearInterval(pollerState.interval); pollerState.interval = null; }
    startPoller();
  }

  return res.status(200).json({ status: "updated", config: pollerState.config });
});

app.get("/api/ingestion/risk-events", (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  const severity = req.query.severity as string | undefined;
  const source = req.query.source as string | undefined;
  const limit = parseInt(req.query.limit as string || "50", 10);

  const events = riskEventBus.getEvents({
    type: type as any,
    severity: severity as any,
    source: source as any,
    limit: Math.min(limit, 200),
  });

  return res.status(200).json({
    count: events.length,
    events,
  });
});

app.get("/api/ingestion/risk-events/stats", (_req: Request, res: Response) => {
  return res.status(200).json({
    stats: riskEventBus.getStats(),
    deduplicator: {
      trackedEventIds: deduplicator.size,
    },
    poller: {
      running: pollerState.interval !== null,
      totalPolls: pollerState.count,
      lastPollAt: pollerState.lastPoll,
    },
  });
});

}
