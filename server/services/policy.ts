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
import type { CaseState } from "./orchestrator.js";
import { metrics } from "../core/metrics.js";
import { findSimilarCases } from "./embeddings.js";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function geminiComplete(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const preferredModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const modelCandidates = Array.from(
    new Set([preferredModel, "gemini-3.5-flash", "gemini-3.7-flash"])
  );

  let lastError: Error | null = null;

  for (const model of modelCandidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });

        if (res.status === 429) {
          console.warn(`[Gemini] Model ${model} hit 429; cascading to next candidate...`);
          await sleep(500);
          break; // Try next model immediately
        }

        if (!res.ok) {
          const errText = await res.text();
          lastError = new Error(`Gemini ${model} Error ${res.status}: ${errText}`);
          break;
        }

        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } catch (err: any) {
        lastError = err;
        await sleep(500);
      }
    }
  }

  throw lastError || new Error("Gemini generation failed across all model candidates");
}

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
  /** Personalized message */
  message?: string;
  state?: CaseState;
  metadata?: Record<string, any>;
  rag_context?: string[];
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

  channels = ["telegram", "email"];
  allowSubscriptionUpdate = false;

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
  const channel = allowedActions.channels[0];

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
  message?: string;
  state: CaseState;
  metadata?: Record<string, any>;
}

/**
 * Phase L2: retrieve similar past cases and format for the LLM prompt.
 * Returns empty string when no embeddings exist (cold start / no API key).
 */
export function formatSimilarCases(similar: Array<{ caseId: string; amountInr: number; channel: string; discount: number; similarity: number; recovered: boolean; narrative: string }>): string {
  if (!similar || similar.length === 0) return "";

  const lines = similar.map((s, i) =>
    `${i + 1}. [${s.recovered ? "✅ RECOVERED" : "❌ LOST"}] ₹${s.amountInr.toLocaleString("en-IN")} via **${s.channel}**${s.discount > 0 ? ` (${s.discount}% discount)` : ""} — similarity ${Math.round(s.similarity * 100)}%\n   ${s.narrative}`
  );

  return `\n## 📚 Similar Past Cases (RAG Retrieved)\n${lines.join("\n")}\nLearn from these outcomes — but your guardrails still apply strictly.\n`;
}

/**
 * Build the prompt for the LLM agent to reason about the best intervention.
 */
export async function buildAgentPrompt(
  input: PolicyInput,
  allowedActions: AllowedActionSet,
  similarCases?: Array<{ caseId: string; amountInr: number; channel: string; discount: number; similarity: number; recovered: boolean; narrative: string }>
): Promise<string> {
  const queryText = `${input.category} ₹${input.amount} ${input.declineCode || ""} ${input.paymentMethod || ""} attempt ${input.retryCount}`;
  const similar = similarCases !== undefined ? similarCases : await findSimilarCases(queryText, input.category, 3, 0.65);
  const similarSection = formatSimilarCases(similar);

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
${similarSection}
## Your Task
Choose the single best intervention and explain your reasoning in a plain-English narration (1-2 sentences).

## Personalization Mandate
The similar past cases are REAL conversation outcomes. Mirror what worked:
if a similar customer recovered after a salary-date promise + 2 telegram
nudges, use that exact sequence and tone. You are choosing for THIS
customer right now.

Respond in STRICT JSON only:
{
  "channel": "telegram" | "email",
  "delayHours": <one of the allowed delay windows>,
  "escalationLevel": "<none|soft_reminder|urgent_reminder|final_notice|human_escalation>",
  "discountIncentive": <0 to ${allowedActions.maxDiscountPercent}>,
  "message": "<the actual Hinglish message to send this customer now — max 2 sentences, references their situation. Must include questions like 'Should I generate a payment link?' or 'Do you want to opt out?' if relevant>",
  "state": "<INTERVENING|PAUSED_PROMISE|ESCALATED|CLOSED_LOST|SKIPPED_COMPLIANCE>",
  "metadata": {
    "date": "<YYYY-MM-DD>" // ONLY if state is PAUSED_PROMISE
    // Include any other state-specific metadata as needed
  },
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
      message: String(parsed.message || "").slice(0, 400),
      state: parsed.state || "INTERVENING",
      metadata: parsed.metadata || {},
    };
  } catch {
    return null;
  }
}

// `shouldUseAgent` removed as part of L2-only migration.

// 4. TASK 4.4: Rules Veto Guardrail
//    Validates Agent's choice against the Allowed Action Set

/**
 * Validate an agent's choice against the allowed action set and state rules.
 * Returns the clamped decision and any violations found (Step 2a).
 */
export function validateAgentDecision(
  currentState: CaseState,
  choice: AgentChoice, 
  allowedActions: AllowedActionSet
): { decision: AgentChoice, vetoReason?: string } {
  const violations: string[] = [];

  // Check 1: Channel must be in allowed set
  if (!allowedActions.channels.includes(choice.channel)) {
    violations.push(`Channel "${choice.channel}" not allowed`);
    choice.channel = allowedActions.channels[0]; // clamp
  }

  // Check 2: Delay must be in allowed windows
  const isValidDelay = allowedActions.delayWindows.some(
    (d) => Math.abs(choice.delayHours - d) <= d * 0.1 + 0.1
  );
  if (!isValidDelay) {
    violations.push(`Delay ${choice.delayHours}h not allowed`);
    choice.delayHours = allowedActions.delayWindows[0] || 0; // clamp
  }

  // Check 3: Discount cap
  if (choice.discountIncentive > allowedActions.maxDiscountPercent) {
    violations.push(`Discount ${choice.discountIncentive}% exceeds max ${allowedActions.maxDiscountPercent}%`);
    choice.discountIncentive = allowedActions.maxDiscountPercent; // clamp
  }
  if (choice.discountIncentive < 0) {
    choice.discountIncentive = 0; // clamp
  }

  // Check 4: State Transition Rules (Determinism Guard)
  // RECOVERED is webhook-only, SKIPPED_COMPLIANCE is confirm-flow only
  if (choice.state === "RECOVERED") {
    violations.push("RECOVERED state is webhook-only, agent cannot propose it");
    choice.state = "INTERVENING";
  }
  
  if (choice.state === "SKIPPED_COMPLIANCE") {
    violations.push("SKIPPED_COMPLIANCE is system-only via confirm flow");
    choice.state = "INTERVENING";
  }

  const agentAllowedStates: CaseState[] = ["INTERVENING", "PAUSED_PROMISE", "CLOSED_LOST", "ESCALATED"];
  if (!agentAllowedStates.includes(choice.state)) {
    violations.push(`Agent cannot transition to arbitrary state ${choice.state}`);
    choice.state = "INTERVENING";
  }

  // The agent may classify a reply, but cannot skip the deterministic state
  // machine. This check is deliberately duplicated here so an invalid choice
  // is vetoed before it reaches the Orchestrator.
  const validNext: Record<CaseState, readonly CaseState[]> = {
    DETECTED: ["INTERVENING"],
    DIAGNOSED: ["INTERVENING", "ESCALATED", "CLOSED_LOST"],
    POLICY_SELECTED: ["INTERVENING", "PAUSED_PROMISE", "ESCALATED", "CLOSED_LOST"],
    INTERVENING: ["INTERVENING", "PAUSED_PROMISE", "ESCALATED", "CLOSED_LOST"],
    PAUSED_PROMISE: ["INTERVENING", "ESCALATED", "CLOSED_LOST"],
    RECOVERED: [],
    ESCALATED: [],
    CLOSED_LOST: [],
    SKIPPED_COMPLIANCE: [],
  };
  if (!validNext[currentState].includes(choice.state)) {
    violations.push(`State ${choice.state} is not reachable from ${currentState}`);
    choice.state = "INTERVENING";
  }

  return {
    decision: choice,
    vetoReason: violations.length > 0 ? violations.join("; ") : undefined,
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
    this.llmCall = llmCall || (process.env.NODE_ENV !== "test" ? geminiComplete : undefined);
    if (this.llmCall) {
      console.log("[Policy] Agent LLM bound");
    }
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

    // Step 3: Use the AI agent unconditionally if available
    if (this.llmCall) {
      try {
        const queryText = `${input.category} ₹${input.amount} ${input.declineCode || ""} ${input.paymentMethod || ""} attempt ${input.retryCount}`;
        const similar = await findSimilarCases(queryText, input.category, 3, 0.65);
        const ragContextIds = similar.map((s) => s.caseId);

        const prompt = await buildAgentPrompt(input, allowedActions, similar);
        const llmResponse = await this.llmCall(prompt);
        const agentChoice = parseAgentResponse(llmResponse);

        if (agentChoice) {
          // Step 4: Veto check and clamp
          const { decision: clampedChoice, vetoReason } = validateAgentDecision(
            "DIAGNOSED",
            agentChoice, 
            allowedActions
          );

          if (vetoReason) {
            console.warn(`[Policy] ⚠️ Agent choice clamped for ${input.caseId}: ${vetoReason}`);
          }

          const decision: PolicyDecision = {
            caseId: input.caseId,
            channel: clampedChoice.channel,
            delayHours: clampedChoice.delayHours,
            escalationLevel: clampedChoice.escalationLevel,
            discountIncentive: clampedChoice.discountIncentive,
            decisionSource: vetoReason ? "agent_vetoed" : "agent",
            narration: vetoReason ? `[CLAMPED] ${vetoReason}. Original: ${clampedChoice.narration}` : clampedChoice.narration,
            allowedActions,
            vetoReason,
            decidedAt: new Date().toISOString(),
            message: clampedChoice.message,
            state: clampedChoice.state,
            metadata: clampedChoice.metadata,
            rag_context: ragContextIds,
          };
          this.recordDecision(decision);
          return decision;
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

  /**
   * Handle a customer reply in a conversational turn.
   */
  async conversationalTurn(
    caseId: string,
    currentState: CaseState,
    replyText: string,
    channel: Channel,
    allowedActions: AllowedActionSet
  ): Promise<PolicyDecision> {
    if (!this.llmCall) {
      const fallback = applyBaselineRule(
        { caseId, category: "unknown" as any, taxonomy: {} as any, amount: 0, retryCount: allowedActions.currentAttempt, recoverability: {} as any, isSubscription: false },
        allowedActions
      );
      this.recordDecision(fallback);
      return fallback;
    }

    const prompt = `You are a revenue recovery agent.
Case ID: ${caseId}
Current State: ${currentState}
The customer just replied on ${channel}: "${replyText}"

Your allowed maximum discount is ${allowedActions.maxDiscountPercent}%.
Classify their intent and output EXACTLY ONE of the following JSON structures. Do not output anything else.

If they promised to pay on a date:
{"state": "PAUSED_PROMISE", "metadata": {"date": "YYYY-MM-DD", "reason": "...", "verbatim": "..."}, "message": "...", "delayHours": 0, "discountIncentive": 0, "channel": "${channel}", "narration": "..."}

If they objected to the price (e.g. expensive):
{"state": "INTERVENING", "metadata": {"objection": "expensive", "offeredDiscount": <0-${allowedActions.maxDiscountPercent}>}, "message": "...", "delayHours": 0, "discountIncentive": <discount>, "channel": "${channel}", "narration": "..."}

If they said YES to a payment link:
{"state": "INTERVENING", "metadata": {"intent": "generate_link"}, "message": "...", "delayHours": 0, "discountIncentive": <previous discount if any>, "channel": "${channel}", "narration": "..."}

If they opted out (e.g. stop, don't message):
{"state": "CLOSED_LOST", "metadata": {"reason": "opt_out"}, "message": "...", "delayHours": 0, "discountIncentive": 0, "channel": "${channel}", "narration": "..."}

If they dispute the charge:
{"state": "ESCALATED", "metadata": {"reason": "dispute_claim"}, "message": "...", "delayHours": 0, "discountIncentive": 0, "channel": "${channel}", "narration": "..."}

If it is a question:
{"state": "INTERVENING", "metadata": {"intent": "question"}, "message": "...", "delayHours": 0, "discountIncentive": 0, "channel": "${channel}", "narration": "..."}

If hostile/abuse:
{"state": "CLOSED_LOST", "metadata": {"reason": "hostile", "needsConfirmation": true}, "message": "...", "delayHours": 0, "discountIncentive": 0, "channel": "${channel}", "narration": "..."}

If unclassifiable:
{"state": "INTERVENING", "metadata": {"intent": "clarify"}, "message": "...", "delayHours": 0, "discountIncentive": 0, "channel": "${channel}", "narration": "..."}`;

    try {
      const llmResponse = await this.llmCall(prompt);
      const agentChoice = parseAgentResponse(llmResponse);

      if (agentChoice) {
        const { decision: clampedChoice, vetoReason } = validateAgentDecision(
          currentState,
          agentChoice,
          allowedActions
        );

        if (vetoReason) {
          console.warn(`[Policy] ⚠️ Conversational turn clamped for ${caseId}: ${vetoReason}`);
        }

        const decision: PolicyDecision = {
          caseId,
          channel: clampedChoice.channel,
          delayHours: clampedChoice.delayHours,
          escalationLevel: clampedChoice.escalationLevel,
          discountIncentive: clampedChoice.discountIncentive,
          decisionSource: vetoReason ? "agent_vetoed" : "agent",
          narration: vetoReason ? `[CLAMPED] ${vetoReason}. Original: ${clampedChoice.narration}` : clampedChoice.narration,
          allowedActions,
          vetoReason,
          decidedAt: new Date().toISOString(),
          message: clampedChoice.message,
          state: clampedChoice.state,
          metadata: clampedChoice.metadata
        };
        this.recordDecision(decision);
        return decision;
      }
    } catch (err) {
      console.error(`[Policy] Agent LLM error during conversational turn for ${caseId}:`, err);
    }

    const fallback = applyBaselineRule(
      { caseId, category: "unknown" as any, taxonomy: {} as any, amount: 0, retryCount: allowedActions.currentAttempt, recoverability: {} as any, isSubscription: false },
      allowedActions
    );
    this.recordDecision(fallback);
    return fallback;
  }

  /**
   * Produce copy for an already-authorized promise-follow-up. This method
   * intentionally returns text only: it cannot select a state, discount,
   * channel, or payment outcome. The Orchestrator remains responsible for
   * all side effects and will replace the payment-link placeholder itself.
   */
  async composePromiseReminder(context: {
    caseId: string;
    customerName?: string;
    amount: number;
    promisedDate: string;
    transcript: string[];
  }): Promise<string> {
    const fallback = `Namaste ji, aapne ${context.promisedDate} tak payment ka promise kiya tha. Aaj woh date aa gayi hai—kya aap abhi payment complete kar sakte hain? {{PAYMENT_LINK}}`;
    if (!this.llmCall) return fallback;

    try {
      const response = await this.llmCall(`You are drafting a single, polite Hinglish payment reminder. The promise date is today.
Customer: ${context.customerName || "Customer"}
Amount due: ₹${context.amount}
Promised date: ${context.promisedDate}
Recent conversation excerpts: ${context.transcript.join(" | ").slice(-1200) || "none"}

Write only the customer-facing message, maximum 400 characters. Do not claim payment was received, offer a discount, opt the customer out, change state, or add a URL. Include the literal placeholder {{PAYMENT_LINK}} exactly once.`);
      const message = String(response || "").trim().slice(0, 400);
      if (!message) return fallback;
      return message.includes("{{PAYMENT_LINK}}")
        ? message
        : `${message.slice(0, 380)}\n\n{{PAYMENT_LINK}}`;
    } catch (err) {
      console.warn(`[Policy] Promise reminder generation failed for ${context.caseId}:`, err);
      return fallback;
    }
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

  if (input.recoverability?.timingHint?.isPaydayWindow) {
    parts.push("(payday window)");
  }

  return parts.join(" ");
}
