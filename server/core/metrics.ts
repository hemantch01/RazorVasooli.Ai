/**
 * RazorVasooli.Ai — Prometheus Metrics (prom-client)
 *
 * Business-level counters mirroring what the pipeline already tracks in
 * memory (cases by state, policy decisions by source, vetoes, compliance
 * stops, recovery rupees). Scraped at GET /metrics.
 *
 * All increments are fire-and-forget safe: metrics never throw into the
 * business path.
 */

import client from "prom-client";

export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

// Pipeline counters

export const riskEventsTotal = new client.Counter({
  name: "rv_risk_events_total",
  help: "Risk events ingested by source",
  labelNames: ["source", "type", "severity"] as const,
  registers: [registry],
});

export const caseStateTransitionsTotal = new client.Counter({
  name: "rv_case_state_transitions_total",
  help: "Orchestrator state transitions",
  labelNames: ["from", "to"] as const,
  registers: [registry],
});

export const policyDecisionsTotal = new client.Counter({
  name: "rv_policy_decisions_total",
  help: "Policy engine decisions by source (agent | agent_vetoed | rule)",
  labelNames: ["decision_source", "channel"] as const,
  registers: [registry],
});

export const complianceStopsTotal = new client.Counter({
  name: "rv_compliance_stops_total",
  help: "Compliance hard-stops applied",
  labelNames: ["kind"] as const, // dpdp_opt_out | quiet_hours | max_attempts
  registers: [registry],
});

export const recoveredRupeesTotal = new client.Counter({
  name: "rv_recovered_rupees_total",
  help: "Rupees recovered, attributed to trigger",
  labelNames: ["trigger"] as const,
  registers: [registry],
});

export const auditAppendsTotal = new client.Counter({
  name: "rv_audit_appends_total",
  help: "Hash-chain audit entries appended",
  registers: [registry],
});

export const queueJobsTotal = new client.Counter({
  name: "rv_queue_jobs_total",
  help: "BullMQ risk-event jobs processed by outcome",
  labelNames: ["outcome"] as const, // published | duplicate | failed | fallback_direct
  registers: [registry],
});

/** Safe increment helper — metrics must never break the business flow. */
function inc(counter: client.Counter<string>, labels?: Record<string, string | undefined>, value = 1): void {
  try {
    counter.inc(
      Object.fromEntries(Object.entries(labels ?? {}).filter(([, v]) => v !== undefined)) as never,
      value
    );
  } catch {
    /* metrics are best-effort */
  }
}

export const metrics = {
  riskEvent: (source: string, type: string, severity: string) => inc(riskEventsTotal, { source, type, severity }),
  transition: (from: string, to: string) => inc(caseStateTransitionsTotal, { from, to }),
  policyDecision: (decisionSource: string, channel: string) => inc(policyDecisionsTotal, { decision_source: decisionSource, channel }),
  complianceStop: (kind: string) => inc(complianceStopsTotal, { kind }),
  recoveredRupees: (trigger: string, amount: number) => inc(recoveredRupeesTotal, { trigger }, Math.max(0, amount)),
  auditAppend: () => inc(auditAppendsTotal),
  queueJob: (outcome: string) => inc(queueJobsTotal, { outcome }),

  async render(): Promise<string> {
    return registry.metrics();
  },
};
