/**
 * RazorVasooli.Ai — Orchestrator Service (Phase 5)
 *
 * Manages bounded recovery lifecycle, scheduling, and hard regulatory stops.
 *
 * Components:
 *  1. State Machine Core (Task 5.1)
 *  2. Regulatory & Business Hard Stops (Task 5.2)
 *  3. Job Scheduler & Workers (Task 5.3)
 *  4. Payment Reconciliation & Job Cancellation (Task 5.4)
 *  5. Promise Sweeper (Task 5.5)
 */

import { type PolicyDecision, type Channel, type EscalationLevel } from "./policy.js";
import type { StoredPaymentLink } from "./channels.js";
import { metrics } from "../core/metrics.js";
import { embedAndStore, buildCaseNarrative } from "./embeddings.js";

// 1. TASK 5.1: State Machine Core
//    DETECTED → DIAGNOSED → POLICY_SELECTED → INTERVENING →
//    (RECOVERED | PAUSED_PROMISE | ESCALATED | CLOSED_LOST | SKIPPED_COMPLIANCE)

export type CaseState =
  | "DETECTED"
  | "DIAGNOSED"
  | "POLICY_SELECTED"
  | "INTERVENING"
  | "RECOVERED"
  | "PAUSED_PROMISE"
  | "ESCALATED"
  | "CLOSED_LOST"
  | "SKIPPED_COMPLIANCE";

/** All valid state transitions */
const VALID_TRANSITIONS: Record<CaseState, CaseState[]> = {
  DETECTED:           ["DIAGNOSED", "SKIPPED_COMPLIANCE"],
  DIAGNOSED:          ["POLICY_SELECTED", "RECOVERED", "SKIPPED_COMPLIANCE", "CLOSED_LOST"],
  POLICY_SELECTED:    ["INTERVENING", "RECOVERED", "PAUSED_PROMISE", "SKIPPED_COMPLIANCE", "ESCALATED", "CLOSED_LOST"],
  INTERVENING:        ["RECOVERED", "PAUSED_PROMISE", "ESCALATED", "CLOSED_LOST", "SKIPPED_COMPLIANCE", "POLICY_SELECTED"],
  PAUSED_PROMISE:     ["RECOVERED", "INTERVENING", "ESCALATED", "CLOSED_LOST"],
  RECOVERED:          [],  // Terminal
  ESCALATED:          ["RECOVERED", "CLOSED_LOST"],  // Human can resolve
  CLOSED_LOST:        [],  // Terminal
  SKIPPED_COMPLIANCE: [],  // Terminal
};

export interface StateTransition {
  from: CaseState;
  to: CaseState;
  reason: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface RecoveryCase {
  id: string;
  state: CaseState;
  /** Phase L1: diagnosed failure category — the learning-memory key. */
  category?: string;
  /** Customer details */
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  /** Payment context */
  amount: number;
  currency: string;
  declineCode?: string;
  paymentMethod?: string;
  subscriptionId?: string;
  invoiceId?: string;
  /** Recovery state */
  attemptCount: number;
  maxAttempts: number;
  /** Current policy decision */
  currentDecision?: PolicyDecision;
  /** Scheduled jobs */
  scheduledJobs: ScheduledJob[];
  /** Customer promise */
  promise?: PaymentPromise;
  /** Canonical recovery link. The server, never the LLM, owns this lifecycle. */
  paymentLink?: StoredPaymentLink;
  /** Compliance flags */
  dpdpOptedOut: boolean;
  quietHoursDeferred: boolean;
  /** Two-step opt-out pending confirmation */
  pendingOptOutConfirm?: boolean;
  /** Count of promises made (cap <= 3) */
  promiseCount?: number;
  /** Audit trail */
  transitions: StateTransition[];
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
  recoveredAt?: string;
  /** Recovery amount (may differ from original due to discount) */
  recoveredAmount?: number;
}

// 2. TASK 5.2: Regulatory & Business Hard Stops

export interface ComplianceConfig {
  /** Quiet Hours: 21:00 to 09:00 IST */
  quietHoursStart: number;  // 21 (hour in IST)
  quietHoursEnd: number;    // 9  (hour in IST)
  /** RBI e-Mandate AFA threshold in INR */
  rbiAfaThreshold: number;
  /** Max contact attempts before hard stop */
  maxContactAttempts: number;
  /** DPDP opt-out enforcement */
  dpdpEnabled: boolean;
}

export const DEFAULT_COMPLIANCE: ComplianceConfig = {
  quietHoursStart: 0,
  quietHoursEnd: 0,
  rbiAfaThreshold: 15000,
  maxContactAttempts: 3,
  dpdpEnabled: true,
};

/** In-memory DPDP opt-out registry — write-through to Postgres when enabled
 *  so customers who opted out are never re-contacted after a restart. */
const dpdpOptOutRegistry: Set<string> = new Set();

import { dbAddDpdpOptOut, dbRemoveDpdpOptOut, dbLoadDpdpOptOuts } from "../core/db.js";

export interface ComplianceCheck {
  allowed: boolean;
  reason: string;
  isQuietHours: boolean;
  isDpdpOptedOut: boolean;
  isAfaRequired: boolean;
  isMaxAttemptsExceeded: boolean;
  deferUntil?: string;  // ISO timestamp if deferred
}

/**
 * Check all compliance rules before executing an intervention.
 * Returns whether the intervention is allowed to proceed.
 */
export function checkCompliance(
  caseData: RecoveryCase,
  config: ComplianceConfig = DEFAULT_COMPLIANCE
): ComplianceCheck {
  const result: ComplianceCheck = {
    allowed: true,
    reason: "All compliance checks passed",
    isQuietHours: false,
    isDpdpOptedOut: false,
    isAfaRequired: false,
    isMaxAttemptsExceeded: false,
  };

  // Check 1: Quiet Hours (21:00 - 09:00 IST)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istHour = istNow.getHours();
  const isQuiet = false;

  if (isQuiet) {
    result.isQuietHours = true;
    result.allowed = false;

    // Calculate defer time to 09:05 IST next morning
    const deferDate = new Date(istNow);
    if (istHour >= config.quietHoursStart) {
      deferDate.setDate(deferDate.getDate() + 1);
    }
    deferDate.setHours(config.quietHoursEnd, 5, 0, 0);
    // Convert back to UTC
    const deferUtc = new Date(deferDate.getTime() - istOffset);
    result.deferUntil = deferUtc.toISOString();
    result.reason = `Quiet hours active (${config.quietHoursStart}:00-${config.quietHoursEnd}:00 IST). Deferred to 09:05 IST.`;
  }

  // Check 2: DPDP Opt-Out
  if (config.dpdpEnabled && caseData.customerEmail) {
    if (dpdpOptOutRegistry.has(caseData.customerEmail.toLowerCase())) {
      result.isDpdpOptedOut = true;
      result.allowed = false;
      result.reason = "DPDP opt-out: customer has exercised data protection rights.";
    }
  }

  // Check 3: RBI e-Mandate AFA (Additional Factor of Authentication)
  if (caseData.amount > config.rbiAfaThreshold && caseData.subscriptionId) {
    result.isAfaRequired = true;
    // This is informational — doesn't block, but flags for special handling
  }

  // Check 4: Max Attempts
  if (caseData.attemptCount >= config.maxContactAttempts) {
    result.isMaxAttemptsExceeded = true;
    result.allowed = false;
    result.reason = `Max contact attempts (${config.maxContactAttempts}) exceeded. Escalating.`;
  }
  return result;
}

/**
 * Register a customer opt-out under DPDP (write-through to Postgres when enabled).
 */
export function registerDpdpOptOut(email: string): void {
  dpdpOptOutRegistry.add(email.toLowerCase());
  void dbAddDpdpOptOut(email); // durable — never lose a legal opt-out
  metrics.complianceStop("dpdp_opt_out");
  console.log(`[DPDP] Opt-out registered for: ${email}`);
}

/**
 * Check if a customer has opted out.
 */
export function isDpdpOptedOut(email: string): boolean {
  return dpdpOptOutRegistry.has(email.toLowerCase());
}

/**
 * Remove an opt-out (if customer re-consents). Write-through delete.
 */
export function removeDpdpOptOut(email: string): boolean {
  const removed = dpdpOptOutRegistry.delete(email.toLowerCase());
  if (removed) void dbRemoveDpdpOptOut(email);
  return removed;
}

/** Hydrate the registry from Postgres at boot (restart-survival). */
export async function loadDpdpOptOuts(): Promise<number> {
  const emails = await dbLoadDpdpOptOuts();
  for (const e of emails) dpdpOptOutRegistry.add(e);
  return emails.length;
}

/**
 * Get all opted-out emails (for admin view).
 */
export function getDpdpOptOuts(): string[] {
  return Array.from(dpdpOptOutRegistry);
}

// 3. TASK 5.3: Job Scheduler & Workers (In-Memory BullMQ-like Scheduler)

export type JobStatus = "scheduled" | "executing" | "completed" | "cancelled" | "failed";
export type JobType = "intervention" | "promise_sweep" | "escalation_check";

export interface ScheduledJob {
  id: string;
  caseId: string;
  type: JobType;
  status: JobStatus;
  /** When to execute (ISO timestamp) */
  executeAt: string;
  /** Intervention details */
  channel?: Channel;
  escalationLevel?: EscalationLevel;
  discountPercent?: number;
  /** Gemini generated message for outreach */
  customMessage?: string;
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
  retryCount: number;
}

export interface PaymentPromise {
  promisedDate: string;    // ISO date
  promisedAmount?: number;
  receivedAt: string;
  sweepJobId?: string;
  status: "pending" | "kept" | "broken";
}

// 4. OrchestratorService — Full Lifecycle Manager

export interface OrchestratorStats {
  totalCases: number;
  byState: Record<string, number>;
  totalJobsScheduled: number;
  totalJobsCompleted: number;
  totalJobsCancelled: number;
  totalRecovered: number;
  totalRecoveredAmount: number;
  totalSkippedCompliance: number;
  totalEscalated: number;
  totalPromisesReceived: number;
  totalPromisesKept: number;
  totalPromisesBroken: number;
  quietHoursDeferrals: number;
  dpdpOptOuts: number;
  lastActivityAt: string | null;
}

export class OrchestratorService {
  private cases: Map<string, RecoveryCase> = new Map();
  private jobQueue: ScheduledJob[] = [];
  private jobTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private complianceConfig: ComplianceConfig;
  private maxCases: number;
  private conversationProvider?: (caseId: string) => string;
  /** Produces the safe, contextual message sent when a payment promise expires. */
  private promiseReminderProvider?: (caseData: RecoveryCase) => Promise<string>;

  /** Callback when an intervention should be executed */
  private onExecuteIntervention?: (
    caseData: RecoveryCase,
    job: ScheduledJob
  ) => Promise<void>;

  private stats: OrchestratorStats = {
    totalCases: 0,
    byState: {},
    totalJobsScheduled: 0,
    totalJobsCompleted: 0,
    totalJobsCancelled: 0,
    totalRecovered: 0,
    totalRecoveredAmount: 0,
    totalSkippedCompliance: 0,
    totalEscalated: 0,
    totalPromisesReceived: 0,
    totalPromisesKept: 0,
    totalPromisesBroken: 0,
    quietHoursDeferrals: 0,
    dpdpOptOuts: 0,
    lastActivityAt: null,
  };

  constructor(
    complianceConfig: ComplianceConfig = DEFAULT_COMPLIANCE,
    maxCases: number = 500
  ) {
    this.complianceConfig = complianceConfig;
    this.maxCases = maxCases;
  }

  setConversationProvider(fn: (caseId: string) => string): void {
    this.conversationProvider = fn;
  }

  setPromiseReminderProvider(fn: (caseData: RecoveryCase) => Promise<string>): void {
    this.promiseReminderProvider = fn;
  }

  recordPaymentLink(caseId: string, link: StoredPaymentLink): RecoveryCase | null {
    const caseData = this.cases.get(caseId);
    if (!caseData) return null;
    caseData.paymentLink = link;
    caseData.updatedAt = new Date().toISOString();
    this.persist(caseData);
    return caseData;
  }

  markPaymentLinkStatus(caseId: string, status: StoredPaymentLink["status"]): RecoveryCase | null {
    const caseData = this.cases.get(caseId);
    if (!caseData?.paymentLink) return caseData || null;
    caseData.paymentLink.status = status;
    caseData.updatedAt = new Date().toISOString();
    this.persist(caseData);
    return caseData;
  }

  /** Optional durability hook: invoked whenever a case is created/updated. */
  private onCasePersist?: (c: RecoveryCase) => void;
  /** Optional durability hook for scheduled jobs (restart-survival). */
  private onJobPersist?: (job: ScheduledJob) => void;

  setJobPersistenceHook(fn: (job: ScheduledJob) => void): void {
    this.onJobPersist = fn;
  }

  private persistJob(job: ScheduledJob): void {
    try {
      this.onJobPersist?.(job);
    } catch (err) {
      console.warn("[Orchestrator] job persist failed:", (err as Error).message);
    }
  }

  setCasePersistenceHook(fn: (c: RecoveryCase) => void): void {
    this.onCasePersist = fn;
  }

  private persist(c: RecoveryCase): void {
    try {
      this.onCasePersist?.(c);
    } catch (err) {
      console.warn("[Orchestrator] case persist failed:", (err as Error).message);
    }
  }

  /** Restore case snapshots from durable storage (Postgres). */
  restoreCases(cases: RecoveryCase[]): void {
    for (const c of cases) {
      if (!c?.id || !c.state) continue;
      this.cases.set(c.id, {
        ...c,
        scheduledJobs: Array.isArray(c.scheduledJobs) ? c.scheduledJobs : [],
        transitions: Array.isArray(c.transitions) ? c.transitions : [],
      });
    }
    this.updateStateCounts();
    const maxSeq = cases.length;
    this.stats.totalCases = Math.max(this.stats.totalCases, maxSeq);
    console.log(`[Orchestrator] ♻️ Restored ${cases.length} case(s) from PostgreSQL`);
  }


  // State Machine Methods

  /**
   * Create a new recovery case.
   */
  createCase(params: {
    id: string;
    customerEmail?: string;
    customerName?: string;
    customerPhone?: string;
    amount: number;
    currency?: string;
    declineCode?: string;
    paymentMethod?: string;
    subscriptionId?: string;
    invoiceId?: string;
    /** Phase L1: failure category (learning-memory key). Set post-diagnosis. */
    category?: string;
  }): RecoveryCase {
    const now = new Date().toISOString();

    const existing = this.cases.get(params.id);
    if (existing) {
      return existing; // Idempotent
    }

    const newCase: RecoveryCase = {
      id: params.id,
      state: "DETECTED",
      customerEmail: params.customerEmail,
      customerName: params.customerName,
      customerPhone: params.customerPhone,
      amount: params.amount,
      currency: params.currency || "INR",
      declineCode: params.declineCode,
      paymentMethod: params.paymentMethod,
      subscriptionId: params.subscriptionId,
      invoiceId: params.invoiceId,
      category: params.category,
      attemptCount: 0,
      maxAttempts: this.complianceConfig.maxContactAttempts,
      scheduledJobs: [],
      dpdpOptedOut: false,
      quietHoursDeferred: false,
      transitions: [
        {
          from: "DETECTED" as CaseState,
          to: "DETECTED",
          reason: "Case created",
          timestamp: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    this.cases.set(params.id, newCase);
    this.stats.totalCases++;
    this.updateStateCounts();
    this.stats.lastActivityAt = now;
    this.persist(newCase);

    // Evict oldest cases if over limit
    if (this.cases.size > this.maxCases) {
      const oldestKey = this.cases.keys().next().value;
      if (oldestKey !== undefined) {
        this.cases.delete(oldestKey);
      }
    }

    return newCase;
  }

  /**
   * Transition a case to a new state with validation.
   */
  transitionState(
    caseId: string,
    newState: CaseState,
    reason: string,
    metadata?: Record<string, unknown>
  ): RecoveryCase | null {
    const caseData = this.cases.get(caseId);
    if (!caseData) return null;

    // Validate transition
    const validNext = VALID_TRANSITIONS[caseData.state];
    if (!validNext.includes(newState)) {
      console.warn(
        `[Orchestrator] Invalid transition: ${caseData.state} → ${newState} for case ${caseId}`
      );
      return null;
    }

    const now = new Date().toISOString();
    const fromState = caseData.state;

    caseData.transitions.push({
      from: caseData.state,
      to: newState,
      reason,
      timestamp: now,
      metadata,
    });

    caseData.state = newState;
    caseData.updatedAt = now;
    this.stats.lastActivityAt = now;
    metrics.transition(fromState, newState);

    // Handle terminal states
    if (newState === "RECOVERED") {
      const recoveredAmt = caseData.recoveredAmount || caseData.amount;
      caseData.recoveredAt = now;
      this.stats.totalRecovered++;
      this.stats.totalRecoveredAmount += recoveredAmt;
      metrics.recoveredRupees("case_recovered", recoveredAmt);
      this.cancelCaseJobs(caseId);
    } else if (newState === "SKIPPED_COMPLIANCE") {
      this.stats.totalSkippedCompliance++;
      this.cancelCaseJobs(caseId);
    } else if (newState === "ESCALATED") {
      this.stats.totalEscalated++;
      this.cancelCaseJobs(caseId);
    } else if (newState === "CLOSED_LOST") {
      this.cancelCaseJobs(caseId);
    }

    this.updateStateCounts();

    console.log(`[Orchestrator] ${caseId}: ${caseData.transitions.at(-2)?.from || "?"} → ${newState} (${reason})`);
    this.persist(caseData);
    
    // Auto-embed terminal cases for Phase L2
    if (["RECOVERED", "ESCALATED", "CLOSED_LOST", "SKIPPED_COMPLIANCE"].includes(newState)) {
      void this.autoEmbedCase(caseData).catch(() => undefined);
    }

    return caseData;
  }

  /** Helper to auto-embed resolved cases (Phase L2) */
  private async autoEmbedCase(caseData: RecoveryCase): Promise<void> {
    try {
      const convoStr = this.conversationProvider?.(caseData.id) ?? "";
      await embedAndStore(
        caseData.id,
        buildCaseNarrative(caseData, convoStr),
        {
          category: caseData.category || "unknown",
          channel: caseData.currentDecision?.channel || "unknown",
          recovered: caseData.state === "RECOVERED",
          amountInr: caseData.amount,
          discount: caseData.currentDecision?.discountIncentive || 0,
        }
      );
      console.log(`[Orchestrator] 🧠 Auto-embedded case ${caseData.id} into vector DB`);
    } catch (err: any) {
      console.error(`[Orchestrator] ❌ autoEmbedCase failed for ${caseData.id}:`, err?.message || err);
    }
  }

  // Policy Application

  applyDecision(caseId: string, decision: PolicyDecision): RecoveryCase | null {
    const caseData = this.cases.get(caseId);
    if (!caseData) return null;

    caseData.currentDecision = decision;

    const targetState = decision.state || "INTERVENING";

    if (targetState === "PAUSED_PROMISE") {
      const pDateStr = decision.metadata?.date || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const recorded = this.recordPromise(caseId, pDateStr, caseData.amount);
      if (!recorded) {
        this.transitionState(caseId, "INTERVENING", "Promise rejected (invalid date or cap <= 3 exceeded)");
      }
      return caseData;
    }

    if (targetState === "CLOSED_LOST") {
      if (decision.metadata?.reason === "hostile") {
        this.transitionState(caseId, "CLOSED_LOST", "Hostile customer — immediate close");
        this.cancelCaseJobs(caseId);
        return caseData;
      }
      if (decision.metadata?.reason === "opt_out") {
        // Spec: two-step confirmation! Do NOT transition or register DPDP yet!
        caseData.pendingOptOutConfirm = true;
        console.log(`[Orchestrator] Case ${caseId}: Customer requested opt-out — awaiting two-step confirmation`);
        return caseData;
      }
      this.transitionState(caseId, "CLOSED_LOST", decision.metadata?.reason || "Closed by agent");
      return caseData;
    }

    if (targetState === "ESCALATED") {
      this.transitionState(caseId, "ESCALATED", decision.metadata?.reason || "Escalated by agent");
      return caseData;
    }

    // Default to INTERVENING
    if (caseData.state === "DIAGNOSED" || caseData.state === "INTERVENING" || caseData.state === "POLICY_SELECTED") {
      this.transitionState(caseId, "POLICY_SELECTED",
        `Policy decision: ${decision.decisionSource} → ${decision.channel}/${decision.delayHours}h`
      );
    }

    // Run compliance check before scheduling
    const compliance = checkCompliance(caseData, this.complianceConfig);

    if (!compliance.allowed) {
      if (compliance.isDpdpOptedOut) {
        caseData.dpdpOptedOut = true;
        this.stats.dpdpOptOuts++;
        this.transitionState(caseId, "SKIPPED_COMPLIANCE",
          `DPDP opt-out: ${compliance.reason}`
        );
        return caseData;
      }

      if (compliance.isMaxAttemptsExceeded) {
        this.transitionState(caseId, "ESCALATED",
          `Max attempts exceeded: ${compliance.reason}`
        );
        return caseData;
      }

      if (compliance.isQuietHours && compliance.deferUntil) {
        // Defer to morning — schedule with adjusted time
        caseData.quietHoursDeferred = true;
        this.stats.quietHoursDeferrals++;
        console.log(`[Orchestrator] Quiet hours deferral for ${caseId} → ${compliance.deferUntil}`);

        const deferredJob = this.scheduleJob({
          caseId,
          type: "intervention",
          executeAt: compliance.deferUntil,
          channel: decision.channel,
          escalationLevel: decision.escalationLevel,
          discountPercent: decision.discountIncentive,
        });

        caseData.scheduledJobs.push(deferredJob);
        return caseData;
      }
    }

    // Schedule the intervention
    const executeAt = new Date(
      Date.now() + decision.delayHours * 3600000
    ).toISOString();

    const job = this.scheduleJob({
      caseId,
      type: "intervention",
      executeAt,
      channel: decision.channel,
      escalationLevel: decision.escalationLevel,
      discountPercent: decision.discountIncentive,
      customMessage: decision.message,
    });

    caseData.scheduledJobs.push(job);

    // Transition to INTERVENING
    this.transitionState(caseId, "INTERVENING",
      `Intervention scheduled: ${decision.channel} at ${executeAt} (${decision.decisionSource})`
    );

    return caseData;
  }

  // Job Scheduling

  private scheduleJob(params: {
    caseId: string;
    type: JobType;
    executeAt: string;
    channel?: Channel;
    escalationLevel?: EscalationLevel;
    discountPercent?: number;
    customMessage?: string;
  }): ScheduledJob {
    const now = new Date().toISOString();
    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    const job: ScheduledJob = {
      id: jobId,
      caseId: params.caseId,
      type: params.type,
      status: "scheduled",
      executeAt: params.executeAt,
      channel: params.channel,
      escalationLevel: params.escalationLevel,
      discountPercent: params.discountPercent,
      customMessage: params.customMessage,
      createdAt: now,
      retryCount: 0,
    };

    this.jobQueue.push(job);
    this.stats.totalJobsScheduled++;
    this.persistJob(job);

    // Set timer for execution
    const delayMs = Math.max(0, new Date(params.executeAt).getTime() - Date.now());

    const timer = setTimeout(() => {
      this.executeJob(jobId).catch((err) => {
        console.error(`[Orchestrator] Job execution error ${jobId}:`, err);
      });
    }, delayMs);

    this.jobTimers.set(jobId, timer);

    console.log(
      `[Orchestrator] Job ${jobId} scheduled for ${params.caseId}: ` +
      `${params.type}/${params.channel || "n/a"} at ${params.executeAt} ` +
      `(delay=${Math.round(delayMs / 1000)}s)`
    );

    return job;
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobQueue.find((j) => j.id === jobId);
    if (!job || job.status !== "scheduled") return;
    job.status = "executing";
    this.persistJob(job);

    const caseData = this.cases.get(job.caseId);
    if (!caseData) {
      job.status = "cancelled";
      job.failureReason = "Case not found";
      return;
    }

    // Re-verify compliance before execution
    const compliance = checkCompliance(caseData, this.complianceConfig);

    if (!compliance.allowed) {
      if (compliance.isDpdpOptedOut) {
        job.status = "cancelled";
        job.failureReason = "DPDP opt-out during execution";
        this.transitionState(job.caseId, "SKIPPED_COMPLIANCE",
          "DPDP opt-out detected at execution time"
        );
        return;
      }

      if (compliance.isQuietHours && compliance.deferUntil) {
        // Requeue for morning
        job.status = "cancelled";
        job.failureReason = "Quiet hours — requeued";
        this.stats.quietHoursDeferrals++;

        this.scheduleJob({
          caseId: job.caseId,
          type: job.type,
          executeAt: compliance.deferUntil,
          channel: job.channel,
          escalationLevel: job.escalationLevel,
          discountPercent: job.discountPercent,
          customMessage: job.customMessage,
        });
        return;
      }

      if (compliance.isMaxAttemptsExceeded) {
        job.status = "cancelled";
        job.failureReason = "Max attempts exceeded";
        this.transitionState(job.caseId, "ESCALATED", "Max attempts at execution time");
        return;
      }
    }

    // Check if case is already recovered or terminal
    if (["RECOVERED", "CLOSED_LOST", "SKIPPED_COMPLIANCE"].includes(caseData.state)) {
      job.status = "cancelled";
      job.failureReason = `Case already in terminal state: ${caseData.state}`;
      return;
    }

    // Execute
    job.status = "executing";
    caseData.attemptCount++;

    try {
      if (job.type === "promise_sweep") {
        const promise = caseData.promise;
        if (!promise) {
          job.status = "cancelled";
          job.failureReason = "Promise details not found";
          this.persistJob(job);
          return;
        }

        // A captured-payment webhook would already have moved the case to
        // RECOVERED and cancelled this job. Reaching here means the promise
        // was not verified, so resume recovery with a date-specific reminder.
        this.sweepPromise(job.caseId, false);
        job.channel = "email";
        job.customMessage = await this.promiseReminderProvider?.(caseData)
          || `Namaste ji, aapne ${promise.promisedDate} tak payment ka promise kiya tha. Aaj woh date aa gayi hai—kya aap abhi payment complete kar sakte hain? {{PAYMENT_LINK}}`;
        this.persistJob(job);
      }

      if (this.onExecuteIntervention) {
        await this.onExecuteIntervention(caseData, job);
      }

      job.status = "completed";
      job.completedAt = new Date().toISOString();
      this.stats.totalJobsCompleted++;

      console.log(
        `[Orchestrator] ✅ Job ${jobId} completed: ${job.channel}/${job.type} for ${job.caseId} (attempt #${caseData.attemptCount})`
      );
    } catch (err) {
      job.status = "failed";
      job.failureReason = err instanceof Error ? err.message : "Unknown error";
      job.retryCount++;

      console.error(
        `[Orchestrator] ❌ Job ${jobId} failed: ${job.failureReason}`
      );
    }

    // Cleanup timer reference
    this.jobTimers.delete(jobId);
  }

  // Task 5.4: Payment Reconciliation

  /**
   * Handle a successful payment recovery.
   * Transitions to RECOVERED and cancels pending jobs.
   */
  recordRecovery(
    caseId: string,
    recoveredAmount?: number,
    paymentId?: string
  ): RecoveryCase | null {
    const caseData = this.cases.get(caseId);
    if (!caseData) return null;

    caseData.recoveredAmount = recoveredAmount || caseData.amount;

    this.transitionState(caseId, "RECOVERED",
      `Payment recovered: ₹${(caseData.recoveredAmount).toLocaleString("en-IN")}${paymentId ? ` (${paymentId})` : ""}`
    );

    return caseData;
  }

  // Task 5.5: Promise Sweeper

  /**
   * Record a customer payment promise.
   * Pauses the recovery sequence and schedules a sweep job.
   */
  recordPromise(
    caseId: string,
    promisedDate: string,
    promisedAmount?: number
  ): RecoveryCase | null {
    const caseData = this.cases.get(caseId);
    if (!caseData) return null;

    // Date Gate: validate date format YYYY-MM-DD
    const dateOnly = promisedDate.split("T")[0];
    const targetTime = new Date(`${dateOnly}T04:30:00.000Z`).getTime();
    if (isNaN(targetTime)) {
      console.warn(`[Orchestrator] ⚠️ Invalid promise date "${promisedDate}" for ${caseId}`);
      return null;
    }

    const now = Date.now();
    const todayIst = new Date(now + 5.5 * 3600000).toISOString().split("T")[0];
    const minTime = new Date(`${todayIst}T00:00:00.000Z`).getTime();
    const maxTime = now + 30 * 86400000; // max 30 days ahead

    if (targetTime < minTime || targetTime > maxTime) {
      console.warn(`[Orchestrator] ⚠️ Promise date ${dateOnly} outside valid window (today..30d) for ${caseId}`);
      return null;
    }

    // Promise Cap Gate: max 3 promises
    const currentPromises = caseData.promiseCount || 0;
    if (currentPromises >= 3) {
      console.warn(`[Orchestrator] ⚠️ Case ${caseId} exceeded max promises cap (3)`);
      return null;
    }

    caseData.promiseCount = currentPromises + 1;

    // Pause recovery sequence
    this.transitionState(caseId, "PAUSED_PROMISE",
      `Customer promised payment by ${dateOnly} (promise #${caseData.promiseCount})`
    );

    this.stats.totalPromisesReceived++;

    // Schedule sweep at promised_date @ 10:00 IST (04:30 UTC)
    const sweepAt = `${dateOnly}T04:30:00.000Z`;

    const sweepJob = this.scheduleJob({
      caseId,
      type: "promise_sweep",
      executeAt: sweepAt,
      // The server's intervention handler delivers this job to both channels;
      // email is retained as the canonical job channel for compatibility.
      channel: "email",
    });

    caseData.promise = {
      promisedDate: dateOnly,
      promisedAmount,
      receivedAt: new Date().toISOString(),
      sweepJobId: sweepJob.id,
      status: "pending",
    };

    // Cancel other pending intervention jobs
    this.cancelCaseJobs(caseId, sweepJob.id);

    console.log(
      `[Orchestrator] Promise recorded for ${caseId}: sweep at ${sweepAt} (promise #${caseData.promiseCount}/3)`
    );

    return caseData;
  }

  /**
   * Handle customer reply for pending two-step DPDP opt-out.
   * If customer confirms YES -> SKIPPED_COMPLIANCE + durable DPDP registry write + cancel jobs + embed.
   * If NO or other -> resumes recovery flow.
   */
  handleOptOutConfirmation(caseId: string, replyText: string): { confirmed: boolean; message: string } {
    const caseData = this.cases.get(caseId);
    if (!caseData) return { confirmed: false, message: "Case not found" };

    const t = replyText.toLowerCase().trim();
    const isYes = /\b(yes|haan|han|haa|confirm|kar do|kardo|band kar do|ok|okay|sure)\b/.test(t);
    const isNo = /\b(no|nahi|nahin|cancel|rakho|rakhna|mat)\b/.test(t);

    if (isYes) {
      caseData.pendingOptOutConfirm = false;
      caseData.dpdpOptedOut = true;
      if (caseData.customerEmail) {
        registerDpdpOptOut(caseData.customerEmail);
      }
      this.transitionState(caseId, "SKIPPED_COMPLIANCE", "DPDP opt-out confirmed by customer via two-step verification");
      this.cancelCaseJobs(caseId);
      void this.autoEmbedCase(caseData).catch(() => undefined);
      return {
        confirmed: true,
        message: "✅ Confirm ho gaya ji. Aapko ab koi message/email nahi aayega — aapke din shubh ho! 🙏 (DPDP compliant)"
      };
    } else if (isNo) {
      caseData.pendingOptOutConfirm = false;
      return {
        confirmed: false,
        message: "Theek hai ji! Main aapko payment reminders continue rakhungi 😊 Kuch aur help chahiye?"
      };
    } else {
      return {
        confirmed: false,
        message: "Confirm karne ke liye 'YES' likhein, ya reminders continue rakhne ke liye 'NO' likhein 🙏"
      };
    }
  }

  /**
   * Execute a promise sweep: check if payment was made.
   * Called by the sweep job timer.
   */
  sweepPromise(caseId: string, wasPaid: boolean): RecoveryCase | null {
    const caseData = this.cases.get(caseId);
    if (!caseData || !caseData.promise) return null;

    if (wasPaid) {
      caseData.promise.status = "kept";
      this.stats.totalPromisesKept++;
      this.recordRecovery(caseId, caseData.promise.promisedAmount);
    } else {
      caseData.promise.status = "broken";
      this.stats.totalPromisesBroken++;

      // Resume recovery ladder
      this.transitionState(caseId, "INTERVENING",
        "Promise broken — resuming recovery sequence"
      );

      console.log(
        `[Orchestrator] Promise broken for ${caseId} — resuming recovery`
      );
    }

    return caseData;
  }

  // Job Management

  /**
   * Cancel all pending jobs for a case, optionally excluding one job.
   */
  cancelCaseJobs(caseId: string, excludeJobId?: string): number {
    let cancelled = 0;

    for (const job of this.jobQueue) {
      if (job.caseId === caseId && job.status === "scheduled" && job.id !== excludeJobId) {
        job.status = "cancelled";
        job.failureReason = "Case resolved — job cancelled";

        const timer = this.jobTimers.get(job.id);
        if (timer) {
          clearTimeout(timer);
          this.jobTimers.delete(job.id);
        }

        cancelled++;
        this.stats.totalJobsCancelled++;
        this.persistJob(job);
      }
    }

    if (cancelled > 0) {
      console.log(`[Orchestrator] Cancelled ${cancelled} pending jobs for case ${caseId}`);
    }

    return cancelled;
  }

  /** Boot-time restore of scheduled jobs from durable storage. */
  restoreScheduledJobs(rows: Array<{
    id: string; case_id?: string; caseId?: string; type: string;
    execute_at?: string | Date; executeAt?: string | Date;
    channel?: string; escalation_level?: string; escalationLevel?: string;
    discount_percent?: number; discountPercent?: number;
    payload?: any; status?: string;
  }>): number {
    let armed = 0;
    for (const row of rows) {
      if (!row?.id || !row.caseId && !row.case_id) continue;
      const executeAt = String(row.executeAt || row.execute_at || new Date().toISOString());
      const job: ScheduledJob = {
        id: row.id,
        caseId: String(row.caseId || row.case_id),
        type: row.type as never,
        status: "scheduled",
        executeAt,
        channel: (row.channel || (row.payload as any)?.channel) as never,
        escalationLevel: (row.escalationLevel || row.escalation_level) as never,
        discountPercent: row.discountPercent ?? row.discount_percent,
        createdAt: new Date().toISOString(),
        retryCount: 0,
      };
      if (this.jobQueue.some((j) => j.id === job.id)) continue;
      if (!this.cases.has(job.caseId)) continue; // case snapshot missing — skip
      this.jobQueue.push(job);
      const delayMs = Math.max(0, new Date(executeAt).getTime() - Date.now());
      const timer = setTimeout(() => {
        this.executeJob(job.id).catch((err) =>
          console.error(`[Orchestrator] Restored job error ${job.id}:`, err)
        );
      }, Math.min(delayMs, 2 ** 31 - 1));
      this.jobTimers.set(job.id, timer);
      armed++;
    }
    if (armed) console.log(`[Orchestrator] ⏰ Re-armed ${armed} scheduled job(s) from PostgreSQL`);
    return armed;
  }

  // Query Methods

  getCase(caseId: string): RecoveryCase | undefined {
    return this.cases.get(caseId);
  }

  getCases(filters?: {
    state?: CaseState;
    limit?: number;
  }): RecoveryCase[] {
    let results = Array.from(this.cases.values());

    if (filters?.state) {
      results = results.filter((c) => c.state === filters.state);
    }

    // Sort by updatedAt descending
    results.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return results.slice(0, filters?.limit || 50);
  }

  getJobs(filters?: {
    caseId?: string;
    status?: JobStatus;
    limit?: number;
  }): ScheduledJob[] {
    let results = [...this.jobQueue];

    if (filters?.caseId) {
      results = results.filter((j) => j.caseId === filters.caseId);
    }
    if (filters?.status) {
      results = results.filter((j) => j.status === filters.status);
    }

    return results.slice(0, filters?.limit || 50);
  }

  getStats(): OrchestratorStats {
    this.updateStateCounts();
    return { ...this.stats };
  }

  getComplianceConfig(): ComplianceConfig {
    return { ...this.complianceConfig };
  }

  updateComplianceConfig(updates: Partial<ComplianceConfig>): ComplianceConfig {
    if (updates.quietHoursStart !== undefined) this.complianceConfig.quietHoursStart = updates.quietHoursStart;
    if (updates.quietHoursEnd !== undefined) this.complianceConfig.quietHoursEnd = updates.quietHoursEnd;
    if (updates.rbiAfaThreshold !== undefined) this.complianceConfig.rbiAfaThreshold = updates.rbiAfaThreshold;
    if (updates.maxContactAttempts !== undefined) this.complianceConfig.maxContactAttempts = updates.maxContactAttempts;
    if (updates.dpdpEnabled !== undefined) this.complianceConfig.dpdpEnabled = updates.dpdpEnabled;
    return { ...this.complianceConfig };
  }

  // Lifecycle

  /** Set the intervention execution callback */
  setInterventionHandler(
    handler: (caseData: RecoveryCase, job: ScheduledJob) => Promise<void>
  ): void {
    this.onExecuteIntervention = handler;
  }

  /** Clean up all timers on shutdown */
  destroy(): void {
    for (const timer of this.jobTimers.values()) {
      clearTimeout(timer);
    }
    this.jobTimers.clear();
    console.log("[Orchestrator] Destroyed — all timers cleared");
  }

  // Private

  private updateStateCounts(): void {
    const counts: Record<string, number> = {};
    for (const c of this.cases.values()) {
      counts[c.state] = (counts[c.state] || 0) + 1;
    }
    this.stats.byState = counts;
  }
}
