import { useCallback, useEffect, useState } from "react";
import { MetricCard } from "../common/MetricCard";
import { HighContrastCard } from "../common/HighContrastCard";
import { RecoveryBreakdownChart } from "../charts/RecoveryBreakdownChart";
import { RecoveryTimelineChart } from "../charts/RecoveryTimelineChart";
import { DeclineReasonChart } from "../charts/DeclineReasonChart";
import type { KPIMetric } from "../../types";
import { CheckCircle2, ShieldCheck, XCircle, Brain, Database } from "lucide-react";

interface HealthStats {
  phase3?: { avgRecoverabilityScore?: number };
  phase4?: { bySource?: Record<string, number> };
  phase5?: {
    totalCases?: number;
    totalRecovered?: number;
    totalRecoveredAmount?: number;
    totalEscalated?: number;
    totalSkippedCompliance?: number;
    byState?: Record<string, number>;
  };
  phase6?: { auditLedger?: { totalEntries?: number } };
}


interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  brokenAtSeq?: number;
  reason?: string;
  verifiedAt: string;
}

// Phase L1: learning loop
interface LearnedRule {
  key: string;
  category: string;
  channel: string;
  attempt: number;
  attempted: number;
  recovered: number;
  rate: number;
}
interface LearningStats {
  memoryKeys: number;
  seeded: boolean;
  topLearnedRules: LearnedRule[];
}

type AgentMode = "agentic" | "control";

const inr = (n: number | undefined) => `₹${Math.round(n || 0).toLocaleString("en-IN")}`;
const pct = (n: number | undefined) => `${((n || 0) * 100).toFixed(1)}%`;

export function OverviewView() {
  const [stats, setStats] = useState<HealthStats | null>(null);
  const [mode, setMode] = useState<AgentMode>("agentic");
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [live, setLive] = useState(false);
  const [learning, setLearning] = useState<LearningStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<Array<{
    rank: number; declineCode: string; totalCases: number;
    recoveredCount: number; recoveryRate: number;
    recoveredAmount: number; avgAttempts: number; bestChannel: string;
  }>>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [seeding, setSeeding] = useState(false);

  const handleSeed = async () => {
    if (seeding) return;
    setSeeding(true);
    try {
      await fetch("/api/system/seed", { method: "POST" });
      load();
    } finally {
      setSeeding(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const hRes = await fetch("/api/health");
      if (hRes.ok) {
        setStats(await hRes.json());
        setLive(true);
      } else {
        setLive(false);
      }
      const lbRes = await fetch("/api/analytics/leaderboard");
      if (lbRes.ok) setLeaderboard((await lbRes.json()).leaderboard || []);
      const learnRes = await fetch("/api/learning/stats");
      if (learnRes.ok) setLearning(await learnRes.json());
      const analyticsRes = await fetch("/api/analytics/overview");
      if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
    } catch {
      setLive(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  // Phase H1: kill-switch is now server state (durable + audited).
  // Load the persisted mode on mount; fall back to default when offline.
  useEffect(() => {
    fetch("/api/system/mode")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { mode?: AgentMode } | null) => {
        if (data?.mode === "agentic" || data?.mode === "control") setMode(data.mode);
      })
      .catch(() => {
        /* offline — keep default */
      });
  }, []);

  const toggleMode = () => {
    const next: AgentMode = mode === "agentic" ? "control" : "agentic";
    setMode(next); // optimistic
    fetch("/api/system/mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`mode change failed (${r.status})`);
        return r.json();
      })
      .then((data: { mode?: AgentMode }) => {
        if (data.mode === "agentic" || data.mode === "control") setMode(data.mode);
      })
      .catch(() => setMode((cur) => (cur === next ? mode : cur))); // revert on failure
  };

  const verifyIntegrity = async () => {
    setVerifying(true);
    try {
      const res = await fetch("/api/audit/verify");
      if (res.ok) setVerification(await res.json());
    } finally {
      setVerifying(false);
    }
  };

  // Build live KPIs from backend health, falling back to mock data when offline.
  const orch = stats?.phase5;
  const liveKpis: KPIMetric[] | null =
    orch && live
      ? [
          {
            title: "₹ Recovered",
            value: inr(orch.totalRecoveredAmount),
            subtitle: `${orch.totalRecovered ?? 0} of ${orch.totalCases ?? 0} cases`,
            accent: "emerald",
          },
          {
            title: "Active Interventions",
            value: String(orch.byState?.INTERVENING ?? 0),
            subtitle: `${orch.byState?.PAUSED_PROMISE ?? 0} paused on promise`,
            accent: "violet",
          },
          {
            title: "Escalations Open",
            value: String(orch.totalEscalated ?? 0),
            subtitle: "Need human attention",
            accent: "orange",
          },
          {
            title: "Avg Recoverability",
            value: pct(stats?.phase3?.avgRecoverabilityScore),
            subtitle: `${stats?.phase4?.bySource?.agent ?? 0} agent · ${
              stats?.phase4?.bySource?.rule ?? 0
            } rule decisions`,
            accent: "pink",
          },
        ]
      : null;

  const byState = orch?.byState;

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Page Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-extrabold font-heading text-slate-900">
            Command Center
          </h2>
          <p className="text-sm text-slate-500 font-body mt-1">
            Real-time AI revenue recovery intelligence from your Razorpay integration
          </p>
        </div>
        {/* Kill Switch / Mode Toggle */}
        <button
          onClick={toggleMode}
          title="Kill switch — switches the recovery engine between agentic AI decisions and merchant control baseline"
          className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border text-sm font-body font-semibold cursor-pointer transition-colors ${
            mode === "agentic"
              ? "bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
              : "bg-slate-100 border-slate-300 text-slate-600 hover:bg-slate-200"
          }`}
        >
          <span className={`w-2.5 h-2.5 rounded-full animate-pulse ${mode === "agentic" ? "bg-emerald-500" : "bg-slate-400"}`} />
          {mode === "agentic" ? "Agentic Recovery ON" : "Control Baseline (Kill Switch)"}
        </button>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {(liveKpis ?? analytics?.kpiMetrics ?? []).map((metric: any) => (
          <MetricCard key={metric.title} {...metric} />
        ))}
      </div>

      {/* Agent Learning (Phase L1) — what the engine discovered from outcomes */}
      {learning && learning.topLearnedRules.length > 0 && (
        <div className="rounded-2xl bg-white border border-slate-200 px-6 py-5 shadow-sm">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-violet-600" />
              <h3 className="text-sm font-heading font-bold text-slate-900">Agent Learning</h3>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-violet-100 text-violet-700 rounded-full px-2 py-0.5">
                {learning.memoryKeys} learned rules
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5 flex items-center gap-1" title="Phase L2 RAG embeddings enabled">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                RAG Memory Active
              </span>
            </div>
            <p className="text-xs text-slate-400 font-body">
              Most confident channel preferences, mined from recovery outcomes and similar-case embeddings
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {learning.topLearnedRules.map((rule) => (
              <div key={rule.key} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-body font-semibold text-slate-700">
                    {rule.channel.replace(/_/g, " ")} · {rule.category.replace(/_/g, " ")}
                  </span>
                  <span className={`text-sm font-bold font-body ${
                    rule.rate >= 0.55 ? "text-emerald-600" : rule.rate <= 0.45 ? "text-rose-600" : "text-slate-600"
                  }`}>
                    {Math.round(rule.rate * 100)}%
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 font-body mt-1">
                  {rule.recovered}/{rule.attempted} recovered · attempt #{rule.attempt}
                </p>
                <div className="mt-2 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${rule.rate >= 0.55 ? "bg-emerald-500" : rule.rate <= 0.45 ? "bg-rose-400" : "bg-slate-400"}`}
                    style={{ width: `${Math.round(rule.rate * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}


      {/* Batch Integrity Proof */}
      <div
        className={`rounded-2xl border px-6 py-4 flex items-center justify-between flex-wrap gap-3 transition-colors ${
          verification
            ? verification.valid
              ? "bg-emerald-50 border-emerald-300"
              : "bg-red-50 border-red-300"
            : "bg-white border-slate-200"
        }`}
      >
        <div className="flex items-center gap-3">
          <ShieldCheck
            className={`w-5 h-5 ${verification?.valid ? "text-emerald-600" : "text-slate-400"}`}
          />
          {verification ? (
            verification.valid ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <p className="text-sm font-body font-bold text-emerald-700">
                  Audit chain intact — {verification.entriesChecked} blocks verified cryptographically
                </p>
              </>
            ) : (
              <>
                <XCircle className="w-5 h-5 text-red-600" />
                <p className="text-sm font-body font-bold text-red-700">
                  Tamper detected at block #{verification.brokenAtSeq}
                </p>
              </>
            )
          ) : (
            <p className="text-sm font-body text-slate-500">
              Prove every recovery decision with the tamper-evident SHA-256 audit chain.
            </p>
          )}
        </div>
        <button
          onClick={verifyIntegrity}
          disabled={verifying}
          className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-body font-semibold hover:bg-slate-800 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          {verifying ? "Verifying…" : "Verify Batch Integrity"}
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSeed}
          disabled={seeding}
          className="px-4 py-2 flex items-center gap-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-body font-semibold hover:bg-slate-200 border border-slate-300 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          <Database className="w-4 h-4" />
          {seeding ? "Seeding DB..." : "Seed Dummy Data"}
        </button>
      </div>
      {!live && (
        <p className="text-xs font-body text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
          Backend offline — showing sample data. Run <code className="font-mono">npm run server</code> for live telemetry.
        </p>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecoveryBreakdownChart data={analytics?.recoveryBreakdownData ?? []} />
        <RecoveryTimelineChart data={analytics?.recoveryTimelineData ?? []} />
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <DeclineReasonChart data={analytics?.declineReasonData ?? []} />
        </div>

        {/* Live Pipeline Panel */}
        <div className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm hover:shadow-md transition-shadow animate-slide-up">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-slate-900 font-heading">
              Recovery Pipeline
            </h3>
            <span
              className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ${
                live ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`} />
              {live ? "Live" : "Offline"}
            </span>
          </div>
          <div className="space-y-2">
            {[
              { state: "DETECTED", label: "Detected — awaiting diagnosis", color: "text-slate-600", bar: "bg-slate-400" },
              { state: "DIAGNOSED", label: "Diagnosed — root cause classified", color: "text-sky-600", bar: "bg-sky-500" },
              { state: "POLICY_SELECTED", label: "Policy selected — action chosen", color: "text-indigo-600", bar: "bg-indigo-500" },
              { state: "INTERVENING", label: "Intervening — outreach in flight", color: "text-amber-600", bar: "bg-amber-500" },
              { state: "PAUSED_PROMISE", label: "Paused on customer promise", color: "text-violet-600", bar: "bg-violet-500" },
              { state: "RECOVERED", label: "Recovered — rupees back", color: "text-emerald-600", bar: "bg-emerald-500" },
              { state: "ESCALATED", label: "Escalated — human review", color: "text-red-600", bar: "bg-red-500" },
            ].map(({ state, label, color, bar }) => (
              <div key={state} className="flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${bar}`} />
                <p className="text-xs font-body font-semibold text-slate-700">{label}</p>
                <span className={`ml-auto text-sm font-bold font-heading ${color}`}>
                  {byState?.[state] ?? 0}
                </span>
              </div>
            ))}
          </div>
          {byState && (
            <p className="text-[11px] font-body text-slate-400 mt-3">
              Compliance guardrails active: quiet-hours deferrals,{" "}
              {(stats?.phase5?.totalSkippedCompliance ?? 0) > 0
                ? `${stats?.phase5?.totalSkippedCompliance} DPDP skips`
                : "DPDP opt-outs"}
              , RBI AFA threshold.
            </p>
          )}
        </div>
      </div>

      {/* 🏆 Recovery Score Leaderboard */}
      {leaderboard.length > 0 && (
        <div className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm animate-slide-up">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-bold text-slate-900 font-heading">
                🏆 Recovery Score Leaderboard
              </h3>
              <p className="text-xs text-slate-500 font-body mt-0.5">
                Kaunse decline reasons best convert karte hain — live from your cases
              </p>
            </div>
          </div>
          <div className="space-y-2.5">
            {leaderboard.slice(0, 6).map((row) => (
              <div key={row.declineCode} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200/70">
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
                  row.rank === 1 ? "bg-amber-100 text-amber-700 border border-amber-300" :
                  row.rank === 2 ? "bg-slate-200 text-slate-600" :
                  row.rank === 3 ? "bg-orange-100 text-orange-700 border border-orange-200" :
                  "bg-slate-100 text-slate-400"
                }`}>
                  {row.rank <= 3 ? ["🥇","🥈","🥉"][row.rank - 1] : row.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <span className="text-xs font-bold font-body text-slate-800 truncate">{row.declineCode.replace(/_/g, " ")}</span>
                    <span className="text-xs font-bold font-heading text-slate-900">{(row.recoveryRate * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all" style={{ width: `${Math.min(100, row.recoveryRate * 100)}%` }} />
                  </div>
                  <p className="text-[10px] font-body text-slate-400 mt-1">
                    {row.recoveredCount}/{row.totalCases} recovered · ₹{Math.round(row.recoveredAmount).toLocaleString("en-IN")} · {row.bestChannel}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Feature Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <HighContrastCard
          title="Predictive Retry Engine"
          tag="94.2% Success"
          description="AI dynamically schedules card re-attempts during optimal bank settlement windows, cutting decline rates by 42%."
        />
        <HighContrastCard
          title="Razorpay UPI Smart-Switch"
          tag="Instant Recovery"
          description="Automatically sends dynamic WhatsApp & SMS UPI intent payment links when recurring card mandates fail."
        />
        <HighContrastCard
          title="Empathetic Dunning AI"
          tag="Zero Churn"
          description="Negotiates flexible payment plans and applies time-limited loyalty incentives natively before subscription termination."
        />
      </div>
    </div>
  );
}
