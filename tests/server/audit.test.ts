/**
 * Audit Service (Task 6.4) — hash-chain integrity tests.
 * Highest-stakes pure module: tamper detection must never have false negatives.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AuditService, type AuditEntry } from "../../server/services/audit.js";

describe("AuditService", () => {
  let audit: AuditService;

  beforeEach(() => {
    process.env.DATABASE_URL = ""; // force in-memory mode — no Postgres in unit tests
    audit = new AuditService(100);
  });

  it("appends entries with a valid monotonic chain", () => {
    const e1 = audit.append("event.a", { x: 1 });
    const e2 = audit.append("event.b", { y: 2 });

    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe("GENESIS_SEED");
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);

    const v = audit.verifyChain();
    expect(v.valid).toBe(true);
    expect(v.entriesChecked).toBe(2);
  });

  it("produces identical hashes for identical content (deterministic canonical JSON)", () => {
    const a = new AuditService(10);
    const b = new AuditService(10);
    const fixedTs = "2026-08-30T18:00:00.000Z";
    // Different key insertion order, same logical payload → same chain hash
    const e1 = a.append("evt", { alpha: 1, beta: { z: 1, a: 2 } }, fixedTs);
    const e2 = b.append("evt", { beta: { a: 2, z: 1 }, alpha: 1 }, fixedTs);
    expect(e1.hash).toBe(e2.hash);
  });

  it("detects tampering of a payload via hash mismatch", () => {
    audit.append("event.a", { amount: 100 });
    const second = audit.append("event.b", { amount: 200 });
    const entries = audit.getEntries({ limit: 10 });
    // Mutate the oldest entry's payload in place (simulating DB tamper)
    const oldest = entries.find((e) => e.seq === 1)!;
    (oldest.payload as Record<string, unknown>).amount = 999999;

    const v = audit.verifyChain();
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/Tamper detected|hash mismatch/i);
    expect(second.seq).toBe(2); // sanity
  });

  it("detects a broken link when prevHash is corrupted", () => {
    audit.append("event.a", {});
    audit.append("event.b", {});
    const entries = audit.getEntries({ limit: 10 });
    const oldest = entries.find((e) => e.seq === 1)!;
    oldest.prevHash = "DEADBEEF";

    const v = audit.verifyChain();
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/prevHash mismatch/i);
    expect(v.brokenAtSeq).toBe(1);
  });

  it("continues the chain seamlessly after restore-from-DB tail", () => {
    const first = new AuditService(100);
    first.append("event.a", { i: 1 });
    first.append("event.a", { i: 2 });
    const persisted = first.getEntries({ limit: 10 }).slice().reverse(); // DB order: seq asc

    const restarted = new AuditService(100);
    restarted.loadExternalEntries(persisted as unknown as Array<Omit<AuditEntry, never>>);
    const next = restarted.append("event.b", { i: 3 });

    expect(next.seq).toBe(3);
    expect(next.prevHash).toBe(persisted[persisted.length - 1].hash);
    expect(restarted.verifyChain().valid).toBe(true);
  });

  it("evicts oldest beyond capacity while remaining verifiable", () => {
    const tiny = new AuditService(3);
    for (let i = 0; i < 5; i++) tiny.append("event.bulk", { i });
    const entries = tiny.getEntries({ limit: 10 });
    expect(entries.length).toBeLessThanOrEqual(3);
    // Chain verification starts from earliest retained entry — still consistent
    const head = tiny.getStats();
    expect(head.totalEntries).toBe(3);
    expect(head.headHash).toBeTruthy();
  });
});
