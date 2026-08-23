/**
 * RazorVasooli.Ai — Diagnosis Service (Phase 3)
 *
 * Classifies failure root cause, scores recoverability, and computes timing heuristics.
 *
 * Components:
 *  1. Razorpay Error Taxonomy Classifier (Task 3.1)
 *  2. Recoverability Scoring Engine (Task 3.2)
 *  3. LLM Diagnosis Fallback for Unknown Codes (Task 3.3)
 *  4. DiagnosisService — orchestrates classification → scoring → publishing (Task 3.4)
 */

// 1. TASK 3.1: Razorpay Error Taxonomy Classifier
//    Maps Razorpay error codes → standardized failure categories

export type FailureCategory =
  | "soft_decline_funds"       // Temporary: insufficient funds, limit exceeded
  | "soft_decline_network"     // Temporary: timeout, gateway error, UPI collect timeout
  | "hard_decline_card"        // Permanent: expired card, stolen card, invalid CVV
  | "hard_decline_account"     // Permanent: closed account, invalid account number
  | "mandate_failure"          // e-Mandate/NACH debit failures
  | "authentication_failure"   // 3DS/OTP/AFA failures
  | "fraud_block"              // Fraud detection blocks
  | "abandoned_checkout"       // Checkout page dropout (from beacons)
  | "invoice_overdue"          // Overdue/expired invoice
  | "unknown";                 // Unclassified — triggers LLM fallback

export interface TaxonomyEntry {
  category: FailureCategory;
  subcategory: string;
  isTransient: boolean;       // Can retry help?
  urgency: "immediate" | "standard" | "deferred";
  suggestedChannels: string[];
}

/**
 * Comprehensive Razorpay error code → taxonomy mapping.
 * Covers all documented Razorpay error codes plus common gateway variants.
 */
const ERROR_TAXONOMY: Record<string, TaxonomyEntry> = {
  // Checkout Abandonment (from beacons)
  "CHECKOUT_ABANDONED": {
    category: "abandoned_checkout",
    subcategory: "cart_abandoned",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["whatsapp", "telegram", "email"],
  },
  "PAGE_ABANDONED": {
    category: "abandoned_checkout",
    subcategory: "page_dropout",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["whatsapp", "telegram", "email"],
  },
  // Soft Declines (Funds)
  "INSUFFICIENT_FUNDS": {
    category: "soft_decline_funds",
    subcategory: "insufficient_balance",
    isTransient: true,
    urgency: "deferred",
    suggestedChannels: ["whatsapp", "sms"],
  },
  "LIMIT_EXCEEDED": {
    category: "soft_decline_funds",
    subcategory: "daily_limit_exceeded",
    isTransient: true,
    urgency: "deferred",
    suggestedChannels: ["whatsapp", "email"],
  },
  "AMOUNT_EXCEEDS_LIMIT": {
    category: "soft_decline_funds",
    subcategory: "transaction_limit",
    isTransient: true,
    urgency: "deferred",
    suggestedChannels: ["email", "whatsapp"],
  },

  // Soft Declines (Network/Timeout)
  "BAD_REQUEST_PAYMENT_TIMED_OUT": {
    category: "soft_decline_network",
    subcategory: "payment_timeout",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["sms", "whatsapp"],
  },
  "GATEWAY_ERROR": {
    category: "soft_decline_network",
    subcategory: "gateway_failure",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["sms", "whatsapp"],
  },
  "NETWORK_ERROR": {
    category: "soft_decline_network",
    subcategory: "network_failure",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["sms", "whatsapp"],
  },
  "UPI_COLLECT_TIMEOUT": {
    category: "soft_decline_network",
    subcategory: "upi_timeout",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["whatsapp", "sms"],
  },
  "SERVER_ERROR": {
    category: "soft_decline_network",
    subcategory: "server_error",
    isTransient: true,
    urgency: "standard",
    suggestedChannels: ["email"],
  },

  // Hard Declines (Card)
  "CARD_EXPIRED": {
    category: "hard_decline_card",
    subcategory: "expired_card",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email", "whatsapp"],
  },
  "EXPIRED_CARD": {
    category: "hard_decline_card",
    subcategory: "expired_card",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email", "whatsapp"],
  },
  "INVALID_CARD": {
    category: "hard_decline_card",
    subcategory: "invalid_card_number",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email"],
  },
  "CARD_STOLEN": {
    category: "hard_decline_card",
    subcategory: "stolen_card",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email"],
  },
  "CARD_DECLINED": {
    category: "hard_decline_card",
    subcategory: "generic_decline",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email", "whatsapp"],
  },
  "INVALID_CVV": {
    category: "hard_decline_card",
    subcategory: "invalid_cvv",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email"],
  },

  // Hard Declines (Account)
  "BANK_DECLINED": {
    category: "hard_decline_account",
    subcategory: "bank_rejection",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email", "whatsapp"],
  },
  "INVALID_ACCOUNT": {
    category: "hard_decline_account",
    subcategory: "invalid_account",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email"],
  },
  "ACCOUNT_CLOSED": {
    category: "hard_decline_account",
    subcategory: "closed_account",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email"],
  },

  // Mandate / NACH Failures
  "MANDATE_DEBIT_FAILED": {
    category: "mandate_failure",
    subcategory: "mandate_debit_rejected",
    isTransient: true,
    urgency: "standard",
    suggestedChannels: ["email", "whatsapp"],
  },
  "MANDATE_NOT_ACTIVE": {
    category: "mandate_failure",
    subcategory: "mandate_inactive",
    isTransient: false,
    urgency: "standard",
    suggestedChannels: ["email"],
  },
  "NACH_RETURN": {
    category: "mandate_failure",
    subcategory: "nach_returned",
    isTransient: true,
    urgency: "standard",
    suggestedChannels: ["email", "whatsapp"],
  },

  // Authentication Failures
  "AUTHENTICATION_FAILED": {
    category: "authentication_failure",
    subcategory: "3ds_otp_failure",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["sms", "whatsapp"],
  },
  "OTP_EXPIRED": {
    category: "authentication_failure",
    subcategory: "otp_expired",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["sms"],
  },
  "3DS_FAILED": {
    category: "authentication_failure",
    subcategory: "3ds_authentication_failure",
    isTransient: true,
    urgency: "immediate",
    suggestedChannels: ["sms", "whatsapp"],
  },

  // Fraud Blocks
  "FRAUD_SUSPECTED": {
    category: "fraud_block",
    subcategory: "fraud_detection",
    isTransient: false,
    urgency: "deferred",
    suggestedChannels: ["email"],
  },
  "RISK_CHECK_FAILED": {
    category: "fraud_block",
    subcategory: "risk_assessment_block",
    isTransient: false,
    urgency: "deferred",
    suggestedChannels: ["email"],
  },
};

/**
 * Classify a Razorpay error code into the taxonomy.
 * Returns the taxonomy entry or null if the code is unknown.
 */
export function classifyErrorCode(errorCode: string): TaxonomyEntry | null {
  // Exact match
  const normalized = errorCode.toUpperCase().replace(/\s+/g, "_");
  if (ERROR_TAXONOMY[normalized]) {
    return ERROR_TAXONOMY[normalized];
  }

  // Fuzzy match: try substring matching for gateway-specific variants
  for (const [key, entry] of Object.entries(ERROR_TAXONOMY)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return entry;
    }
  }

  return null; // Unknown → triggers LLM fallback
}

// 2. TASK 3.2: Recoverability Scoring Engine
//    Feature-weighted heuristic score ∈ [0.0, 1.0]

export interface RecoverabilityInput {
  category: FailureCategory;
  amount: number;                // in INR
  retryCount: number;
  paymentMethod?: string;        // "card" | "upi" | "netbanking" | "wallet" | "emandate"
  hoursSinceFailure: number;
  customerTenure?: number;       // months as customer (if known)
  previousRecoveries?: number;   // how many times recovered before
  isSubscription?: boolean;
}

export interface RecoverabilityResult {
  score: number;                 // 0.0 to 1.0
  confidence: "high" | "medium" | "low";
  timingHint: TimingHint;
  factors: ScoringFactor[];
}

export interface TimingHint {
  suggestedDelayHours: number;
  reason: string;
  isPaydayWindow: boolean;       // 1st-7th of month (Indian salary cycle)
  isWeekend: boolean;
  quietHoursBlocked: boolean;    // 21:00-09:00 IST
}

interface ScoringFactor {
  factor: string;
  weight: number;
  value: number;
  contribution: number;
}

/** Category base scores — how recoverable each failure type typically is */
const CATEGORY_BASE_SCORES: Record<FailureCategory, number> = {
  soft_decline_funds: 0.72,
  soft_decline_network: 0.85,
  hard_decline_card: 0.35,
  hard_decline_account: 0.15,
  mandate_failure: 0.55,
  authentication_failure: 0.80,
  fraud_block: 0.10,
  abandoned_checkout: 0.60,
  invoice_overdue: 0.50,
  unknown: 0.40,
};

/**
 * Compute recoverability score with weighted factors.
 */
export function scoreRecoverability(input: RecoverabilityInput): RecoverabilityResult {
  const factors: ScoringFactor[] = [];

  // Factor 1: Category base score (weight: 0.35)
  const categoryScore = CATEGORY_BASE_SCORES[input.category] ?? 0.40;
  factors.push({
    factor: "failure_category",
    weight: 0.35,
    value: categoryScore,
    contribution: 0.35 * categoryScore,
  });

  // Factor 2: Retry exhaustion penalty (weight: 0.20)
  // Score decreases as retries increase. 0 retries = 1.0, 5+ retries = 0.1
  const retryScore = Math.max(0.1, 1.0 - input.retryCount * 0.18);
  factors.push({
    factor: "retry_exhaustion",
    weight: 0.20,
    value: retryScore,
    contribution: 0.20 * retryScore,
  });

  // Factor 3: Amount tier (weight: 0.15)
  // Lower amounts are easier to recover (less friction for customer)
  let amountScore: number;
  if (input.amount <= 5000) amountScore = 0.90;
  else if (input.amount <= 15000) amountScore = 0.75;
  else if (input.amount <= 50000) amountScore = 0.55;
  else if (input.amount <= 100000) amountScore = 0.40;
  else amountScore = 0.25;
  factors.push({
    factor: "amount_tier",
    weight: 0.15,
    value: amountScore,
    contribution: 0.15 * amountScore,
  });

  // Factor 4: Freshness — hours since failure (weight: 0.15)
  // Recovery likelihood decays over time
  let freshnessScore: number;
  if (input.hoursSinceFailure <= 1) freshnessScore = 1.0;
  else if (input.hoursSinceFailure <= 6) freshnessScore = 0.85;
  else if (input.hoursSinceFailure <= 24) freshnessScore = 0.65;
  else if (input.hoursSinceFailure <= 72) freshnessScore = 0.40;
  else if (input.hoursSinceFailure <= 168) freshnessScore = 0.20; // 1 week
  else freshnessScore = 0.05;
  factors.push({
    factor: "freshness",
    weight: 0.15,
    value: freshnessScore,
    contribution: 0.15 * freshnessScore,
  });

  // Factor 5: Payment method recoverability (weight: 0.10)
  const methodScores: Record<string, number> = {
    upi: 0.90,       // Easy to retry via new UPI link
    card: 0.60,      // May need card update
    netbanking: 0.50, // Requires customer action
    wallet: 0.85,     // Easy retry
    emandate: 0.45,   // Complex re-authorization
  };
  const methodScore = methodScores[input.paymentMethod || "card"] ?? 0.50;
  factors.push({
    factor: "payment_method",
    weight: 0.10,
    value: methodScore,
    contribution: 0.10 * methodScore,
  });

  // Factor 6: Customer loyalty bonus (weight: 0.05)
  let loyaltyScore = 0.50; // default for unknown tenure
  if (input.customerTenure !== undefined) {
    if (input.customerTenure >= 12) loyaltyScore = 0.90;
    else if (input.customerTenure >= 6) loyaltyScore = 0.75;
    else if (input.customerTenure >= 3) loyaltyScore = 0.60;
    else loyaltyScore = 0.40;
  }
  if (input.previousRecoveries && input.previousRecoveries > 0) {
    loyaltyScore = Math.min(1.0, loyaltyScore + 0.15); // Bonus for past successful recoveries
  }
  factors.push({
    factor: "customer_loyalty",
    weight: 0.05,
    value: loyaltyScore,
    contribution: 0.05 * loyaltyScore,
  });

  // Compute final weighted score
  const rawScore = factors.reduce((sum, f) => sum + f.contribution, 0);
  const score = Math.round(rawScore * 1000) / 1000; // 3 decimal places

  // Confidence based on how much data we have
  let confidence: "high" | "medium" | "low" = "medium";
  if (input.customerTenure !== undefined && input.paymentMethod) {
    confidence = "high";
  } else if (!input.paymentMethod && input.customerTenure === undefined) {
    confidence = "low";
  }

  // Timing hint
  const timingHint = computeTimingHint(input);

  return { score, confidence, timingHint, factors };
}

// Payday-Aware Timing Heuristics

function computeTimingHint(input: RecoverabilityInput): TimingHint {
  const now = new Date();
  // IST offset: UTC+5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  const dayOfMonth = istNow.getDate();
  const dayOfWeek = istNow.getDay(); // 0 = Sunday

  const isPaydayWindow = false; // DISABLED FOR TESTING
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  let suggestedDelayHours: number = 0;
  let reason: string;

  // Quiet hours enforcement
  const quietHoursEnd = 9;
  const isQuietHours = false; // DISABLED FOR TESTING
  if (isQuietHours) {
    reason = `Quiet hours (21:00-09:00 IST) active — deferred to ${quietHoursEnd}:05 AM IST`;
  }
  // Immediate retry for transient network failures
  else if (input.category === "soft_decline_network" && input.retryCount === 0) {
    suggestedDelayHours = 0.25; // 15 minutes
    reason = "Transient network failure — immediate smart retry recommended";
  }
  // Insufficient funds: wait for payday if not in payday window
  else if (input.category === "soft_decline_funds" && !isPaydayWindow) {
    const daysUntilPayday = dayOfMonth <= 28 ? (28 - dayOfMonth + 1) : 1;
    suggestedDelayHours = Math.min(daysUntilPayday * 24, 168); // Cap at 7 days
    reason = `Insufficient funds — timing for payday window (1st-7th). ~${daysUntilPayday} days`;
  }
  // Weekend: defer to Monday morning
  else if (isWeekend && input.category !== "soft_decline_network") {
    const daysUntilMonday = dayOfWeek === 0 ? 1 : 2;
    suggestedDelayHours = daysUntilMonday * 24;
    reason = `Weekend detected — deferred to Monday ${9}:30 AM IST`;
  }
  // Standard retry escalation based on attempt count
  else {
    const baseDelays = [0.5, 4, 12, 24, 48]; // hours per retry attempt
    suggestedDelayHours = baseDelays[Math.min(input.retryCount, baseDelays.length - 1)];
    reason = `Standard retry escalation — attempt #${input.retryCount + 1}`;
  }

  return {
    suggestedDelayHours: Math.round(suggestedDelayHours * 100) / 100,
    reason,
    isPaydayWindow,
    isWeekend,
    quietHoursBlocked: isQuietHours,
  };
}

// 3. TASK 3.3: LLM Diagnosis Fallback for Unknown Codes

export interface LLMDiagnosisResult {
  category: FailureCategory;
  subcategory: string;
  isTransient: boolean;
  reasoning: string;
  source: "llm" | "llm_fallback_rule";
}

/**
 * Build the LLM prompt for diagnosing an unknown error code.
 */
export function buildDiagnosisPrompt(errorCode: string, rawPayload: Record<string, any>): string {
  return `You are a payment failure diagnosis engine for an Indian SaaS revenue recovery system integrated with Razorpay.

Classify this payment failure into exactly ONE of these categories:
- soft_decline_funds: Temporary issue with customer's balance/limit
- soft_decline_network: Temporary network/gateway/timeout issue
- hard_decline_card: Permanent card problem (expired, stolen, invalid)
- hard_decline_account: Permanent account problem (closed, invalid)
- mandate_failure: e-Mandate/NACH debit failure
- authentication_failure: 3DS/OTP/AFA verification failure
- fraud_block: Fraud detection or risk assessment block
- abandoned_checkout: Customer left checkout without completing payment
- invoice_overdue: Invoice past due date

Error code: "${errorCode}"
Raw payload excerpt: ${JSON.stringify(rawPayload).slice(0, 500)}

Respond in STRICT JSON format only:
{
  "category": "<one of the categories above>",
  "subcategory": "<brief 2-3 word subcategory>",
  "isTransient": <true if retry may help, false if permanent>,
  "reasoning": "<1 sentence explanation>"
}`;
}

/**
 * Parse LLM response. If parsing fails, return a rule-based fallback.
 */
export function parseLLMDiagnosis(
  llmResponse: string,
  fallbackErrorCode: string
): LLMDiagnosisResult {
  try {
    // Try to extract JSON from the response
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in LLM response");

    const parsed = JSON.parse(jsonMatch[0]);

    const validCategories: FailureCategory[] = [
      "soft_decline_funds", "soft_decline_network", "hard_decline_card",
      "hard_decline_account", "mandate_failure", "authentication_failure",
      "fraud_block", "abandoned_checkout", "invoice_overdue",
    ];

    if (!validCategories.includes(parsed.category)) {
      throw new Error(`Invalid category: ${parsed.category}`);
    }

    return {
      category: parsed.category,
      subcategory: parsed.subcategory || "unspecified",
      isTransient: !!parsed.isTransient,
      reasoning: parsed.reasoning || "LLM classification",
      source: "llm",
    };
  } catch {
    // Fallback: use heuristic rules for unknown codes
    return applyFallbackRules(fallbackErrorCode);
  }
}

/**
 * Deterministic fallback when LLM is unavailable or fails.
 * Uses keyword heuristics on the error code string itself.
 */
export function applyFallbackRules(errorCode: string): LLMDiagnosisResult {
  const code = errorCode.toUpperCase();

  if (code.includes("FUND") || code.includes("BALANCE") || code.includes("LIMIT")) {
    return { category: "soft_decline_funds", subcategory: "funds_related", isTransient: true, reasoning: "Error code contains funds/balance keyword", source: "llm_fallback_rule" };
  }
  if (code.includes("TIMEOUT") || code.includes("GATEWAY") || code.includes("NETWORK") || code.includes("SERVER")) {
    return { category: "soft_decline_network", subcategory: "network_related", isTransient: true, reasoning: "Error code contains network/timeout keyword", source: "llm_fallback_rule" };
  }
  if (code.includes("CARD") || code.includes("EXPIR") || code.includes("CVV")) {
    return { category: "hard_decline_card", subcategory: "card_related", isTransient: false, reasoning: "Error code contains card-related keyword", source: "llm_fallback_rule" };
  }
  if (code.includes("MANDATE") || code.includes("NACH") || code.includes("DEBIT")) {
    return { category: "mandate_failure", subcategory: "mandate_related", isTransient: true, reasoning: "Error code contains mandate keyword", source: "llm_fallback_rule" };
  }
  if (code.includes("AUTH") || code.includes("OTP") || code.includes("3DS") || code.includes("AFA")) {
    return { category: "authentication_failure", subcategory: "auth_related", isTransient: true, reasoning: "Error code contains authentication keyword", source: "llm_fallback_rule" };
  }
  if (code.includes("FRAUD") || code.includes("RISK") || code.includes("SUSPICIOUS")) {
    return { category: "fraud_block", subcategory: "fraud_related", isTransient: false, reasoning: "Error code contains fraud keyword", source: "llm_fallback_rule" };
  }
  if (code.includes("BANK") || code.includes("ACCOUNT") || code.includes("DECLINED")) {
    return { category: "hard_decline_account", subcategory: "bank_related", isTransient: false, reasoning: "Error code contains bank/account keyword", source: "llm_fallback_rule" };
  }

  // True unknown — classify as unknown with low confidence
  return {
    category: "unknown",
    subcategory: "unclassified",
    isTransient: true, // Assume transient (safer — allows retry)
    reasoning: `No taxonomy match or keyword match for: ${errorCode}`,
    source: "llm_fallback_rule",
  };
}

// 4. TASK 3.4: DiagnosisService — Full Pipeline Orchestrator
//    Consumes risk events → classifies → scores → publishes diagnosed events

export interface DiagnosisResult {
  caseId: string;
  errorCode: string;
  taxonomy: TaxonomyEntry;
  diagnosisSource: "taxonomy" | "llm" | "llm_fallback_rule";
  recoverability: RecoverabilityResult;
  diagnosedAt: string;
  llmReasoning?: string;
}

export interface DiagnosisServiceStats {
  totalDiagnosed: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  avgRecoverabilityScore: number;
  lastDiagnosedAt: string | null;
}

export class DiagnosisService {
  private diagnosisLog: DiagnosisResult[] = [];
  private maxLogSize: number;
  private stats: DiagnosisServiceStats = {
    totalDiagnosed: 0,
    byCategory: {},
    bySource: { taxonomy: 0, llm: 0, llm_fallback_rule: 0 },
    avgRecoverabilityScore: 0,
    lastDiagnosedAt: null,
  };

  // Optional LLM call function (injected from outside to keep this module dependency-free)
  private llmCall?: (prompt: string) => Promise<string>;

  constructor(maxLogSize: number = 200, llmCall?: (prompt: string) => Promise<string>) {
    this.maxLogSize = maxLogSize;
    this.llmCall = llmCall;
  }

  /**
   * Full diagnosis pipeline for a risk event.
   */
  async diagnose(params: {
    caseId: string;
    errorCode: string;
    amount: number;
    retryCount: number;
    paymentMethod?: string;
    hoursSinceFailure: number;
    customerTenure?: number;
    previousRecoveries?: number;
    isSubscription?: boolean;
    rawPayload?: Record<string, any>;
  }): Promise<DiagnosisResult> {
    const { caseId, errorCode, rawPayload } = params;

    // Step 1: Try taxonomy classification
    let taxonomy = classifyErrorCode(errorCode);
    let diagnosisSource: "taxonomy" | "llm" | "llm_fallback_rule" = "taxonomy";
    let llmReasoning: string | undefined;

    if (!taxonomy) {
      // Step 2: Unknown code → try LLM fallback
      let llmResult: LLMDiagnosisResult;

      if (this.llmCall) {
        try {
          const prompt = buildDiagnosisPrompt(errorCode, rawPayload || {});
          const response = await this.llmCall(prompt);
          llmResult = parseLLMDiagnosis(response, errorCode);
        } catch {
          // LLM call failed → deterministic fallback
          llmResult = applyFallbackRules(errorCode);
        }
      } else {
        // No LLM configured → deterministic fallback
        llmResult = applyFallbackRules(errorCode);
      }

      diagnosisSource = llmResult.source;
      llmReasoning = llmResult.reasoning;

      taxonomy = {
        category: llmResult.category,
        subcategory: llmResult.subcategory,
        isTransient: llmResult.isTransient,
        urgency: llmResult.isTransient ? "standard" : "deferred",
        suggestedChannels: llmResult.isTransient ? ["whatsapp", "email"] : ["email"],
      };
    }

    // Step 3: Compute recoverability score
    const recoverability = scoreRecoverability({
      category: taxonomy.category,
      amount: params.amount,
      retryCount: params.retryCount,
      paymentMethod: params.paymentMethod,
      hoursSinceFailure: params.hoursSinceFailure,
      customerTenure: params.customerTenure,
      previousRecoveries: params.previousRecoveries,
      isSubscription: params.isSubscription,
    });

    const result: DiagnosisResult = {
      caseId,
      errorCode,
      taxonomy,
      diagnosisSource,
      recoverability,
      diagnosedAt: new Date().toISOString(),
      llmReasoning,
    };

    // Store in log
    this.diagnosisLog.unshift(result);
    if (this.diagnosisLog.length > this.maxLogSize) {
      this.diagnosisLog.pop();
    }

    // Update stats
    this.updateStats(result);

    return result;
  }

  private updateStats(result: DiagnosisResult): void {
    this.stats.totalDiagnosed++;
    this.stats.lastDiagnosedAt = result.diagnosedAt;

    const cat = result.taxonomy.category;
    this.stats.byCategory[cat] = (this.stats.byCategory[cat] || 0) + 1;
    this.stats.bySource[result.diagnosisSource] = (this.stats.bySource[result.diagnosisSource] || 0) + 1;

    // Running average of recoverability score
    const n = this.stats.totalDiagnosed;
    this.stats.avgRecoverabilityScore =
      ((this.stats.avgRecoverabilityScore * (n - 1)) + result.recoverability.score) / n;
    this.stats.avgRecoverabilityScore = Math.round(this.stats.avgRecoverabilityScore * 1000) / 1000;
  }

  /** Get recent diagnosis results */
  getResults(limit: number = 50): DiagnosisResult[] {
    return this.diagnosisLog.slice(0, limit);
  }

  /** Get aggregated stats */
  getStats(): DiagnosisServiceStats {
    return { ...this.stats };
  }

  /** Set the LLM call function (for late binding) */
  setLLMCall(fn: (prompt: string) => Promise<string>): void {
    this.llmCall = fn;
  }
}
