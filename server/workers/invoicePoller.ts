import type { RiskEventBus, EventDeduplicator, InvoicePollerConfig, RiskEvent } from "../services/ingestion.js";
import { classifyRiskSeverity, DEFAULT_POLLER_CONFIG } from "../services/ingestion.js";
import type Razorpay from "razorpay";

export const pollerState: {
  config: InvoicePollerConfig;
  interval: ReturnType<typeof setInterval> | null;
  lastPoll: string | null;
  count: number;
} = { config: { ...DEFAULT_POLLER_CONFIG }, interval: null, lastPoll: null, count: 0 };

export async function pollInvoices(
  razorpayClient: Razorpay | null,
  deduplicator: EventDeduplicator,
  riskEventBus: RiskEventBus,
  trackedInvoices: any[]
): Promise<{ polled: number; risksFound: number }> {
  pollerState.count++;
  pollerState.lastPoll = new Date().toISOString();
  let risksFound = 0;

  console.log(`[InvoicePoller] Poll #${pollerState.count} at ${pollerState.lastPoll}`);

  try {
    if (razorpayClient) {
      try {
        const invoices = await (razorpayClient as any).invoices.all({
          count: pollerState.config.maxInvoicesToPoll,
        });

        for (const inv of invoices.items || []) {
          if (inv.status === "expired" || inv.status === "cancelled") {
            const pollEventId = `poll_${inv.id}_${inv.status}`;
            if (!deduplicator.isDuplicate(pollEventId)) {
              const riskEvent: RiskEvent = {
                id: pollEventId,
                type: "invoice.poll.missed",
                severity: classifyRiskSeverity("invoice.poll.missed", inv.amount ? inv.amount / 100 : undefined),
                source: "poller",
                payload: inv,
                customerEmail: inv.customer_details?.email,
                amount: inv.amount ? inv.amount / 100 : undefined,
                currency: inv.currency || "INR",
                invoiceId: inv.id,
                receivedAt: new Date().toISOString(),
                deduplicated: false,
              };
              await riskEventBus.publish(riskEvent);
              risksFound++;
            }
          }
        }
      } catch (apiErr: any) {
        console.warn("[InvoicePoller] Razorpay API error (test keys may not support invoice listing):", apiErr?.message);
      }
    }

    const now = Date.now();
    const overdueThreshold = pollerState.config.overdueThresholdHours * 3600000;

    for (const inv of trackedInvoices) {
      if (inv.status === "pending" || inv.status === "failed") {
        const failedAge = now - new Date(inv.failedAt).getTime();
        if (failedAge > overdueThreshold) {
          const pollEventId = `poll_${inv.id}_overdue`;
          if (!deduplicator.isDuplicate(pollEventId)) {
            const riskEvent: RiskEvent = {
              id: pollEventId,
              type: "invoice.poll.overdue",
              severity: classifyRiskSeverity("invoice.poll.overdue", inv.amount),
              source: "poller",
              payload: { invoice: inv, overdueHours: Math.round(failedAge / 3600000) },
              customerEmail: inv.customerEmail,
              amount: inv.amount,
              currency: inv.currency || "INR",
              invoiceId: inv.id,
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            };
            await riskEventBus.publish(riskEvent);
            risksFound++;
          }
        }
      }
    }
  } catch (err) {
    console.error("[InvoicePoller] Error during poll:", err);
  }

  console.log(`[InvoicePoller] Poll #${pollerState.count} complete — ${risksFound} new risks found`);
  return { polled: pollerState.count, risksFound };
}

export function startPoller(
  razorpayClient: Razorpay | null,
  deduplicator: EventDeduplicator,
  riskEventBus: RiskEventBus,
  trackedInvoices: any[]
): void {
  if (pollerState.interval) return;
  if (!pollerState.config.enabled) {
    console.log("[InvoicePoller] Poller is disabled");
    return;
  }

  console.log(`[InvoicePoller] Starting — interval=${pollerState.config.intervalMs}ms, overdueThreshold=${pollerState.config.overdueThresholdHours}h`);
  pollInvoices(razorpayClient, deduplicator, riskEventBus, trackedInvoices); // Run immediately on start
  pollerState.interval = setInterval(
    () => pollInvoices(razorpayClient, deduplicator, riskEventBus, trackedInvoices),
    pollerState.config.intervalMs
  );
}
