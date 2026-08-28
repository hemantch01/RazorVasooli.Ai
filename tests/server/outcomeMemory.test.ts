/**
 * Outcome Memory & Learning Loop (Phase L1) — unit tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  smoothedRate,
  recordOutcome,
  rankChannelsBySuccess,
  getCategorySummary,
  getTopLearnedRules,
  getMemorySize,
  clearOutcomeMemory,
  seedFromPersonas,
} from "../../server/services/outcomeMemory.js";

process.env.DATABASE_URL = "";

describe("smoothedRate (Laplace)", () => {
  it("returns 0.5 for cold/empty stats", () => {
    expect(smoothedRate(0, 0)).toBe(0.5);
  });

  it("pulls tiny samples toward 0.5 — a lucky 1/1 is not 100%", () => {
    expect(smoothedRate(1, 1)).toBeCloseTo(0.667, 2);
    expect(smoothedRate(1, 1)).toBeLessThan(1);
  });

  it("converges to the true rate with large samples", () => {
    expect(smoothedRate(80, 100)).toBeCloseTo(0.7941, 3); // (80+1)/(100+2)
  });
});

describe("recordOutcome + ranking", () => {
  beforeEach(async () => {
    await clearOutcomeMemory();
  });

  it("ranks channels by measured success within a category", () => {
    // telegram wins 8/10, email wins 3/10 for funds issues
    for (let i = 0; i < 10; i++) {
      recordOutcome({ category: "soft_decline_funds", channel: "telegram", attempt: 1, recovered: i < 8 });
      recordOutcome({ category: "soft_decline_funds", channel: "email", attempt: 1, recovered: i < 3 });
    }
    const ranked = rankChannelsBySuccess("soft_decline_funds", ["email", "sms", "telegram"]);
    expect(ranked[0]).toBe("telegram");
    expect(ranked).toContain("sms"); // untried channel stays in the set
    expect(ranked).toHaveLength(3); // never adds/removes channels
  });

  it("keeps static order when memory is cold", () => {
    const ranked = rankChannelsBySuccess("hard_decline_card", ["email", "whatsapp"]);
    expect(ranked).toEqual(["email", "whatsapp"]);
  });

  it("separates categories — funds stats don't leak into hard declines", () => {
    recordOutcome({ category: "soft_decline_funds", channel: "sms", attempt: 1, recovered: true });
    const ranked = rankChannelsBySuccess("hard_decline_card", ["email", "payment_link"]);
    expect(ranked).toEqual(["email", "payment_link"]); // untouched
  });
});

describe("persona seed generator", () => {
  it("generates exactly the requested users with deterministic results", async () => {
    await clearOutcomeMemory();
    const s1 = await seedFromPersonas(250);
    expect(s1.totalUsers).toBe(250);
    expect(Object.values(s1.byPersona).reduce((a, b) => a + b, 0)).toBe(250);
    expect(s1.recovered).toBeGreaterThan(0);
    expect(s1.totalOutcomes).toBeGreaterThanOrEqual(250); // multi-attempt users
    expect(s1.sampleConversations.length).toBeGreaterThan(0);

    // Deterministic: same seed → identical recovery count
    const s2 = await seedFromPersonas(250);
    expect(s2.totalOutcomes).toBe(s1.totalOutcomes);
    expect(s2.recovered).toBe(s1.recovered);
  });

  it("produces learnable signal — per-channel rates differ within a category", async () => {
    await seedFromPersonas(250);
    const summary = getCategorySummary("soft_decline_funds");
    expect(summary.length).toBeGreaterThan(1);
    // The seeded win-rate matrix guarantees spread between best and worst
    const spread = summary[0].rate - summary[summary.length - 1].rate;
    expect(spread).toBeGreaterThan(0.05);
  });

  it("clear() resets everything", async () => {
    await seedFromPersonas(50);
    expect(getMemorySize()).toBeGreaterThan(0);
    await clearOutcomeMemory();
    expect(getMemorySize()).toBe(0);
    expect(getTopLearnedRules()).toHaveLength(0);
  });
});
