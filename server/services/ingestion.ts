/**
 * RazorVasooli.Ai — Ingestion Service & Risk Event Bus
 * Phase 2: Capture, authenticate, deduplicate, and publish risk events
 *
 * Components:
 *  1. EventDeduplicator — idempotency layer using event IDs with TTL
 *  2. RiskEventBus — in-process pub/sub for risk event routing
 *  3. InvoicePoller — periodic Razorpay Invoice API polling for missed failures
 *  4. CheckoutBeaconCollector — captures frontend checkout drop-off signals
 */

// 1. Event Deduplicator — idempotent event processing via event_id + TTL
export class EventDeduplicator {
  private seen: Map<string, number> = new Map(); // event_id → timestamp
  private readonly ttlMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMinutes: number = 60) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    // Periodic cleanup of expired entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Returns true if the event has already been seen (duplicate).
   * Returns false if the event is new, and marks it as seen.
   */
  isDuplicate(eventId: string): boolean {
    if (!eventId) return false;

    const now = Date.now();
    if (this.seen.has(eventId)) {
      const seenAt = this.seen.get(eventId)!;
      if (now - seenAt < this.ttlMs) {
        return true; // Still within TTL window → duplicate
      }
    }

    this.seen.set(eventId, now);
    return false;
  }

  /** Number of tracked event IDs */
  get size(): number {
    return this.seen.size;
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, ts] of this.seen.entries()) {
      if (now - ts > this.ttlMs) {
        this.seen.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[Deduplicator] Cleaned ${cleaned} expired event IDs (${this.seen.size} active)`);
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// 2. Risk Event Bus — in-process pub/sub for risk event routing
export type RiskEventType =
  | "payment.failed"
  | "payment.captured"
  | "subscription.halted"
  | "subscription.pending"
  | "invoice.expired"
  | "invoice.paid"
  | "checkout.abandoned"
  | "checkout.payment_page_dropout"
  | "invoice.poll.missed"
  | "invoice.poll.overdue"
  | "payment_link.paid";

export type RiskSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface RiskEvent {
  id: string;
  type: RiskEventType;
  severity: RiskSeverity;
  source: "webhook" | "beacon" | "poller";
  payload: Record<string, any>;
  customerId?: string;
  customerEmail?: string;
  amount?: number;
  currency?: string;
  declineCode?: string;
  subscriptionId?: string;
  invoiceId?: string;
  receivedAt: string;
  processedAt?: string;
  deduplicated: boolean;
  metadata?: Record<string, any>;
}

type RiskEventHandler = (event: RiskEvent) => void | Promise<void>;

export class RiskEventBus {
  private handlers: Map<string, RiskEventHandler[]> = new Map();
  private eventLog: RiskEvent[] = [];
  private maxLogSize: number;

  constructor(maxLogSize: number = 200) {
    this.maxLogSize = maxLogSize;
  }

  /** Subscribe to a specific event type or '*' for all events */
  on(eventType: RiskEventType | "*", handler: RiskEventHandler): void {
    const key = eventType;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, []);
    }
    this.handlers.get(key)!.push(handler);
  }

  /** Publish a risk event to all subscribed handlers */
  async publish(event: RiskEvent): Promise<void> {
    event.processedAt = new Date().toISOString();

    // Store in event log
    this.eventLog.unshift(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.pop();
    }

    // Dispatch to type-specific handlers
    const typeHandlers = this.handlers.get(event.type) || [];
    for (const handler of typeHandlers) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[RiskEventBus] Handler error for ${event.type}:`, err);
      }
    }

    // Dispatch to wildcard handlers
    const wildcardHandlers = this.handlers.get("*") || [];
    for (const handler of wildcardHandlers) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[RiskEventBus] Wildcard handler error:`, err);
      }
    }
  }

  /** Get recent events, optionally filtered */
  getEvents(filters?: {
    type?: RiskEventType;
    severity?: RiskSeverity;
    source?: "webhook" | "beacon" | "poller";
    limit?: number;
  }): RiskEvent[] {
    let result = this.eventLog;

    if (filters?.type) {
      result = result.filter((e) => e.type === filters.type);
    }
    if (filters?.severity) {
      result = result.filter((e) => e.severity === filters.severity);
    }
    if (filters?.source) {
      result = result.filter((e) => e.source === filters.source);
    }

    return result.slice(0, filters?.limit || 50);
  }

  /** Get event counts by severity */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {
      total: this.eventLog.length,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      webhook: 0,
      beacon: 0,
      poller: 0,
    };

    for (const event of this.eventLog) {
      stats[event.severity] = (stats[event.severity] || 0) + 1;
      stats[event.source] = (stats[event.source] || 0) + 1;
    }

    return stats;
  }
}

// 3. Severity Classifier — maps Razorpay events to risk severity levels
export function classifyRiskSeverity(
  eventType: string,
  amount?: number,
  retryCount?: number
): RiskSeverity {
  // High-value subscriptions (>₹50K) are always critical
  if (amount && amount > 50000) {
    if (eventType.includes("failed") || eventType.includes("halted")) {
      return "critical";
    }
  }

  // Escalation based on retry exhaustion
  if (retryCount !== undefined && retryCount >= 4) {
    return "critical";
  }

  switch (eventType) {
    case "subscription.halted":
      return "critical";
    case "payment.failed":
      return retryCount && retryCount >= 2 ? "high" : "medium";
    case "invoice.expired":
      return "high";
    case "subscription.pending":
      return "medium";
    case "checkout.abandoned":
    case "checkout.payment_page_dropout":
      return "medium";
    case "invoice.poll.overdue":
      return "high";
    case "invoice.poll.missed":
      return "medium";
    case "payment.captured":
    case "invoice.paid":
    case "payment_link.paid":
      return "info";
    default:
      return "low";
  }
}

// 4. Checkout Beacon Types
export interface CheckoutBeacon {
  sessionId: string;
  customerId?: string;
  customerEmail?: string;
  event: "page_load" | "payment_initiated" | "payment_method_selected" | "payment_failed_client" | "page_abandoned" | "session_timeout";
  amount?: number;
  currency?: string;
  paymentMethod?: string;
  errorMessage?: string;
  timestamp: string;
  /** Phase C1: what was in the cart when the customer walked away */
  cartItems?: Array<{ name: string; qty: number; price: number }>;
  cartValue?: number;
  metadata?: Record<string, any>;
}

// 5. Invoice Poller Configuration
export interface InvoicePollerConfig {
  intervalMs: number;
  enabled: boolean;
  overdueThresholdHours: number;
  maxInvoicesToPoll: number;
}

export const DEFAULT_POLLER_CONFIG: InvoicePollerConfig = {
  intervalMs: 5 * 60 * 1000, // Poll every 5 minutes
  enabled: true,
  overdueThresholdHours: 24,
  maxInvoicesToPoll: 50,
};
