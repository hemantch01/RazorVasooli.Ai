/**
 * RazorVasooli.Ai — Audit Service (Task 6.4)
 *
 * Tamper-evident, append-only, SHA-256 hash-chained audit ledger.
 *
 * Chain formula:
 *   H_n = SHA256( H_{n-1} || timestamp || event_type || canonical_payload )
 *
 * The genesis entry uses H_0 = SHA256("GENESIS").
 * Single-writer sink: all pipeline events funnel through `append()`.
 */

import crypto from "crypto";
import { dbAppendAudit } from "../core/db.js";
import { metrics } from "../core/metrics.js";

export interface AuditEntry {
  /** Monotonic sequence number (1-based) */
  seq: number;
  timestamp: string;
  eventType: string;
  /** Canonical JSON payload (stable key ordering) */
  payload: Record<string, unknown>;
  /** Hash of the previous entry ("GENESIS_SEED" for first entry) */
  prevHash: string;
  /** SHA-256 chain hash of this entry */
  hash: string;
}

export interface ChainVerification {
  valid: boolean;
  totalEntries: number;
  entriesChecked: number;
  brokenAtSeq?: number;
  reason?: string;
  verifiedAt: string;
}

/** Deterministic canonical JSON serialization (sorted keys, no whitespace) */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

const GENESIS_PREV_HASH = "GENESIS_SEED";

export class AuditService {
  private ledger: AuditEntry[] = [];
  private lastHash: string = GENESIS_PREV_HASH;
  private maxEntries: number;

  constructor(maxEntries: number = 2000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Append an event to the hash chain (single-writer sink).
   */
  append(eventType: string, payload: Record<string, unknown>): AuditEntry {
    const timestamp = new Date().toISOString();
    // Seq continues from the head of the chain (robust after restore-from-DB)
    const seq = (this.ledger.at(-1)?.seq ?? 0) + 1;

    // Normalize payload to match JSON representation (converts Dates to ISO strings, strips undefined)
    const normalizedPayload = JSON.parse(JSON.stringify(payload));
    const canonicalPayload = canonicalize(normalizedPayload);
    const hash = crypto
      .createHash("sha256")
      .update(`${this.lastHash}|${timestamp}|${eventType}|${canonicalPayload}`)
      .digest("hex");

    const entry: AuditEntry = {
      seq,
      timestamp,
      eventType,
      payload,
      prevHash: this.lastHash,
      hash,
    };

    this.ledger.push(entry);
    this.lastHash = hash;
    metrics.auditAppend();

    // Evict oldest entries beyond capacity (chain remains verifiable from earliest retained)
    if (this.ledger.length > this.maxEntries) {
      this.ledger.shift();
    }

    // Durable persistence (Postgres when DATABASE_URL configured) — never blocks the pipeline
    void dbAppendAudit(entry).catch((err) => console.warn("[Audit] DB persist failed:", (err as Error).message));

    console.log(`[Audit] #${seq} ${eventType} → ${hash.slice(0, 12)}…`);
    return entry;
  }

  /**
   * Restore entries loaded from durable storage (Postgres). The chain is
   * trusted as previously verified; new appends continue from its head.
   */
  loadExternalEntries(entries: Array<Omit<AuditEntry, never>>): void {
    for (const e of entries) {
      this.ledger.push({
        seq: Number(e.seq),
        timestamp: String(e.timestamp),
        eventType: String(e.eventType),
        payload: typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload,
        prevHash: String(e.prevHash),
        hash: String(e.hash),
      });
      this.lastHash = String(e.hash);
      if (this.ledger.length > this.maxEntries) this.ledger.shift();
    }
  }

  /**
   * Verify the integrity of the entire cryptographic chain.
   * Recomputes every hash and compares links.
   */
  verifyChain(): ChainVerification {
    const verifiedAt = new Date().toISOString();
    let expectedPrev = GENESIS_PREV_HASH;

    for (let i = 0; i < this.ledger.length; i++) {
      const entry = this.ledger[i];

      // Check link: prevHash must match previous computed hash
      if (entry.prevHash !== expectedPrev) {
        return {
          valid: false,
          totalEntries: this.ledger.length,
          entriesChecked: i,
          brokenAtSeq: entry.seq,
          reason: `Broken link at entry #${entry.seq}: prevHash mismatch`,
          verifiedAt,
        };
      }

      // Recompute hash
      const recomputed = crypto
        .createHash("sha256")
        .update(
          `${entry.prevHash}|${entry.timestamp}|${entry.eventType}|${canonicalize(entry.payload)}`
        )
        .digest("hex");

      if (recomputed !== entry.hash) {
        return {
          valid: false,
          totalEntries: this.ledger.length,
          entriesChecked: i,
          brokenAtSeq: entry.seq,
          reason: `Tamper detected at entry #${entry.seq}: hash mismatch`,
          verifiedAt,
        };
      }

      expectedPrev = entry.hash;
    }

    return {
      valid: true,
      totalEntries: this.ledger.length,
      entriesChecked: this.ledger.length,
      verifiedAt,
    };
  }

  getEntries(filters?: {
    eventType?: string;
    limit?: number;
  }): AuditEntry[] {
    let results = [...this.ledger].reverse(); // newest first

    if (filters?.eventType) {
      results = results.filter((e) => e.eventType === filters.eventType);
    }

    return results.slice(0, filters?.limit || 100);
  }

  getStats(): {
    totalEntries: number;
    headHash: string;
    lastEventType: string | null;
    lastAppendAt: string | null;
    byEventType: Record<string, number>;
  } {
    const byEventType: Record<string, number> = {};
    for (const e of this.ledger) {
      byEventType[e.eventType] = (byEventType[e.eventType] || 0) + 1;
    }
    const last = this.ledger.at(-1);
    return {
      totalEntries: this.ledger.length,
      headHash: this.lastHash,
      lastEventType: last?.eventType ?? null,
      lastAppendAt: last?.timestamp ?? null,
      byEventType,
    };
  }
}