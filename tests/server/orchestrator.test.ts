/**
 * Orchestrator — bounded state machine & compliance hard-stop tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  OrchestratorService,
  checkCompliance,
  registerDpdpOptOut,
  isDpdpOptedOut,
  removeDpdpOptOut,
  DEFAULT_COMPLIANCE,
  type RecoveryCase,
} from "../../server/services/orchestrator.js";


process.env.DATABASE_URL = "";


describe("state machine transitions", () => {
  let svc: OrchestratorService;
  beforeEach(() => {
    svc = new OrchestratorService();
    svc.createCase({ id: "c1", customerEmail: "a@b.in", amount: 1000, currency: "INR" });
  });

  it("walks the happy path DETECTED → DIAGNOSED → POLICY_SELECTED → INTERVENING → RECOVERED", () => {
    expect(svc.transitionState("c1", "DIAGNOSED", "test")).not.toBeNull();
    expect(svc.transitionState("c1", "POLICY_SELECTED", "test")).not.toBeNull();
    expect(svc.transitionState("c1", "INTERVENING", "test")).not.toBeNull();
    const done = svc.transitionState("c1", "RECOVERED", "paid");
    expect(done?.state).toBe("RECOVERED");
  });

  it("rejects invalid transitions (no skipping stages)", () => {
    // DETECTED → RECOVERED is not whitelisted
    expect(svc.transitionState("c1", "RECOVERED", "skip attempt")).toBeNull();
    // Case must still be in its original state
    expect(svc.getCase("c1")?.state).toBe("DETECTED");
  });

  it("rejects transitions out of terminal states", () => {
    svc.transitionState("c1", "DIAGNOSED", "ok");
    svc.transitionState("c1", "POLICY_SELECTED", "ok");
    svc.transitionState("c1", "SKIPPED_COMPLIANCE", "dpdp stop");
    expect(svc.transitionState("c1", "INTERVENING", "resurrection")).toBeNull();
  });

  it("runs a promise sweep as a contextual intervention after the promise date", async () => {
    svc.transitionState("c1", "DIAGNOSED", "test");
    svc.transitionState("c1", "POLICY_SELECTED", "test");
    svc.transitionState("c1", "INTERVENING", "test");
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const paused = svc.recordPromise("c1", tomorrow, 1000);
    const job = svc.getJobs({ caseId: "c1" }).find((candidate) => candidate.type === "promise_sweep");

    expect(paused?.state).toBe("PAUSED_PROMISE");
    expect(job?.executeAt).toBe(`${tomorrow}T04:30:00.000Z`);

    svc.setPromiseReminderProvider(async () => "Promise reminder {{PAYMENT_LINK}}");
    let deliveredMessage = "";
    svc.setInterventionHandler(async (_caseData, executedJob) => {
      deliveredMessage = executedJob.customMessage || "";
    });

    await (svc as any).executeJob(job!.id);
    expect(svc.getCase("c1")?.state).toBe("INTERVENING");
    expect(deliveredMessage).toContain("{{PAYMENT_LINK}}");
    svc.destroy();
  });
});

describe("compliance hard stops", () => {
  it("blocks outreach for DPDP opt-outs", () => {
    registerDpdpOptOut("optout@test.in");
    expect(isDpdpOptedOut("optout@test.in")).toBe(true);
    const c = { customerEmail: "optout@test.in", amount: 1000, attemptCount: 0 } as unknown as RecoveryCase;
    const result = checkCompliance(c, DEFAULT_COMPLIANCE);
    expect(result.allowed).toBe(false);
    expect(result.isDpdpOptedOut).toBe(true);
    expect(result.reason).toMatch(/DPDP opt-out/i);
    removeDpdpOptOut("optout@test.in");
  });

  it("flags AFA requirement above the RBI e-mandate threshold for subscriptions", () => {
    const c = {
      customerEmail: "rich@test.in",
      amount: DEFAULT_COMPLIANCE.rbiAfaThreshold + 1,
      attemptCount: 0,
      subscriptionId: "sub_123",
    } as unknown as RecoveryCase;
    const result = checkCompliance(c, DEFAULT_COMPLIANCE);
    expect(result.isAfaRequired).toBe(true);
  });

  it("blocks after max contact attempts are exhausted", () => {
    const c = {
      customerEmail: "spammed@test.in",
      amount: 500,
      attemptCount: DEFAULT_COMPLIANCE.maxContactAttempts,
    } as unknown as RecoveryCase;
    const result = checkCompliance(c, DEFAULT_COMPLIANCE);
    expect(result.allowed).toBe(false);
    expect(result.isMaxAttemptsExceeded).toBe(true);
  });
});
