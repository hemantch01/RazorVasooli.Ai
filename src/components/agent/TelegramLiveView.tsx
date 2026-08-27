import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CircleDollarSign, Clock, ShieldOff, Wrench } from "lucide-react";

interface TranscriptEntry {
  dir: "in" | "out" | "system";
  text: string;
  payLink?: string;
  at: string;
}

interface ActionEntry {
  tool: string;
  detail: string;
  at: string;
}

interface TelegramSessionView {
  chatId: number;
  customerName: string;
  amountDueInr: number;
  discountPercent: number;
  declineCode: string;
  promisedDate?: string;
  optedOut: boolean;
  recovered: boolean;
  paymentLink?: { shortUrl: string; simulated: boolean; status: string };
  transcript: TranscriptEntry[];
  actions: ActionEntry[];
  updatedAt: string;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

interface TelegramLiveViewProps {
  onOpenInAgent?: (target: import("../../types").AgentTargetDetails) => void;
}

export function TelegramLiveView({ onOpenInAgent }: TelegramLiveViewProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data } = useQuery({
    queryKey: ["telegram-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/telegram/sessions");
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    },
    refetchInterval: 5000,
  });

  const enabled = data?.enabled ?? true;
  const demo = !!data?.demo;
  const sessions: TelegramSessionView[] = data?.sessions ?? [];
  const loading = !data;

  // Auto-select first session if none is selected
  if (!selectedId && sessions.length > 0) {
    setSelectedId(sessions[0].chatId);
  }

  const selected = sessions.find((s) => s.chatId === selectedId) || null;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-extrabold font-heading text-slate-900">Telegram Live Conversations</h2>
        <p className="text-sm text-slate-500 font-body mt-1">
          Watch the AI agent negotiate with customers on your Telegram bot — every message and action, live.
        </p>
      </div>

      {demo && (
        <p className="text-[11px] font-body text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
          🎭 <strong>Demo conversations</strong> — bot pe abhi koi live traffic nahi aaya. Ye sample negotiations hain.
          Real chats dekhne ke liye <code className="font-mono">TELEGRAM_BOT_TOKEN</code> .env me daalo (walkthrough.md §8).
        </p>
      )}

      {!enabled && sessions.length === 0 && (
        <div className="rounded-2xl bg-amber-50 border border-amber-300 p-6">
          <p className="text-sm font-body font-bold text-amber-800 mb-1">📨 Telegram channel is OFF</p>
          <p className="text-xs font-body text-amber-700">
            Set TELEGRAM_BOT_TOKEN in .env (from @BotFather) and restart the server.
          </p>
          <p className="text-[11px] font-body text-amber-600 mt-2">
            Setup: Telegram → @BotFather → /newbot → copy token → paste in .env → restart server. Full guide in walkthrough.md §8.
          </p>
        </div>
      )}

      {enabled && sessions.length === 0 && !loading && (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-12 text-center">
          <Bot className="w-8 h-8 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-body text-slate-500 font-medium">No conversations yet</p>
          <p className="text-xs font-body text-slate-400 mt-1">
            Message your bot on Telegram — sessions appear here in real time.
          </p>
        </div>
      )}

      {sessions.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          {/* Session list */}
          <div className="lg:col-span-2 space-y-2.5">
            {sessions.map((s) => (
              <div
                key={s.chatId}
                onClick={() =>
                  onOpenInAgent?.({
                    id: `tg_${s.chatId}`,
                    customerName: s.customerName,
                    customerEmail: undefined,
                    amount: s.amountDueInr,
                    declineCode: s.declineCode,
                    channel: "telegram",
                    state: s.recovered ? "RECOVERED" : s.optedOut ? "SKIPPED_COMPLIANCE" : s.promisedDate ? "PAUSED_PROMISE" : s.paymentLink ? "INTERVENING" : "POLICY_SELECTED",
                    promisedDate: s.promisedDate,
                    optedOut: s.optedOut,
                    recovered: s.recovered,
                    paymentLinkStatus: s.paymentLink?.status,
                  })
                }
                className={`rounded-2xl border p-4 text-left transition-all cursor-pointer group ${
                  selectedId === s.chatId
                    ? "bg-emerald-50/60 border-emerald-300 shadow-sm"
                    : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-bold font-heading text-slate-900">{s.customerName}</span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${
                      s.recovered
                        ? "bg-emerald-100 text-emerald-700 border-emerald-300"
                        : s.optedOut
                          ? "bg-orange-100 text-orange-700 border-orange-300"
                          : "bg-amber-50 text-amber-700 border-amber-300"
                    }`}
                  >
                    {s.recovered ? "Recovered" : s.optedOut ? "Opted Out" : "Active"}
                  </span>
                </div>
                <p className="text-xs font-mono text-slate-400">chat #{s.chatId}</p>
                <div className="flex items-center gap-3 mt-2 text-[11px] font-body">
                  <span className="font-semibold text-slate-700">{inr(s.amountDueInr)}</span>
                  {s.promisedDate && (
                    <span className="flex items-center gap-1 text-violet-600">
                      <Clock className="w-3 h-3" /> {s.promisedDate}
                    </span>
                  )}
                  {s.paymentLink && (
                    <span className={`flex items-center gap-1 ${s.paymentLink.status === "paid" ? "text-emerald-600" : "text-brand-orange"}`}>
                      <CircleDollarSign className="w-3 h-3" /> link {s.paymentLink.status}
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(s.chatId);
                  }}
                  className="mt-2.5 text-[10px] font-bold font-body text-brand-orange hover:underline cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  👁 Preview here (without leaving)
                </button>
              </div>
            ))}
          </div>

          {/* Conversation + actions */}
          {selected && (
            <div className="lg:col-span-3 space-y-4">
              {/* Telegram-style transcript */}
              <div className="rounded-2xl overflow-hidden shadow-sm border border-slate-200 flex flex-col" style={{ background: "#efeae2" }}>
                <div className="bg-[#075E54] text-white px-5 py-3 flex items-center gap-3">
                  <Bot className="w-4 h-4" />
                  <div>
                    <p className="text-sm font-bold font-heading">RazorVasooli AI Agent</p>
                    <p className="text-[10px] opacity-80">Telegram · negotiating with {selected.customerName}</p>
                  </div>
                </div>
                <div className="p-4 space-y-2.5 max-h-[420px] overflow-y-auto">
                  {selected.transcript.length === 0 && (
                    <p className="text-center text-xs text-slate-400 py-8">No messages yet.</p>
                  )}
                  {selected.transcript.map((t, i) =>
                    t.dir === "system" ? (
                      <div key={i} className="flex justify-center">
                        <span className="bg-white/90 border border-slate-200 rounded-full px-3.5 py-1.5 text-[10px] font-bold font-body text-emerald-700">{t.text}</span>
                      </div>
                    ) : (
                      <div key={i} className={`flex ${t.dir === "in" ? "justify-start" : "justify-end"}`}>
                        <div className={`max-w-[75%] rounded-xl px-3.5 py-2 text-xs font-body leading-relaxed shadow-sm ${t.dir === "in" ? "bg-white text-slate-800" : "bg-[#DCF8C6] text-slate-900"}`}>
                          {t.text}
                          {t.payLink && (
                            <a href={t.payLink} target="_blank" rel="noreferrer" className="mt-2 block bg-emerald-600 hover:bg-emerald-700 text-white text-center font-bold rounded-lg px-3 py-1.5 no-underline">💳 Pay Now</a>
                          )}
                          <span className="block text-right text-[9px] text-slate-400 mt-1">{new Date(t.at).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* Agent actions timeline */}
              <div className="rounded-2xl bg-white border border-slate-200 p-5">
                <h4 className="text-sm font-bold font-heading text-slate-900 mb-3 flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-violet-600" /> Agent Actions (guardrailed tools)
                </h4>
                {selected.actions.length === 0 ? (
                  <p className="text-xs font-body text-slate-400">No tool calls yet.</p>
                ) : (
                  <div className="space-y-2">
                    {[...selected.actions].reverse().map((a, i) => (
                      <div key={i} className="flex items-start gap-2.5 text-xs font-body">
                        <span className="mt-0.5 px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-bold uppercase whitespace-nowrap">{a.tool.replace(/_/g, " ")}</span>
                        <span className={`flex-1 ${a.detail.includes("rejected") ? "text-red-600 font-semibold" : "text-slate-600"}`}>{a.detail}</span>
                        <span className="text-[10px] text-slate-300 font-mono">{new Date(a.at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-[11px] font-body text-slate-400">
                  <ShieldOff className="w-3.5 h-3.5 flex-shrink-0" />
                  Discounts hard-capped at 10% · DPDP opt-outs enforced in code · every call audited
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
