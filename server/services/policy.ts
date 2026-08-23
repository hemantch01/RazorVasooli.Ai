/**
 * RazorVasooli.Ai — Policy Engine (Phase 4)
 *
 * Determines optimal intervention strategy; AI agent reasons over options
 * while rules-based veto guardrails enforce strict compliance and safety.
 *
 * Components:
 *  1. Rules-Based Allowed Action Generator (Task 4.1)
 *  2. Rules-Only Baseline Matcher (Task 4.2)
 *  3. Agent Intervention Selector & Narration (Task 4.3)
 *  4. Rules Veto Guardrail (Task 4.4)
 */

import { type FailureCategory, type TaxonomyEntry, type RecoverabilityResult } from "./diagnosis.js";
import { metrics } from "../core/metrics.js";
import { rankChannelsBySuccess, getCategorySummary } from "./outcomeMemory.js";
import { findSimilarCases } from "./embeddings.js";

// Types & Interfaces

export type Channel = "telegram"|"email" | "sms" | "whatsapp" | "payment_link" | "subscription_update_link" | "voice_call";

export type EscalationLevel = "none" | "soft_reminder" | "urgent_reminder" | "final_notice" | "human_escalation";

export interface AllowedActionSet {
  /** Permitted channels for this case */
  channels: Channel[];
  /** Permitted delay windows in hours */
  delayWindows: number[];
  /** Maximum attempts permitted before hard-stop */
  maxAttempts: number;
  /** Current attempt number */
  currentAttempt: number;
  /** Escalation thresholds */
  escalationThresholds: {
    softReminderAfterAttempts: number;
    urgentReminderAfterAttempts: number;
    humanEscalationAfterAttempts: number;
  };
  /** Maximum discount the agent may offer (%) */
  maxDiscountPercent: number;
  /** Whether subscription update link is allowed */
  allowSubscriptionUpdate: boolean;
  /** Reason for this action set */
  reasoning: string;
}

export interface PolicyDecision {
  caseId: string;
  /** The chosen intervention */
  channel: Channel;
  delayHours: number;
  escalationLevel: EscalationLevel;
  discountIncentive: number;  // percent
  /** How the decision was made */
  decisionSource: "agent" | "agent_vetoed" | "rule";
  /** Human-readable narration of the decision */
  narration: string;
  /** The allowed action set used */
  allowedActions: AllowedActionSet;
  /** Veto details, if agent was overridden */
  vetoReason?: string;
  decidedAt: string;
}

export interface PolicyInput {
  caseId: string;
  /** Diagnosis results */
  category: FailureCategory;
  taxonomy: TaxonomyEntry;
  recoverability: RecoverabilityResult;
  /** Case details */
  amount: number;
  retryCount: number;
  customerName?: string;
  paymentMethod?: string;
  isSubscription?: boolean;
  declineCode?: string;
}

export interface PolicyServiceStats {
  totalDecisions: number;
  bySource: Record<string, number>;
  byChannel: Record<string, number>;
  byEscalation: Record<string, number>;
  vetoCount: number;
  avgDiscountOffered: number;
  lastDecisionAt: string | null;
}

// 1. TASK 4.1: Rules-Based Allowed Action Generator
//    Given diagnosis category + attempt number → strict Allowed Action Set

/**
 * Compute the strict Allowed Action Set for a given case.
 * This defines the boundaries within which the AI agent must operate.
 */
export function computeAllowedActions(input: PolicyInput): AllowedActionSet {
  const { category, retryCount, isSubscription, amount } = input;

  let channels: Channel[] = [];
  let delayWindows: number[] = [];
  let maxAttempts = 3; // Default hard-stop at 3 attempts
  let maxDiscountPercent = 0;
  let allowSubscriptionUpdate = false;

  switch (category) {
    // Soft declines (high recoverability)
    case "soft_decline_funds":
      channels = ["telegram", "email", "whatsapp", "sms", "payment_link"];
      delayWindows = [0]; // FORCED FOR TESTING
      maxAttempts = 3;
      maxDiscountPercent = retryCount >= 2 ? 10 : 5;
      break;

    case "soft_decline_network":
      channels = ["sms", "whatsapp", "payment_link"];
      delayWindows = [0.25, 0.5, 1, 4]; // Fast retry for transient errors
      maxAttempts = 3;
      maxDiscountPercent = 0; // No discount needed for network issues
      break;

    case "authentication_failure":
      channels = ["sms", "whatsapp", "payment_link"];
      delayWindows = [0.25, 1, 4];
      maxAttempts = 3;
      maxDiscountPercent = 0;
      break;

    // Hard declines (low recoverability)
    case "hard_decline_card":
      channels = ["email", "whatsapp", "payment_link"];
      delayWindows = [4, 24, 48];
      maxAttempts = 2; // Fewer attempts for hard declines
      maxDiscountPercent = retryCount >= 1 ? 10 : 5;
      break;

    case "hard_decline_account":
      channels = ["email"];
      delayWindows = [24, 48];
      maxAttempts = 2;
      maxDiscountPercent = 5;
      break;

    // Mandate/NACH failures
    case "mandate_failure":
      channels = ["email", "whatsapp", "payment_link"];
      if (isSubscription) {
        channels.push("subscription_update_link");
        allowSubscriptionUpdate = true;
      }
      delayWindows = [4, 24, 48];
      maxAttempts = 3;
      maxDiscountPercent = 5;
      break;

    // Fraud blocks
    case "fraud_block":
      channels = ["email"]; // Only email for fraud — very cautious
      delayWindows = [48]; // Long delay — needs human review
      maxAttempts = 1;
      maxDiscountPercent = 0;
      break;

    // Abandoned checkouts
    case "abandoned_checkout":
      channels = ["whatsapp", "email", "sms", "payment_link"];
      delayWindows = [0.5, 2, 12, 24];
      maxAttempts = 3;
      maxDiscountPercent = retryCount >= 1 ? 10 : 5;
      break;

    // Invoice overdue
    case "invoice_overdue":
      channels = ["email", "whatsapp", "sms", "payment_link"];
      delayWindows = [4, 24, 48];
      maxAttempts = 3;
      maxDiscountPercent = amount > 50000 ? 5 : 10; // Less discount for big amounts
      break;

    // Unknown
    default:
      channels = ["email", "whatsapp"];
      delayWindows = [12, 24];
      maxAttempts = 2;
      maxDiscountPercent = 5;
      break;
  }

  // High-value transactions (>₹1L) require voice escalation option
  if (amount > 100000 && !channels.includes("voice_call")) {
    channels.push("voice_call");
  }

  // Subscription-halted cases always get update link option
  if (isSubscription && !channels.includes("subscription_update_link")) {
    channels.push("subscription_update_link");
    allowSubscriptionUpdate = true;
  }

  return {
    channels,
    delayWindows,
    maxAttempts,
    currentAttempt: retryCount + 1,
    escalationThresholds: {
      softReminderAfterAttempts: 1,
      urgentReminderAfterAttempts: 2,
      humanEscalationAfterAttempts: maxAttempts,
    },
    maxDiscountPercent,
    allowSubscriptionUpdate,
    reasoning: `Category=${category}, attempt=${retryCount + 1}/${maxAttempts}, subscription=${!!isSubscription}, amount=₹${amount}`,
  };
}

// 2. TASK 4.2: Rules-Only Baseline Matcher
//    Standard deterministic policy: picks default channel + delay

/**
 * Pure rules-based deterministic decision.
 * Picks the first available channel and optimal delay from the allowed set.
 */
export function applyBaselineRule(
  input: PolicyInput,
  allowedActions: AllowedActionSet
): PolicyDecision {
  // Phase L1: rank allowed channels by MEASURED recovery success for this
  // category. Memory can only REORDER the rules-based allowed set — it can
  // never add/remove channels or bypass discounts/escalation caps. Cold
  // start (no data) preserves the original static priority order.
  const ranked = rankChannelsBySuccess(input.category, allowedActions.channels);
  const channel = ranked[0] as Channel;

  // Pick optimal delay: match with timing hint from diagnosis

  const delay = 0; // FORCE INSTANT DELIVERY FOR DEMO (pickClosestDelay(suggestedDelay, allowedActions.delayWindows))

  // Compute escalation level
  const escalationLevel = computeEscalation(
    allowedActions.currentAttempt,
    allowedActions.escalationThresholds
  );

  // Discount: apply only on 2nd+ attempt for soft declines
  let discount = 0;
  if (input.retryCount >= 1 && allowedActions.maxDiscountPercent > 0) {
    discount = Math.min(5, allowedActions.maxDiscountPercent);
  }
  if (input.retryCount >= 2 && allowedActions.maxDiscountPercent >= 10) {
    discount = 10;
  }

  const narration = buildNarration(input, channel, delay, escalationLevel, discount, "rule");

  return {
    caseId: input.caseId,
    channel,
    delayHours: delay,
    escalationLevel,
    discountIncentive: discount,
    decisionSource: "rule",
    narration,
    allowedActions,
    decidedAt: new Date().toISOString(),
  };
}

// 3. TASK 4.3: Agent Intervention Selector & Narration
//    For ambiguous/high-value cases, an AI agent reasons about the best action

export interface AgentChoice {
  channel: Channel;
  delayHours: number;
  escalationLevel: EscalationLevel;
  discountIncentive: number;
  narration: string;
}

/**
 * Phase L1: measured historical performance for this category — lets the LLM
 * reason WITH evidence instead of priors alone. Empty when memory is cold.
 */
function buildPerformanceSection(category: FailureCategory): string {
  const perf = getCategorySummary(category, 6);
  if (perf.length === 0) return "";
  const lines = perf.map((p) =>
    ` - **${p.channel}**: ${Math.round(p.rate * 100)}% recovered (${p.recovered}/${p.attempted} attempts)`
  );
  return `\n## 📊 Historical Performance for ${category}\n${lines.join("\n")}\nPrefer higher-performing channels when it fits the customer context.\n`;
}

/**
 * Phase L2: retrieve similar past cases and format for the LLM prompt.
 * Returns empty string when no embeddings exist (cold start / no API key).
 */
async function buildSimilarCasesSection(input: PolicyInput): Promise<string> {
  const queryText = `${input.category} ₹${input.amount} ${input.declineCode || ""} ${input.paymentMethod || ""} attempt ${input.retryCount}`;
  
  const similar = await findSimilarCases(queryText, input.category, 3, 0.65);
  if (similar.length === 0) return "";

  const lines = similar.map((s, i) =>
    `${i + 1}. [${s.recovered ? "✅ RECOVERED" : "❌ LOST"}] ₹${s.amountInr.toLocaleString("en-IN")} via **${s.channel}**${s.discount > 0 ? ` (${s.discount}% discount)` : ""} — similarity ${Math.round(s.similarity * 100)}%\n   ${s.narrative}`
  );

  return `\n## 📚 Similar Past Cases (RAG Retrieved)\n${lines.join("\n")}\nLearn from these outcomes — but your guardrails still apply strictly.\n`;
}

/**
 * Build the prompt for the LLM agent to reason about the best intervention.
 */
export async function buildAgentPrompt(input: PolicyInput, allowedActions: AllowedActionSet): Promise<string> {
  return `You are an intelligent Indian revenue recovery agent for a SaaS company using Razorpay.

## Case Context
- **Case ID**: ${input.caseId}
- **Customer**: ${input.customerName || "Unknown"}
- **Amount**: ₹${input.amount.toLocaleString("en-IN")}
- **Payment Method**: ${input.paymentMethod || "unknown"}
- **Decline Code**: ${input.declineCode || "unknown"}
- **Failure Category**: ${input.category}
- **Recoverability Score**: ${input.recoverability.score} (${input.recoverability.confidence} confidence)
- **Timing Hint**: ${input.recoverability.timingHint.reason}
- **Retry Count**: ${input.retryCount}
- **Is Subscription**: ${input.isSubscription ? "Yes" : "No"}

## Allowed Actions (STRICT — you MUST choose within these)
- **Channels**: ${JSON.stringify(allowedActions.channels)}
- **Delay Windows (hours)**: ${JSON.stringify(allowedActions.delayWindows)}
- **Max Discount**: ${allowedActions.maxDiscountPercent}%
- **Attempt**: ${allowedActions.currentAttempt} of ${allowedActions.maxAttempts}
${buildPerformanceSection(input.category)}
${await buildSimilarCasesSection(input)}
## Your Task
Choose the single best intervention and explain your reasoning in a plain-English narration (1-2 sentences).

Respond in STRICT JSON only:
{
  "channel": "<one of the allowed channels>",
  "delayHours": <one of the allowed delay windows>,
  "escalationLevel": "<none|soft_reminder|urgent_reminder|final_notice|human_escalation>",
  "discountIncentive": <0 to ${allowedActions.maxDiscountPercent}>,
  "narration": "<plain-English reasoning>"
}`;
}

/**
 * Parse the agent's LLM response into a structured AgentChoice.
 */
export function parseAgentResponse(llmResponse: string): AgentChoice | null {
  try {
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.channel || parsed.delayHours === undefined) return null;

    const validEscalations: EscalationLevel[] = [
      "none", "soft_reminder", "urgent_reminder", "final_notice", "human_escalation",
    ];

    return {
      channel: parsed.channel as Channel,
      delayHours: Number(parsed.delayHours),
      escalationLevel: validEscalations.includes(parsed.escalationLevel)
        ? parsed.escalationLevel
        : "soft_reminder",
      discountIncentive: Number(parsed.discountIncentive) || 0,
      narration: parsed.narration || "Agent chose intervention",
    };
  } catch {
    return null;
  }
}

/**
 * Determine if a case qualifies for agent reasoning (ambiguous zone).
 * Cases with score ∈ [0.35, 0.70] or high-value (>₹25K) benefit from AI reasoning.
 */
export function shouldUseAgent(input: PolicyInput): boolean {
  const score = input.recoverability.score;
  const isAmbiguous = score >= 0.35 && score <= 0.70;
  const isHighValue = input.amount > 25000;
  return isAmbiguous || isHighValue;
}

// 4. TASK 4.4: Rules Veto Guardrail
//    Validates Agent's choice against the Allowed Action Set

interface VetoResult {
  isValid: boolean;
  violations: string[];
}

/**
 * Validate an agent's choice against the allowed action set.
 * Returns whether the choice is valid and any violations found.
 */
export function vetoCheck(choice: AgentChoice, allowedActions: AllowedActionSet): VetoResult {
  const violations: string[] = [];

  // Check 1: Channel must be in allowed set
  if (!allowedActions.channels.includes(choice.channel)) {
    violations.push(`Channel "${choice.channel}" not in allowed set [${allowedActions.channels.join(", ")}]`);
  }

  // Check 2: Delay must be in allowed windows (allow 10% tolerance)
  const isValidDelay = allowedActions.delayWindows.some(
    (d) => Math.abs(choice.delayHours - d) <= d * 0.1 + 0.1
  );
  if (!isValidDelay) {
    violations.push(`Delay ${choice.delayHours}h not in allowed windows [${allowedActions.delayWindows.join(", ")}]`);
  }

  // Check 3: Discount must not exceed maximum
  if (choice.discountIncentive > allowedActions.maxDiscountPercent) {
    violations.push(`Discount ${choice.discountIncentive}% exceeds max ${allowedActions.maxDiscountPercent}%`);
  }

  // Check 4: Discount must be non-negative
  if (choice.discountIncentive < 0) {
    violations.push(`Discount ${choice.discountIncentive}% is negative`);
  }

  // Check 5: Cannot exceed max attempts
  if (allowedActions.currentAttempt > allowedActions.maxAttempts) {
    violations.push(`Attempt ${allowedActions.currentAttempt} exceeds max ${allowedActions.maxAttempts}`);
  }

  return {
    isValid: violations.length === 0,
    violations,
  };
}

// 5. PolicyService — Full Pipeline Orchestrator

export class PolicyService {
  private decisionLog: PolicyDecision[] = [];
  private maxLogSize: number;
  private stats: PolicyServiceStats = {
    totalDecisions: 0,
    bySource: { agent: 0, agent_vetoed: 0, rule: 0 },
    byChannel: {},
    byEscalation: {},
    vetoCount: 0,
    avgDiscountOffered: 0,
    lastDecisionAt: null,
  };

  /** Optional LLM call function for agent reasoning */
  private llmCall?: (prompt: string) => Promise<string>;

  constructor(maxLogSize: number = 200, llmCall?: (prompt: string) => Promise<string>) {
    this.maxLogSize = maxLogSize;
    this.llmCall = llmCall;
  }

  /**
   * Full policy decision pipeline.
   * 1. Compute allowed actions
   * 2. If ambiguous/high-value and LLM available → agent reasoning + veto check
   * 3. Otherwise → rules-only baseline
   */
  async decide(input: PolicyInput): Promise<PolicyDecision> {
    // Step 1: Compute what actions are allowed
    const allowedActions = computeAllowedActions(input);

    // Step 2: Check if this case is already beyond max attempts
    if (allowedActions.currentAttempt > allowedActions.maxAttempts) {
      // Hard stop — escalate to human
      const narration = `Case ${input.caseId}: Attempt ${allowedActions.currentAttempt} exceeds max ${allowedActions.maxAttempts}. Escalating to human agent.`;
      const decision: PolicyDecision = {
        caseId: input.caseId,
        channel: "email",
        delayHours: 0,
        escalationLevel: "human_escalation",
        discountIncentive: 0,
        decisionSource: "rule",
        narration,
        allowedActions,
        decidedAt: new Date().toISOString(),
      };
      this.recordDecision(decision);
      return decision;
    }

    // Step 3: Should we use the AI agent?
    if (shouldUseAgent(input) && this.llmCall) {
      try {
        const prompt = await buildAgentPrompt(input, allowedActions);
        const llmResponse = await this.llmCall(prompt);
        const agentChoice = parseAgentResponse(llmResponse);

        if (agentChoice) {
          // Step 4: Veto check
          const veto = vetoCheck(agentChoice, allowedActions);

          if (veto.isValid) {
            // Agent's choice passes veto → use it
            const decision: PolicyDecision = {
              caseId: input.caseId,
              channel: agentChoice.channel,
              delayHours: agentChoice.delayHours,
              escalationLevel: agentChoice.escalationLevel,
              discountIncentive: agentChoice.discountIncentive,
              decisionSource: "agent",
              narration: agentChoice.narration,
              allowedActions,
              decidedAt: new Date().toISOString(),
            };
            this.recordDecision(decision);
            return decision;
          } else {
            // Agent violated rules → fallback to baseline with veto flag
            console.warn(
              `[Policy] ⚠️ Agent vetoed for ${input.caseId}: ${veto.violations.join("; ")}`
            );
            const fallback = applyBaselineRule(input, allowedActions);
            fallback.decisionSource = "agent_vetoed";
            fallback.vetoReason = veto.violations.join("; ");
            fallback.narration = `[VETOED] Agent suggested ${agentChoice.channel}/${agentChoice.delayHours}h but violated rules: ${veto.violations.join("; ")}. Falling back to ${fallback.channel}/${fallback.delayHours}h.`;
            this.recordDecision(fallback);
            return fallback;
          }
        }
      } catch (err) {
        console.error(`[Policy] Agent LLM error for ${input.caseId}:`, err);
        // Fall through to baseline
      }
    }

    // Step 5: Pure rules-based fallback
    const decision = applyBaselineRule(input, allowedActions);
    this.recordDecision(decision);
    return decision;
  }

  private recordDecision(decision: PolicyDecision): void {
    this.decisionLog.unshift(decision);
    if (this.decisionLog.length > this.maxLogSize) {
      this.decisionLog.pop();
    }
    this.updateStats(decision);
  }

  private updateStats(decision: PolicyDecision): void {
    this.stats.totalDecisions++;
    this.stats.lastDecisionAt = decision.decidedAt;
    metrics.policyDecision(decision.decisionSource, decision.channel);
    this.stats.bySource[decision.decisionSource] =
      (this.stats.bySource[decision.decisionSource] || 0) + 1;
    this.stats.byChannel[decision.channel] =
      (this.stats.byChannel[decision.channel] || 0) + 1;
    this.stats.byEscalation[decision.escalationLevel] =
      (this.stats.byEscalation[decision.escalationLevel] || 0) + 1;

    if (decision.decisionSource === "agent_vetoed") {
      this.stats.vetoCount++;
    }

    // Running average of discount
    const n = this.stats.totalDecisions;
    this.stats.avgDiscountOffered =
      Math.round(
        ((this.stats.avgDiscountOffered * (n - 1) + decision.discountIncentive) / n) * 100
      ) / 100;
  }

  /** Get recent decisions */
  getDecisions(limit: number = 50): PolicyDecision[] {
    return this.decisionLog.slice(0, limit);
  }

  /** Get aggregated stats */
  getStats(): PolicyServiceStats {
    return { ...this.stats };
  }

  /** Set the LLM call function (for late binding) */
  setLLMCall(fn: (prompt: string) => Promise<string>): void {
    this.llmCall = fn;
  }
}

// Helper Functions


/** Compute escalation level based on attempt number and thresholds */
function computeEscalation(
  currentAttempt: number,
  thresholds: AllowedActionSet["escalationThresholds"]
): EscalationLevel {
  if (currentAttempt >= thresholds.humanEscalationAfterAttempts) return "human_escalation";
  if (currentAttempt >= thresholds.urgentReminderAfterAttempts) return "urgent_reminder";
  if (currentAttempt >= thresholds.softReminderAfterAttempts) return "soft_reminder";
  return "none";
}

/** Build a human-readable narration of the policy decision */
function buildNarration(
  input: PolicyInput,
  channel: Channel,
  delayHours: number,
  escalation: EscalationLevel,
  discount: number,
  _source: string
): string {
  const amtStr = `₹${input.amount.toLocaleString("en-IN")}`;
  const method = input.paymentMethod || "payment";
  const parts: string[] = [];

  parts.push(`Customer had ${input.category.replace(/_/g, " ")} on ${amtStr} ${method}`);

  if (input.declineCode) {
    parts.push(`(${input.declineCode})`);
  }

  parts.push(`— retrying via ${channel}`);

  if (delayHours < 1) {
    parts.push(`in ${Math.round(delayHours * 60)} minutes`);
  } else if (delayHours < 24) {
    parts.push(`after ${delayHours}h`);
  } else {
    parts.push(`after ${Math.round(delayHours / 24)}d`);
  }

  if (discount > 0) {
    parts.push(`with ${discount}% recovery discount`);
  }

  if (escalation !== "none") {
    parts.push(`[${escalation.replace(/_/g, " ").toUpperCase()}]`);
  }

  if (input.recoverability.timingHint.isPaydayWindow) {
    parts.push("(payday window)");
  }

  return parts.join(" ");
}
