import { useState } from "react";

export interface ComingSoonViewProps {
  title: string;
  icon: React.ElementType;
  accent: "emerald" | "violet";
  reason: string;
  detail?: string;
}

/** Placeholder page for channels awaiting regulatory/provider decisions. */
export function ComingSoonView({ title, icon: Icon, accent, reason, detail }: ComingSoonViewProps) {
  const [notify, setNotify] = useState(false);
  const accents = {
    emerald: "from-emerald-500/10 to-emerald-500/5 text-emerald-600 border-emerald-200",
    violet: "from-violet-500/10 to-violet-500/5 text-violet-600 border-violet-200",
  };
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-extrabold font-heading text-slate-900">{title}</h2>
        <p className="text-sm text-slate-500 font-body mt-1">Live customer recovery channel</p>
      </div>

      <div className={`rounded-2xl border bg-gradient-to-br p-10 text-center max-w-xl mx-auto ${accents[accent]}`}>
        <div className="w-20 h-20 rounded-3xl bg-white border shadow-sm flex items-center justify-center mx-auto mb-5">
          <Icon className="w-10 h-10" />
        </div>
        <span className="inline-block px-3 py-1 rounded-full bg-slate-900 text-white text-[10px] font-bold uppercase tracking-widest mb-4">
          Coming Soon
        </span>
        <h3 className="text-lg font-bold font-heading text-slate-900 mb-2">
          Regulatory decision pending
        </h3>
        <p className="text-sm font-body text-slate-600 leading-relaxed">{reason}</p>
        <p className="text-xs font-body text-slate-400 mt-3">{detail}</p>

        <button
          onClick={() => setNotify(true)}
          className="mt-6 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-body font-bold hover:bg-slate-800 cursor-pointer"
        >
          {notify ? "✅ Noted — we'll surface it here once approved" : "Notify me when live"}
        </button>
      </div>

      <p className="text-xs font-body text-slate-400 text-center max-w-xl mx-auto">
        Meanwhile, the AI agent is fully live on <strong className="text-emerald-600">Telegram</strong> and{" "}
        <strong className="text-indigo-600">Email</strong> — see those views in the sidebar.
      </p>
    </div>
  );
}
