import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  FileX2,
  RefreshCw,
  ShieldOff,
  Sparkles,
} from "lucide-react";

interface CaseDirectoryViewProps {
  onOpenInAgent?: (target: { id: string; customerName: string; customerEmail?: string; amount: number; declineCode?: string; channel: "invoice"; state: string }) => void;
}

interface StateTransition {
  from: string;
  to: string;
  reason: string;
  timestamp: string;
}

interface RecoveryCase {
  id: string;
  state: string;
  customerEmail?: string;
  customerName?: string;
  amount: number;
  currency: string;
  declineCode?: string;
  attemptCount: number;
  maxAttempts: number;
  currentDecision?: {
    channel: string;
    delayHours: number;
    decisionSource: "agent" | "agent_vetoed" | "rule";
    narration?: string;
    discountIncentive?: number;
  };
  promise?: { promisedDate: string; status: string };
  transitions: StateTransition[];
  updatedAt: string;
}

const STATE_FILTERS = [
  "ALL",
  "ESCALATED",
  "INTERVENING",
  "PAUSED_PROMISE",
  "RECOVERED",
  "DETECTED",
  "DIAGNOSED",
  "POLICY_SELECTED",
  "CLOSED_LOST",
  "SKIPPED_COMPLIANCE",
] as const;

const STATE_STYLES: Record<string, string> = {
  DETECTED: "bg-slate-100 text-slate-600 border-slate-200",
  DIAGNOSED: "bg-sky-50 text-sky-700 border-sky-200",
  POLICY_SELECTED: "bg-indigo-50 text-indigo-700 border-indigo-200",
  INTERVENING: "bg-amber-50 text-amber-700 border-amber-200",
  RECOVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PAUSED_PROMISE: "bg-violet-50 text-violet-700 border-violet-200",
  ESCALATED: "bg-red-50 text-red-700 border-red-200",
  CLOSED_LOST: "bg-slate-100 text-slate-500 border-slate-200",
  SKIPPED_COMPLIANCE: "bg-orange-50 text-orange-700 border-orange-200",
};

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  agent: { label: "AI Agent", cls: "bg-emerald-100 text-emerald-700 border-emerald-300" },
  agent_vetoed: { label: "Vetoed", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  rule: { label: "Rules", cls: "bg-blue-100 text-blue-700 border-blue-300" },
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function CaseDirectoryView({ onOpenInAgent }: CaseDirectoryViewProps) {
  const [filter, setFilter] = useState<string>("ALL");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const { data: casesData, refetch, isFetching } = useQuery({
    queryKey: ["orchestrator-cases"],
    queryFn: async () => {
      const res = await fetch("/api/orchestrator/cases?limit=200");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      return data.cases as RecoveryCase[];
    },
    refetchInterval: 15000,
  });

  const cases = casesData ?? [];
  const loading = isFetching;

  const runEscalationAction = async (caseId: string, action: string) => {
    setActionMsg(null);
    const res = await fetch(`/api/orchestrator/cases/${caseId}/escalation-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (res.ok) {
      if (action === "offer_discount" && data.paymentLink) {
        setActionMsg(`5% discount link generated for ${caseId}: ${data.paymentLink}`);
      } else {
        setActionMsg(`${action.replace("_", " ")} applied to ${caseId}`);
      }
      refetch();
    } else {
      setActionMsg(data.error || "Action failed");
    }
  };

  const filtered = filter === "ALL" ? cases : cases.filter((c) => c.state === filter);
  const escalatedCount = cases.filter((c) => c.state === "ESCALATED").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold font-heading text-slate-900">Case Directory & Escalations</h1>
          <p className="text-sm text-slate-500 font-body mt-1">
            Live recovery lifecycle — every case, every transition, fully audited.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-slate-200 text-sm font-body font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Escalation banner */}
      {escalatedCount > 0 && (
        <div className="flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-red-50 border border-red-200">
          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <span className="text-sm font-body font-semibold text-red-700">
            {escalatedCount} case{escalatedCount > 1 ? "s" : ""} need human attention
          </span>
        </div>
      )}

      {actionMsg && (
        <div className="px-5 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm font-body text-emerald-700 break-all">
          {actionMsg}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {STATE_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-body font-semibold border transition-all cursor-pointer ${
              filter === s
                ? "bg-brand-orange text-white border-brand-orange shadow-sm"
                : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
            }`}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Cases */}
      <div className="space-y-3">
        {filtered.length === 0 && (
          <div className="text-center py-16 text-slate-400 font-body text-sm">
            No cases found. Run a simulation batch or send a webhook to populate cases.
          </div>
        )}
        {filtered.map((c) => {
          const badge = c.currentDecision ? SOURCE_BADGE[c.currentDecision.decisionSource] : null;
          const isExpanded = expandedId === c.id;
          return (
            <div
              key={c.id}
              className={`rounded-2xl bg-white border transition-shadow ${
                c.state === "ESCALATED"
                  ? "border-red-200 shadow-sm hover:shadow-md"
                  : "border-slate-200 hover:shadow-md"
              }`}
            >
              <div
                className="p-5 cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : c.id)}
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold font-body border ${STATE_STYLES[c.state] || STATE_STYLES.DETECTED}`}>
                        {c.state.replace("_", " ")}
                      </span>
                      {badge && (
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-body border ${badge.cls}`}>
                          {badge.label}
                        </span>
                      )}
                      {c.promise && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold font-body bg-violet-100 text-violet-700 border border-violet-200">
                          Promise {c.promise.status}
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenInAgent?.({
                            id: c.id,
                            customerName: c.customerName || c.customerEmail || c.id,
                            customerEmail: c.customerEmail,
                            amount: c.amount,
                            declineCode: c.declineCode,
                            channel: "invoice",
                            state: c.state,
                          });
                        }}
                        className="px-2.5 py-0.5 rounded-full text-[10px] font-bold font-body bg-slate-900 text-white hover:bg-slate-700 transition-colors cursor-pointer"
                        title="Open this case in the AI Vasooli Agent tab"
                      >
                        🤖 Open in Agent ↗
                      </button>
                    </div>
                    <p className="mt-2 text-sm font-body font-semibold text-slate-800 truncate">
                      {c.customerName || "Customer"} · {c.customerEmail || "no email"}
                    </p>
                    <p className="text-xs text-slate-400 font-body mt-0.5">
                      {c.id} · attempt {c.attemptCount}/{c.maxAttempts}
                      {c.declineCode ? ` · ${c.declineCode}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold font-heading text-slate-900">{inr(c.amount)}</p>
                    <p className="text-[11px] text-slate-400 font-body flex items-center justify-end gap-1 mt-0.5">
                      <Clock className="w-3 h-3" />
                      {new Date(c.updatedAt).toLocaleTimeString()}
                    </p>
                  </div>
                </div>

                {c.currentDecision?.narration && (
                  <div className="mt-3 flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-100">
                    <Sparkles className="w-3.5 h-3.5 text-brand-orange mt-0.5 flex-shrink-0" />
                    <p className="text-xs font-body text-slate-600 italic">{c.currentDecision.narration}</p>
                  </div>
                )}

                {/* Escalation quick actions */}
                {c.state === "ESCALATED" && (
                  <div className="mt-4 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => runEscalationAction(c.id, "mark_resolved")}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 text-white text-xs font-body font-semibold hover:bg-emerald-700 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Mark Resolved
                    </button>
                    <button
                      onClick={() => runEscalationAction(c.id, "offer_discount")}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand-orange text-white text-xs font-body font-semibold hover:bg-brand-orange/90 cursor-pointer"
                    >
                      <CircleDollarSign className="w-3.5 h-3.5" /> Offer 5% Discount Link
                    </button>
                    <button
                      onClick={() => runEscalationAction(c.id, "write_off")}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white border border-slate-300 text-slate-600 text-xs font-body font-semibold hover:bg-slate-50 cursor-pointer"
                    >
                      <FileX2 className="w-3.5 h-3.5" /> Write Off
                    </button>
                  </div>
                )}
              </div>

              {/* Expanded timeline */}
              {isExpanded && (
                <div className="border-t border-slate-100 px-5 py-4 bg-slate-50/60">
                  <p className="text-[11px] font-bold font-body text-slate-400 uppercase tracking-wider mb-3">
                    Audit Timeline
                  </p>
                  <div className="space-y-0">
                    {c.transitions.map((t, i) => (
                      <div key={i} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <div className={`w-2.5 h-2.5 rounded-full border-2 ${
                            t.to === "RECOVERED" ? "bg-emerald-500 border-emerald-300"
                              : t.to === "ESCALATED" ? "bg-red-500 border-red-300"
                                : t.to === "SKIPPED_COMPLIANCE" ? "bg-orange-400 border-orange-200"
                                  : "bg-white border-slate-300"
                          }`} />
                          {i < c.transitions.length - 1 && <div className="w-0.5 flex-1 bg-slate-200 min-h-[24px]" />}
                        </div>
                        <div className="pb-4 -mt-0.5">
                          <p className="text-xs font-body font-semibold text-slate-700">
                            {t.from} → {t.to}
                          </p>
                          <p className="text-[11px] text-slate-500 font-body">{t.reason}</p>
                          <p className="text-[10px] text-slate-400 font-body">{new Date(t.timestamp).toLocaleString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {c.state !== "ESCALATED" && !["RECOVERED", "CLOSED_LOST", "SKIPPED_COMPLIANCE"].includes(c.state) && (
                    <div className="flex items-center gap-2 pt-1 text-[11px] text-slate-400 font-body">
                      <ShieldOff className="w-3.5 h-3.5" />
                      Compliance guardrails active: quiet hours, DPDP opt-out, RBI AFA threshold.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}