import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Link2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";

interface AuditEntry {
  seq: number;
  timestamp: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

interface ChainVerification {
  valid: boolean;
  totalEntries: number;
  entriesChecked: number;
  brokenAtSeq?: number;
  reason?: string;
  verifiedAt: string;
}

const EVENT_COLORS: Record<string, string> = {
  "webhook.received": "bg-sky-100 text-sky-700 border-sky-200",
  "case.diagnosed": "bg-indigo-100 text-indigo-700 border-indigo-200",
  "policy.decision": "bg-violet-100 text-violet-700 border-violet-200",
  "intervention.executed": "bg-amber-100 text-amber-700 border-amber-200",
  "recovery.recorded": "bg-emerald-100 text-emerald-700 border-emerald-200",
  "customer.reply": "bg-pink-100 text-pink-700 border-pink-200",
  "escalation.resolved": "bg-emerald-100 text-emerald-700 border-emerald-200",
  "escalation.discount_offered": "bg-orange-100 text-orange-700 border-orange-200",
  "escalation.written_off": "bg-slate-200 text-slate-600 border-slate-300",
  "simulator.batch_run": "bg-teal-100 text-teal-700 border-teal-200",
};

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function AuditLedgerView() {
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const { data: entriesData, refetch, isFetching } = useQuery({
    queryKey: ["audit-entries"],
    queryFn: async () => {
      const res = await fetch("/api/audit/entries?limit=150");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      return data.entries as AuditEntry[];
    },
  });

  const entries = entriesData ?? [];
  const loading = isFetching;

  const verify = async () => {
    setVerifying(true);
    try {
      const res = await fetch("/api/audit/verify");
      if (res.ok) setVerification(await res.json());
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold font-heading text-slate-900">Audit Ledger</h1>
          <p className="text-sm text-slate-500 font-body mt-1">
            Tamper-evident SHA-256 hash chain — Hₙ = SHA256(Hₙ₋₁ ∥ timestamp ∥ event ∥ payload)
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

      {/* Verify integrity */}
      <div
        className={`rounded-2xl p-6 border transition-colors ${
          verification
            ? verification.valid
              ? "bg-emerald-50 border-emerald-300"
              : "bg-red-50 border-red-300"
            : "bg-white border-slate-200"
        }`}
      >
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${
              verification?.valid ? "bg-emerald-500" : verification ? "bg-red-500" : "bg-brand-orange"
            }`}>
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-bold font-heading text-slate-900">Verify Batch Integrity</p>
              <p className="text-xs font-body text-slate-500">
                Recomputes every block hash and validates the full cryptographic chain.
              </p>
            </div>
          </div>
          <button
            onClick={verify}
            disabled={verifying || entries.length === 0}
            className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-body font-semibold hover:bg-slate-800 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {verifying ? "Verifying…" : "Verify Chain"}
          </button>
        </div>

        {verification && (
          <div className={`mt-4 flex items-start gap-3 px-4 py-3 rounded-xl border ${
            verification.valid ? "bg-white/70 border-emerald-200" : "bg-white/70 border-red-200"
          }`}>
            {verification.valid ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
            ) : (
              <XCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
            )}
            <div>
              <p className={`text-sm font-bold font-body ${verification.valid ? "text-emerald-700" : "text-red-700"}`}>
                {verification.valid
                  ? `Chain intact — all ${verification.entriesChecked} blocks verified`
                  : `TAMPER DETECTED at block #${verification.brokenAtSeq}`}
              </p>
              <p className="text-xs font-body text-slate-500 mt-0.5">
                {verification.reason || `Verified at ${new Date(verification.verifiedAt).toLocaleString()}`}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Ledger blocks */}
      <div className="space-y-2.5">
        {entries.length === 0 && (
          <div className="text-center py-16 text-slate-400 font-body text-sm">
            Ledger is empty. Pipeline events will appear here as they occur.
          </div>
        )}
        {entries.map((e) => (
          <div key={e.seq} className="rounded-xl bg-white border border-slate-200 px-5 py-3.5 hover:shadow-sm transition-shadow">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-[11px] font-mono font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-md">
                  #{e.seq}
                </span>
                <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold font-body border ${EVENT_COLORS[e.eventType] || "bg-slate-100 text-slate-600 border-slate-200"}`}>
                  {e.eventType}
                </span>
                <span className="text-xs font-body text-slate-400 hidden sm:inline">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                <Link2 className="w-3 h-3" />
                {short(e.hash)}
              </div>
            </div>
            <details className="mt-2">
              <summary className="text-[11px] font-body text-slate-400 cursor-pointer hover:text-slate-600 select-none">
                View block data & chain links
              </summary>
              <div className="mt-2 space-y-1.5">
                <p className="text-[10px] font-mono text-slate-400 break-all">
                  prev: {e.prevHash === "GENESIS_SEED" ? "GENESIS_SEED" : short(e.prevHash)}
                </p>
                <pre className="text-[10px] font-mono bg-slate-50 border border-slate-100 rounded-lg p-3 overflow-x-auto text-slate-600 max-h-40 overflow-y-auto">
{JSON.stringify(e.payload, null, 2)}
                </pre>
              </div>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}