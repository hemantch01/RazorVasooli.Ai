/**
 * Policy Engine — veto guardrail & allowed-action-set tests.
 * The guardrail is the safety boundary around the LLM; it must clamp every violation.
 */
import { describe, it, expect } from "vitest";
import {
  computeAllowedActions,
  validateAgentDecision,
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

describe("validateAgentDecision — the LLM guardrail", () => {
  it("accepts a choice fully within the allowed action set", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const choice: AgentChoice = {
      channel: allowed.channels[0],
      delayHours: allowed.delayWindows[0],
      escalationLevel: "none",
      discountIncentive: 0,
      narration: "within bounds",
      state: "INTERVENING",
    };
    expect(validateAgentDecision("DETECTED", choice, allowed).vetoReason).toBeUndefined();
  });

  it("vetoes a disallowed channel", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const disallowed = (["email", "sms", "whatsapp", "payment_link", "subscription_update_link", "voice_call"] as const)
      .find((c) => !allowed.channels.includes(c));
    if (!disallowed) return; // all channels allowed for this case — skip
    const result = validateAgentDecision(
      "DETECTED",
      { channel: disallowed, delayHours: allowed.delayWindows[0], escalationLevel: "none", discountIncentive: 0, narration: "", state: "INTERVENING" },
      allowed
    );
    expect(result.vetoReason).toBeDefined();
    expect(result.vetoReason).toMatch(/not allowed/i);
    expect(result.decision.channel).toBe(allowed.channels[0]); // clamped
  });

  it("vetoes an out-of-window delay", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const result = validateAgentDecision(
      "DETECTED",
      { channel: allowed.channels[0], delayHours: 9999, escalationLevel: "none", discountIncentive: 0, narration: "", state: "INTERVENING" },
      allowed
    );
    expect(result.vetoReason).toBeDefined();
    expect(result.vetoReason).toMatch(/not allowed/i);
    expect(result.decision.delayHours).toBe(allowed.delayWindows[0]); // clamped
  });

  it("vetoes a discount exceeding the maximum", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const result = validateAgentDecision(
      "DETECTED",
      { channel: allowed.channels[0], delayHours: allowed.delayWindows[0], escalationLevel: "none", discountIncentive: allowed.maxDiscountPercent + 50, narration: "", state: "INTERVENING" },
      allowed
    );
    expect(result.vetoReason).toBeDefined();
    expect(result.vetoReason).toMatch(/exceeds max/i);
    expect(result.decision.discountIncentive).toBe(allowed.maxDiscountPercent); // clamped
  });

  it("vetoes negative discounts", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const result = validateAgentDecision(
      "DETECTED",
      { channel: allowed.channels[0], delayHours: allowed.delayWindows[0], escalationLevel: "none", discountIncentive: -10, narration: "", state: "INTERVENING" },
      allowed
    );
    expect(result.decision.discountIncentive).toBe(0); // clamped
  });

  it("vetoes RECOVERED because only a verified payment webhook may set it", async () => {
    const input = await makeInput();
    const allowed = computeAllowedActions(input);
    const result = validateAgentDecision(
      "INTERVENING",
      { channel: allowed.channels[0], delayHours: allowed.delayWindows[0], escalationLevel: "none", discountIncentive: 0, narration: "customer claims they paid", state: "RECOVERED" },
      allowed
    );
    expect(result.vetoReason).toMatch(/webhook-only/i);
    expect(result.decision.state).toBe("INTERVENING");
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
