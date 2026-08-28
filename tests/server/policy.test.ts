/**
 * Policy Engine — veto guardrail & allowed-action-set tests.
 * The guardrail is the safety boundary around the LLM; it must clamp every violation.
 */
import { describe, it, expect } from "vitest";
import {
  computeAllowedActions,
  vetoCheck,
  shouldUseAgent,
  parseAgentResponse,
  type AgentChoice,
} from "../../server/services/policy.js";
import { DiagnosisService } from "../../server/services/diagnosis.js";

process.env.DATABASE_URL = "";

async function makeInput(overrides: Record<string, unknown> = {}) {
  const diagnosis = await new DiagnosisService().diagnose({
    caseId: "case_test",
    errorCode: (overrides.declineCode as string) || "INSUFFICIENT_FUNDS",
    amount: 5000,
    retryCount: 0,
    hoursSinceFailure: 1,
  });
  return {
    caseId: "case_test",
    category: diagnosis.taxonomy.category,
    taxonomy: diagnosis.taxonomy,
    recoverability: diagnosis.recoverability,
    amount: 5000,
    retryCount: 0,
    ...overrides,
  };
}

describe("computeAllowedActions", () => {
  it("returns a non-empty bounded action set for soft declines", async () => {
    const set = computeAllowedActions(await makeInput());
    expect(set.channels.length).toBeGreaterThan(0);
    expect(set.delayWindows.length).toBeGreaterThan(0);
    expect(set.maxAttempts).toBeGreaterThan(0);
    expect(set.maxDiscountPercent).toBeGreaterThanOrEqual(0);
  });
});

describe("vetoCheck — the LLM guardrail", () => {
  it("accepts a choice fully within the allowed action set", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const choice: AgentChoice = {
      channel: allowed.channels[0],
      delayHours: allowed.delayWindows[0],
      escalationLevel: "none",
      discountIncentive: 0,
      narration: "within bounds",
    };
    expect(vetoCheck(choice, allowed).isValid).toBe(true);
  });

  it("vetoes a disallowed channel", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const disallowed = (["email", "sms", "whatsapp", "payment_link", "subscription_update_link", "voice_call"] as const)
      .find((c) => !allowed.channels.includes(c));
    if (!disallowed) return; // all channels allowed for this case — skip
    const result = vetoCheck(
      { channel: disallowed, delayHours: allowed.delayWindows[0], escalationLevel: "none", discountIncentive: 0, narration: "" },
      allowed
    );
    expect(result.isValid).toBe(false);
    expect(result.violations[0]).toMatch(/not in allowed set/i);
  });

  it("vetoes an out-of-window delay", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const result = vetoCheck(
      { channel: allowed.channels[0], delayHours: 9999, escalationLevel: "none", discountIncentive: 0, narration: "" },
      allowed
    );
    expect(result.isValid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/not in allowed windows/i);
  });

  it("vetoes a discount exceeding the maximum", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const result = vetoCheck(
      { channel: allowed.channels[0], delayHours: allowed.delayWindows[0], escalationLevel: "none", discountIncentive: allowed.maxDiscountPercent + 50, narration: "" },
      allowed
    );
    expect(result.isValid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/exceeds max/i);
  });

  it("vetoes negative discounts", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const result = vetoCheck(
      { channel: allowed.channels[0], delayHours: allowed.delayWindows[0], escalationLevel: "none", discountIncentive: -10, narration: "" },
      allowed
    );
    expect(result.violations.join(" ")).toMatch(/negative/i);
  });
});

describe("shouldUseAgent", () => {
  it("routes ambiguous-score cases to the agent", async () => {
    const input = await makeInput();
    // score forced into the ambiguous band
    const patched = { ...input, recoverability: { ...input.recoverability, score: 0.5 } };
    expect(shouldUseAgent(patched as never)).toBe(true);
  });

  it("routes high-value cases (>₹25K) to the agent regardless of score", async () => {
    const input = await makeInput({ amount: 90000 });
    const patched = { ...input, recoverability: { ...input.recoverability, score: 0.1 } };
    expect(shouldUseAgent(patched as never)).toBe(true);
  });

  it("keeps clear low-value cases on deterministic rules", async () => {
    const input = await makeInput({ amount: 1000 });
    const patched = { ...input, recoverability: { ...input.recoverability, score: 0.05 } };
    expect(shouldUseAgent(patched as never)).toBe(false);
  });
});

describe("parseAgentResponse", () => {
  it("parses strict JSON agent output", () => {
    const raw = `Here is my decision:\n{"channel":"email","delayHours":4,"escalationLevel":"none","discountIncentive":2,"narration":"Retry soon."}`;
    const parsed = parseAgentResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.channel).toBe("email");
    expect(parsed!.discountIncentive).toBe(2);
  });

  it("returns null for garbage output and sanitizes bad escalation levels", () => {
    expect(parseAgentResponse("no json here")).toBeNull();
    const parsed = parseAgentResponse('{"channel":"sms","delayHours":1,"escalationLevel":"yolo"}');
    expect(parsed!.escalationLevel).toBe("soft_reminder"); // safe default
  });
});
