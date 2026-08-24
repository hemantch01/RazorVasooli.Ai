import type { RiskEvent, RiskEventBus } from "./ingestion.js";
import type { DiagnosisService, DiagnosisResult } from "./diagnosis.js";
import type { PolicyService, PolicyInput } from "./policy.js";
import type { OrchestratorService } from "./orchestrator.js";
import type { AuditService } from "./audit.js";
import type { TelegramAgent } from "./telegram.js";

interface EventHandlersConfig {
  riskEventBus: RiskEventBus;
  diagnosisService: DiagnosisService;
  policyService: PolicyService;
  orchestrator: OrchestratorService;
  auditService: AuditService;
  telegramAgent: TelegramAgent | null;
}

export function registerEventHandlers(config: EventHandlersConfig) {
  const { riskEventBus, diagnosisService, policyService, orchestrator, auditService, telegramAgent } = config;

  async function runRecoveryPipeline(event: RiskEvent, diagnosis: DiagnosisResult): Promise<void> {
    orchestrator.createCase({
      id: event.id,
      customerEmail: event.customerEmail,
      amount: event.amount || 0,
      currency: event.currency,
      declineCode: event.declineCode,
      paymentMethod: event.payload?.payment?.entity?.method,
      subscriptionId: event.subscriptionId,
      invoiceId: event.invoiceId,
      category: diagnosis.taxonomy.category,
    });

    orchestrator.transitionState(event.id, "DIAGNOSED",
      `Classified as ${diagnosis.taxonomy.category} (score=${diagnosis.recoverability.score})`
    );

    auditService.append("case.diagnosed", {
      caseId: event.id,
      category: diagnosis.taxonomy.category,
      recoverabilityScore: diagnosis.recoverability.score,
      diagnosisSource: diagnosis.diagnosisSource,
      amount: event.amount || 0,
    });

    const policyInput: PolicyInput = {
      caseId: event.id,
      category: diagnosis.taxonomy.category,
      taxonomy: diagnosis.taxonomy,
      recoverability: diagnosis.recoverability,
      amount: event.amount || 0,
      retryCount: event.payload?.payment?.entity?.retry_count || 0,
      paymentMethod: event.payload?.payment?.entity?.method,
      isSubscription: !!event.subscriptionId,
      declineCode: event.declineCode,
    };

    const decision = await policyService.decide(policyInput);
    console.log(
      `[Pipeline] 🔄 ${event.id}: ${diagnosis.taxonomy.category} → ${decision.channel}/${decision.delayHours}h (${decision.decisionSource}) | ${decision.narration}`
    );

    auditService.append("policy.decision", {
      caseId: event.id,
      channel: decision.channel,
      delayHours: decision.delayHours,
      decisionSource: decision.decisionSource,
      escalationLevel: decision.escalationLevel,
      discountIncentive: decision.discountIncentive || null,
      narration: decision.narration,
    });

    orchestrator.applyDecision(event.id, decision);
  }

  riskEventBus.on("*", (event: RiskEvent) => {
    const icon =
      event.severity === "critical" ? "🔴" :
        event.severity === "high" ? "🟠" :
          event.severity === "medium" ? "🟡" : "🟢";
    console.log(
      `[RiskBus] ${icon} ${event.type} | severity=${event.severity} | source=${event.source} | amt=₹${event.amount || 0} | customer=${event.customerEmail || "unknown"}`
    );
  });

  riskEventBus.on("payment.failed", async (event: RiskEvent) => {
    if (event.declineCode) {
      const failedAt = new Date(event.receivedAt).getTime();
      const hoursSinceFailure = (Date.now() - failedAt) / 3600000;

      const diagnosis = await diagnosisService.diagnose({
        caseId: event.id,
        errorCode: event.declineCode,
        amount: event.amount || 0,
        retryCount: event.payload?.payment?.entity?.retry_count || 0,
        paymentMethod: event.payload?.payment?.entity?.method,
        hoursSinceFailure,
        isSubscription: !!event.subscriptionId,
        rawPayload: event.payload,
      });

      console.log(
        `[Diagnosis] 🔬 ${event.id} → category=${diagnosis.taxonomy.category} | score=${diagnosis.recoverability.score} | source=${diagnosis.diagnosisSource} | timing=${diagnosis.recoverability.timingHint.reason}`
      );

      await runRecoveryPipeline(event, diagnosis);
    }
  });

  riskEventBus.on("subscription.halted", async (event: RiskEvent) => {
    const diagnosis = await diagnosisService.diagnose({
      caseId: event.id,
      errorCode: event.declineCode || "SUBSCRIPTION_HALTED",
      amount: event.amount || 0,
      retryCount: 0,
      hoursSinceFailure: 0,
      isSubscription: true,
      rawPayload: event.payload,
    });

    await runRecoveryPipeline(event, diagnosis);
  });

  riskEventBus.on("checkout.abandoned", async (event: RiskEvent) => {
    const cartItems = event.payload?.cartItems;
    if (Array.isArray(cartItems) && cartItems.length > 0 && telegramAgent) {
      const total = event.amount || cartItems.reduce((sum: number, i: any) => sum + (i.price * i.qty), 0);
      void telegramAgent.pushAbandonedCart({
        items: cartItems,
        totalInr: total,
        customerEmail: event.customerEmail,
      });
    }
    const diagnosis = await diagnosisService.diagnose({
      caseId: event.id,
      errorCode: "CHECKOUT_ABANDONED",
      amount: event.amount || 0,
      retryCount: 0,
      hoursSinceFailure: 0,
      rawPayload: event.payload,
    });

    await runRecoveryPipeline(event, diagnosis);
  });

  riskEventBus.on("invoice.poll.overdue", async (event: RiskEvent) => {
    const diagnosis = await diagnosisService.diagnose({
      caseId: event.id,
      errorCode: "INVOICE_OVERDUE",
      amount: event.amount || 0,
      retryCount: event.payload?.invoice?.retryCount || 0,
      hoursSinceFailure: event.payload?.overdueHours || 24,
      rawPayload: event.payload,
    });

    await runRecoveryPipeline(event, diagnosis);
  });

  riskEventBus.on("payment.captured", async (event: RiskEvent) => {
    const relatedCases = orchestrator.getCases({ limit: 100 });
    for (const c of relatedCases) {
      if (
        c.customerEmail === event.customerEmail &&
        c.state !== "RECOVERED" &&
        c.state !== "CLOSED_LOST" &&
        c.state !== "SKIPPED_COMPLIANCE"
      ) {
        orchestrator.recordRecovery(c.id, event.amount);
        auditService.append("recovery.recorded", {
          caseId: c.id,
          amount: event.amount,
          trigger: "payment.captured",
          paymentEventId: event.id,
        });
        console.log(`[Reconciliation] ✅ Payment captured → case ${c.id} recovered (₹${event.amount})`);
      }
    }
  });

  riskEventBus.on("invoice.paid", async (event: RiskEvent) => {
    const relatedCases = orchestrator.getCases({ limit: 100 });
    for (const c of relatedCases) {
      if (
        c.invoiceId === event.invoiceId &&
        c.state !== "RECOVERED" &&
        c.state !== "CLOSED_LOST" &&
        c.state !== "SKIPPED_COMPLIANCE"
      ) {
        orchestrator.recordRecovery(c.id, event.amount);
        auditService.append("recovery.recorded", {
          caseId: c.id,
          amount: event.amount,
          trigger: "invoice.paid",
          invoiceId: event.invoiceId,
        });
        console.log(`[Reconciliation] ✅ Invoice paid → case ${c.id} recovered (₹${event.amount})`);
      }
    }
  });

  riskEventBus.on("payment_link.paid", async (event: RiskEvent) => {
    const linkId = event.metadata?.linkId as string | undefined;
    const notes = (event.metadata?.notes ?? {}) as Record<string, unknown>;
    const amountInr = event.amount || 0;

    auditService.append("payment.link_paid", {
      linkId,
      amount: amountInr,
      caseIdFromNotes: typeof notes.case_id === "string" ? notes.case_id : undefined,
    });

    if (telegramAgent && linkId) {
      await telegramAgent.handlePaymentLinkPaid(linkId);
    }

    const caseIdFromNotes = typeof notes.case_id === "string" ? notes.case_id : undefined;
    const targetCase = caseIdFromNotes ? orchestrator.getCase(caseIdFromNotes) : undefined;
    if (
      targetCase &&
      targetCase.state !== "RECOVERED" &&
      targetCase.state !== "CLOSED_LOST" &&
      targetCase.state !== "SKIPPED_COMPLIANCE"
    ) {
      orchestrator.recordRecovery(targetCase.id, amountInr || undefined);
      auditService.append("recovery.recorded", {
        caseId: targetCase.id,
        amount: amountInr,
        trigger: "payment.link_paid",
        paymentLink: linkId,
      });
      console.log(`[Reconciliation] ✅ Payment link paid → case ${targetCase.id} recovered (₹${amountInr})`);
    }
  });

  return { runRecoveryPipeline };
}
