import { useState } from "react";
import { PrimaryButton } from "../common/PrimaryButton";
import type { RecoveryPlaybook, PlaybookPersona } from "../../types";

const recoveryPlaybooks: RecoveryPlaybook[] = [
  {
    id: "pb-001",
    name: "Standard B2B Dunning",
    persona: "strict_b2b",
    description: "Formal, direct communication emphasizing contract terms. Best for enterprise clients.",
    active: true,
    successRate: 42,
    maxRetries: 3,
    retryDelayHours: 48,
    channels: ["email"]
  },
  {
    id: "pb-002",
    name: "Aggressive B2C Recovery",
    persona: "dynamic_upi",
    description: "High-frequency nudges with UPI intent links. Best for sub-$100 failed subscriptions.",
    active: true,
    successRate: 68,
    maxRetries: 5,
    retryDelayHours: 12,
    discountPercent: 10,
    channels: ["whatsapp", "sms", "email"]
  }
];

import {
  BookOpen,
  MessageSquare,
  Mail,
  Smartphone,
  Phone,
  Percent,
  Clock,
  RotateCcw,
  BarChart3,
  Settings,
  Power,
} from "lucide-react";

const PERSONA_STYLES: Record<
  PlaybookPersona,
  { label: string; color: string; bg: string; border: string }
> = {
  empathetic_saas: {
    label: "Empathetic SaaS",
    color: "text-brand-orange",
    bg: "bg-orange-50",
    border: "border-orange-200",
  },
  strict_b2b: {
    label: "Strict B2B",
    color: "text-brand-pink",
    bg: "bg-pink-50",
    border: "border-pink-200",
  },
  discount_incentivized: {
    label: "Discount Focused",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
  },
  dynamic_upi: {
    label: "Dynamic UPI",
    color: "text-brand-violet",
    bg: "bg-purple-50",
    border: "border-purple-200",
  },
};

const CHANNEL_ICONS = {
  whatsapp: MessageSquare,
  sms: Smartphone,
  email: Mail,
  ivr: Phone,
};

export function RecoveryPlaybooksView() {
  const [playbooks, setPlaybooks] = useState<RecoveryPlaybook[]>(recoveryPlaybooks);
  const [notice, setNotice] = useState<string | null>(null);

  const togglePlaybook = (id: string) => {
    setPlaybooks((prev) =>
      prev.map((pb) => (pb.id === id ? { ...pb, active: !pb.active } : pb))
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold font-heading text-slate-900">
            Recovery Playbooks
          </h2>
          <p className="text-sm text-slate-500 font-body mt-1">
            Configure AI recovery strategies, dunning personas, and discount budgets
          </p>
        </div>
        <PrimaryButton size="sm" onClick={() => setNotice("Playbook builder is not part of the demo yet.")}>
          <BookOpen className="w-4 h-4 mr-2" />
          Create New Playbook
        </PrimaryButton>
      </div>

      {notice && (
        <p className="text-xs font-body text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
          {notice}
        </p>
      )}

      {/* Playbook Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {playbooks.map((pb: RecoveryPlaybook) => {
          const persona = PERSONA_STYLES[pb.persona];
          return (
            <div
              key={pb.id}
              className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm hover:shadow-md transition-all animate-slide-up flex flex-col justify-between"
            >
              <div>
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1 pr-4">
                    <div className="flex items-center gap-2.5 mb-2">
                      <h3 className="text-lg font-bold font-heading text-slate-900">
                        {pb.name}
                      </h3>
                      <span
                        className={`px-2.5 py-0.5 text-[10px] font-bold uppercase rounded-full ${persona.bg} ${persona.color} border ${persona.border}`}
                      >
                        {persona.label}
                      </span>
                    </div>
                    <p className="text-sm text-slate-600 font-body leading-relaxed">
                      {pb.description}
                    </p>
                  </div>
                  <button
                    onClick={() => togglePlaybook(pb.id)}
                    className={`p-2 rounded-xl transition-colors cursor-pointer border ${
                      pb.active
                        ? "bg-emerald-50 text-emerald-600 border-emerald-200"
                        : "bg-slate-100 text-slate-400 border-slate-200"
                    }`}
                    title={pb.active ? "Active — click to pause" : "Inactive — click to activate"}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 gap-3 mb-5">
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200/70">
                    <BarChart3 className="w-4 h-4 text-emerald-600" />
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider font-body">
                        Success Rate
                      </p>
                      <p className="text-sm font-bold font-heading text-emerald-700">
                        {pb.successRate}%
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200/70">
                    <RotateCcw className="w-4 h-4 text-brand-orange" />
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider font-body">
                        Max Retries
                      </p>
                      <p className="text-sm font-bold font-heading text-slate-900">
                        {pb.maxRetries} Attempts
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200/70">
                    <Clock className="w-4 h-4 text-brand-violet" />
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider font-body">
                        Retry Delay
                      </p>
                      <p className="text-sm font-bold font-heading text-slate-900">
                        Every {pb.retryDelayHours} Hours
                      </p>
                    </div>
                  </div>
                  {pb.discountPercent && (
                    <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200/70">
                      <Percent className="w-4 h-4 text-brand-pink" />
                      <div>
                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider font-body">
                          Max Discount
                        </p>
                        <p className="text-sm font-bold font-heading text-brand-pink">
                          {pb.discountPercent}% Off
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Channels & Action */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                <div className="flex items-center gap-1.5">
                  {pb.channels.map((ch) => {
                    const Icon = CHANNEL_ICONS[ch];
                    return (
                      <div
                        key={ch}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 text-xs"
                        title={ch}
                      >
                        <Icon className="w-3 h-3 text-slate-500" />
                        <span className="text-[11px] font-body capitalize">
                          {ch}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <button className="p-2 rounded-xl bg-slate-50 border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer">
                  <Settings className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
