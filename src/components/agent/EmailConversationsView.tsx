import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, MailCheck, RefreshCw } from "lucide-react";

interface MailMessage {
  dir: "in" | "out";
  subject: string;
  body: string;
  at: string;
}

interface MailAction {
  tool: string;
  detail: string;
  at: string;
}

interface MailConversation {
  email: string;
  name: string;
  amountDueInr: number;
  declineCode?: string;
  discountPercent: number;
  promisedDate?: string;
  optedOut: boolean;
  recovered: boolean;
  paymentLink?: { shortUrl: string; simulated: boolean; status: string };
  messages: MailMessage[];
  actions: MailAction[];
  updatedAt: string;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

interface EmailConversationsViewProps {
  onOpenInAgent?: (target: import("../../types").AgentTargetDetails) => void;
}

export function EmailConversationsView({ onOpenInAgent }: EmailConversationsViewProps) {
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ["email-conversations"],
    queryFn: async () => {
      const res = await fetch("/api/email/conversations");
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    },
    refetchInterval: 8000,
  });

  const imapEnabled = data?.imapEnabled ?? false;
  const smtpEnabled = data?.smtpEnabled ?? false;
  const conversations: MailConversation[] = data?.conversations ?? [];

  // Automatically select the first email if none is selected
  if (!selectedEmail && conversations.length > 0) {
    setSelectedEmail(conversations[0].email);
  }

  const checkNow = async () => {
    setChecking(true);
    setCheckMsg(null);
    try {
      const res = await fetch("/api/email/check-now", { method: "POST" });
      const resData = await res.json();
      setCheckMsg(res.ok ? `✅ Checked — ${resData.processed} new reply(ies) processed` : `⚠️ ${resData.error}`);
      await refetch();
    } finally {
      setChecking(false);
    }
  };

  const selected = conversations.find((c) => c.email === selectedEmail) || null;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-extrabold font-heading text-slate-900">Email Conversations</h2>
          <p className="text-sm text-slate-500 font-body mt-1">
            What we sent, what the customer replied, and how the AI responded — live.
          </p>
        </div>
        <button
          onClick={checkNow}
          disabled={checking || !imapEnabled}
          title={!imapEnabled ? "Configure IMAP_* env to enable inbound polling" : "Fetch new customer replies now"}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-body font-semibold hover:bg-slate-800 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} />
          Check Replies Now
        </button>
      </div>

      {/* Status strip */}
      <div className="flex flex-wrap gap-3">
        <span className={`px-3 py-1.5 rounded-full text-[11px] font-bold border ${smtpEnabled ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-amber-50 text-amber-700 border-amber-300"}`}>
          Outbound SMTP: {smtpEnabled ? "ON" : "OFF (outbox-only)"}
        </span>
        <span className={`px-3 py-1.5 rounded-full text-[11px] font-bold border ${imapEnabled ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-amber-50 text-amber-700 border-amber-300"}`}>
          Inbound IMAP: {imapEnabled ? "ON (polling)" : "OFF (set IMAP_* env)"}
        </span>
        {checkMsg && <span className="px-3 py-1.5 rounded-full text-[11px] font-body bg-slate-100 text-slate-600 border border-slate-200">{checkMsg}</span>}
      </div>

      {!imapEnabled && (
        <p className="text-[11px] font-body text-slate-400">
          Gmail setup: enable 2FA on the recovery mailbox → create an App Password → fill IMAP_HOST=imap.gmail.com, IMAP_USER, IMAP_PASS in .env → restart. Full guide in walkthrough.md §8.
        </p>
      )}

      {conversations.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-12 text-center">
          <MailCheck className="w-8 h-8 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-body text-slate-500 font-medium">No email conversations yet</p>
          <p className="text-xs font-body text-slate-400 mt-1">Outbound recovery emails appear here; with IMAP configured, customer replies show up too.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          {/* Thread list */}
          <div className="lg:col-span-2 space-y-2.5">
            {conversations.map((c) => (
              <div
                key={c.email}
                onClick={() =>
                  onOpenInAgent?.({
                    id: `em_${c.email}`,
                    customerName: c.name,
                    customerEmail: c.email,
                    amount: c.amountDueInr,
                    declineCode: c.declineCode,
                    channel: "email",
                    state: c.recovered ? "RECOVERED" : c.optedOut ? "SKIPPED_COMPLIANCE" : c.promisedDate ? "PAUSED_PROMISE" : c.paymentLink ? "INTERVENING" : "POLICY_SELECTED",
                    promisedDate: c.promisedDate,
                    optedOut: c.optedOut,
                    recovered: c.recovered,
                    paymentLinkStatus: c.paymentLink?.status,
                  })
                }
                className={`rounded-2xl border p-4 text-left transition-all cursor-pointer group ${
                  selectedEmail === c.email ? "bg-emerald-50/60 border-emerald-300 shadow-sm" : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-bold font-heading text-slate-900 truncate">{c.name}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${
                    c.recovered ? "bg-emerald-100 text-emerald-700 border-emerald-300" : c.optedOut ? "bg-orange-100 text-orange-700 border-orange-300" : "bg-amber-50 text-amber-700 border-amber-300"
                  }`}>
                    {c.recovered ? "Recovered" : c.optedOut ? "Opted Out" : "Active"}
                  </span>
                </div>
                <p className="text-xs font-mono text-slate-400 truncate">{c.email}</p>
                <div className="flex items-center gap-3 mt-2 text-[11px] font-body">
                  <span className="font-semibold text-slate-700">{inr(c.amountDueInr)}</span>
                  {c.promisedDate && <span className="text-violet-600">📅 {c.promisedDate}</span>}
                  {c.paymentLink && <span className={c.paymentLink.status === "paid" ? "text-emerald-600" : "text-brand-orange"}>💳 link {c.paymentLink.status}</span>}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedEmail(c.email);
                  }}
                  className="mt-2.5 text-[10px] font-bold font-body text-brand-orange hover:underline cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  👁 Preview here (without leaving)
                </button>
              </div>
            ))}
          </div>

          {/* Thread detail */}
          {selected && (
            <div className="lg:col-span-3 space-y-4">
              {/* Email thread — mail style */}
              <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden shadow-sm">
                <div className="bg-slate-800 text-white px-5 py-3 flex items-center gap-3">
                  <MailCheck className="w-4 h-4" />
                  <div>
                    <p className="text-sm font-bold font-heading">Recovery Mail Thread</p>
                    <p className="text-[10px] opacity-80">{selected.email} · due {inr(selected.amountDueInr)}</p>
                  </div>
                </div>
                <div className="p-4 space-y-3 max-h-[420px] overflow-y-auto bg-slate-50/50">
                  {selected.messages.length === 0 && <p className="text-center text-xs text-slate-400 py-8">No emails yet.</p>}
                  {selected.messages.map((m, i) => (
                    <div key={i} className={`rounded-xl border p-3.5 ${m.dir === "in" ? "bg-white border-slate-200" : "bg-indigo-50/60 border-indigo-200"}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className={`text-[10px] font-bold uppercase tracking-wide ${m.dir === "in" ? "text-slate-500" : "text-indigo-600"}`}>
                          {m.dir === "in" ? "📥 Customer Reply" : "📤 AI Agent"} · {selected.name}
                        </span>
                        <span className="text-[9px] font-mono text-slate-300">{new Date(m.at).toLocaleTimeString()}</span>
                      </div>
                      {m.subject && <p className="text-xs font-bold font-heading text-slate-800 mb-1">{m.subject}</p>}
                      <p className="text-xs font-body text-slate-700 whitespace-pre-wrap leading-relaxed">{m.body}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="rounded-2xl bg-white border border-slate-200 p-5">
                <h4 className="text-sm font-bold font-heading text-slate-900 mb-3 flex items-center gap-2">
                  <Bot className="w-4 h-4 text-violet-600" /> AI Actions on this thread
                </h4>
                {selected.actions.length === 0 ? (
                  <p className="text-xs font-body text-slate-400">No actions yet.</p>
                ) : (
                  <div className="space-y-2">
                    {[...selected.actions].reverse().map((a, i) => (
                      <div key={i} className="flex items-start gap-2.5 text-xs font-body">
                        <span className="mt-0.5 px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-bold uppercase whitespace-nowrap">{a.tool.replace(/_/g, " ")}</span>
                        <span className="flex-1 text-slate-600">{a.detail}</span>
                        <span className="text-[10px] text-slate-300 font-mono">{new Date(a.at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
