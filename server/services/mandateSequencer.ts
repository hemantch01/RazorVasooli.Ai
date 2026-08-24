/**
 * RazorVasooli.Ai — Mandate-Aware Retry Sequencer
 *
 * UPI Autopay / e-mandate failures ke liye reason-aware retry ladder:
 *   INSUFFICIENT_FUNDS  → salary-cycle timed retry (prime: 1st–7th, 10–11 AM)
 *   BANK_TECHNICAL      → same-day +4h retry (easy win)
 *   MANDATE_PAUSED      → resume request (retry bekaar)
 *   MANDATE_REVOKED     → ❌ no retry — mandate recreation link AUTO-trigger
 *   NPCI CAP            → 3 retries/cycle max, phir manual-links-only mode
 *
 * Cap tracker Prisma (MandateRetry table) me persist hota hai;
 * DB off ho to in-memory counter fallback.
 */

import { dbEnabled, dbGetMandateRetries, dbUpsertMandate } from "../core/db.js";
import type { AuditService } from "./audit.js";

/** Safe evaluate — never throws (DB down → in-memory fallback). */
export async function safeNextMandateAction(
  mandateKey: string,
  declineCode: string,
  auditService?: AuditService
): Promise<MandateDecision> {
  try {
    return await nextMandateAction(mandateKey, declineCode, auditService);
  } catch (err: any) {
    console.warn("[Mandate] sequencer error, using fallback:", err?.message);
    return {
      action: "manual_link",
      delayHours: 24,
      reason: "Sequencer unavailable — defaulting to manual link with 24h backoff.",
      retriesUsed: 0,
      capReached: false,
    };
  }
}

const NPCI_RETRY_CAP = 3;

export type MandateAction =
  | "retry"
  | "recreate_mandate"
  | "resume_request"
  | "manual_link"
  | "stop";

export interface MandateDecision {
  action: MandateAction;
  /** Hours until the recommended next attempt (0 = immediately) */
  delayHours: number;
  reason: string;
  retriesUsed: number;
  capReached: boolean;
}

// In-memory fallback jab DB disabled ho
const memMandates = new Map<string, number>();

async function getRetries(mandateKey: string): Promise<number> {
  if (dbEnabled()) {
    const dbVal = await dbGetMandateRetries(mandateKey);
    if (dbVal > 0) return dbVal;
  }
  return memMandates.get(mandateKey) ?? 0;
}

async function recordRetry(mandateKey: string, used: number, reason: string, action: string): Promise<void> {
  if (dbEnabled()) {
    await dbUpsertMandate(mandateKey, { retriesUsed: used, lastReason: reason, nextAction: action });
  }
  // Always mirror in memory too — works with or without DB
  memMandates.set(mandateKey, used);
}

/** Salary cycle: 1st–7th = prime window. Late month → wait till 1st. */
function hoursUntilPrimeSlot(from = new Date()): number {
  const day = from.getDate();
  if (day >= 1 && day <= 7) {
    // Prime window me hain — aaj hi try karo (next morning slot)
    const target = new Date(from);
    target.setHours(10, 0, 0, 0);
    if (target <= from) target.setDate(target.getDate() + 1);
    return Math.max(1, Math.round((target.getTime() - from.getTime()) / 36e5));
  }
  // Next month ki 1st, 10 AM
  const target = new Date(from.getFullYear(), from.getMonth() + 1, 1, 10, 0, 0, 0);
  return Math.max(24, Math.round((target.getTime() - from.getTime()) / 36e5));
}

/**
 * Diagnosis category + mandate key se NEXT BEST ACTION nikalta hai.
 * Yahi single source of truth hai mandate retry strategy ka.
 */
export async function nextMandateAction(
  mandateKey: string,
  declineCode: string,
  auditService?: AuditService
): Promise<MandateDecision> {
  const code = declineCode.toUpperCase();
  const retriesUsed = await getRetries(mandateKey);
  const capReached = retriesUsed >= NPCI_RETRY_CAP;

  // Hard rules (cap se pehle, kyunki retry bekaar hai)
  if (code.includes("MANDATE_REVOKED") || code.includes("MANDATE_CANCELED")) {
    await recordRetry(mandateKey, retriesUsed, code, "recreate_mandate");
    auditService?.append("mandate.recreate_link_triggered", { mandateKey, reason: code });
    return {
      action: "recreate_mandate",
      delayHours: 0,
      reason: "Mandate revoked by customer — auto-debit impossible. Recreation link sent.",
      retriesUsed,
      capReached,
    };
  }

  if (code.includes("MANDATE_PAUSED")) {
    await recordRetry(mandateKey, retriesUsed, code, "resume_request");
    auditService?.append("mandate.resume_requested", { mandateKey });
    return {
      action: "resume_request",
      delayHours: 24,
      reason: "Mandate paused by customer — resume request sent.",
      retriesUsed,
      capReached,
    };
  }

  // NPCI cap: 3 retries/cycle ke baad manual mode only
  if (capReached) {
    await recordRetry(mandateKey, retriesUsed, code, "manual_link");
    auditService?.append("mandate.cap_reached", { mandateKey, retriesUsed });
    return {
      action: "manual_link",
      delayHours: 0,
      reason: `NPCI cap reached (${NPCI_RETRY_CAP} retries this cycle) — switching to manual UPI intent links only.`,
      retriesUsed,
      capReached: true,
    };
  }

  // Reason-aware ladder (within cap)
  const newUsed = retriesUsed + 1;
  let decision: MandateDecision;

  if (code.includes("BANK_TECHNICAL") || code.includes("GATEWAY_ERROR")) {
    decision = {
      action: "retry", delayHours: 4,
      reason: "Bank technical glitch — same-day retry likely succeeds.",
      retriesUsed: newUsed, capReached: newUsed >= NPCI_RETRY_CAP,
    };
  } else if (code.includes("INSUFFICIENT_FUNDS")) {
    const h = hoursUntilPrimeSlot();
    decision = {
      action: "retry", delayHours: newUsed === 1 ? 24 : h,
      reason: newUsed === 1
        ? "First retry after 24h — phir salary-cycle prime slot ka wait."
        : `Salary-cycle prime slot (${h}h) — highest success probability.`,
      retriesUsed: newUsed, capReached: newUsed >= NPCI_RETRY_CAP,
    };
  } else {
    decision = {
      action: "retry", delayHours: 24 * newUsed,
      reason: "Generic backoff ladder.",
      retriesUsed: newUsed, capReached: newUsed >= NPCI_RETRY_CAP,
    };
  }

  await recordRetry(mandateKey, newUsed, code, decision.action);
  auditService?.append("mandate.retry_scheduled", {
    mandateKey, attempt: newUsed, declineCode: code,
    delayHours: decision.delayHours, action: decision.action,
  });
  return decision;
}

/** Reset kar do (naya billing cycle / testing). */
export async function resetMandateCycle(mandateKey: string): Promise<void> {
  await dbUpsertMandate(mandateKey, { retriesUsed: 0 });
  memMandates.delete(mandateKey);
}
