import {
  LayoutDashboard,
  Link2,
  FileWarning,
  Webhook,
  BookOpen,
  Zap,
  FolderSearch,
  Send,
  Mail,
  MessageSquare,
  Phone,
  ShieldCheck,
} from "lucide-react";
import type { ViewId } from "../../types";

interface SidebarProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
}

const NAV_ITEMS: { id: ViewId; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Command Center", icon: LayoutDashboard },
  { id: "links", label: "Payment Links", icon: Link2 },
  { id: "cases", label: "Case Directory", icon: FolderSearch },
  { id: "invoices", label: "Failed Invoices", icon: FileWarning },
  { id: "telegram", label: "Telegram Live", icon: Send },
  { id: "email", label: "Email Inbox", icon: Mail },
  { id: "whatsapp", label: "WhatsApp", icon: MessageSquare },
  { id: "ivr", label: "IVR Voice", icon: Phone },
  { id: "webhooks", label: "Webhook Stream", icon: Webhook },
  { id: "playbooks", label: "Recovery Playbooks", icon: BookOpen },
  { id: "audit", label: "Audit Ledger", icon: ShieldCheck },
];

export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-white border-r border-slate-200 flex flex-col z-30 shadow-sm">
      {/* Brand */}
      <div className="p-6 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-orange/20 to-brand-peach/30 flex items-center justify-center border border-brand-orange/20">
            <Zap className="w-5 h-5 text-brand-orange" />
          </div>
          <div>
            <h1 className="text-base font-bold font-heading text-slate-900 leading-tight">
              RazorVasooli
            </h1>
            <p className="text-[10px] font-body text-slate-400 font-semibold tracking-wider uppercase">
              AI Revenue Recovery
            </p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-5 px-3 space-y-1.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = activeView === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-body font-medium transition-all cursor-pointer
                ${
                  isActive
                    ? "bg-brand-orange/10 text-brand-orange font-semibold border border-brand-orange/30 shadow-xs"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-transparent"
                }`}
            >
              <Icon className={`w-4.5 h-4.5 flex-shrink-0 ${isActive ? "text-brand-orange" : "text-slate-400"}`} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Footer badge */}
      <div className="p-4 border-t border-slate-100">
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200/80">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <div>
            <span className="text-xs font-body font-semibold text-emerald-700 block leading-tight">
              Razorpay Engine
            </span>
            <span className="text-[10px] text-emerald-600/80 font-body">
              Auto-recovery active
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
