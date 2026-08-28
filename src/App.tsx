import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Phone } from "lucide-react";
import { Sidebar } from "./components/common/Sidebar";
import { Navbar } from "./components/common/Navbar";
import { OverviewView } from "./components/dashboard/OverviewView";

import { FailedInvoicesView } from "./components/invoices/FailedInvoicesView";

import { RecoveryPlaybooksView } from "./components/playbooks/RecoveryPlaybooksView";
import { CaseDirectoryView } from "./components/cases/CaseDirectoryView";
import { AuditLedgerView } from "./components/audit/AuditLedgerView";
import { TelegramLiveView } from "./components/agent/TelegramLiveView";
import { EmailConversationsView } from "./components/agent/EmailConversationsView";
import { ComingSoonView } from "./components/common/ComingSoonView";
import { LoginPage } from "./components/auth/LoginPage";
import type { ViewId, AgentTargetDetails } from "./types";

function App() {
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [authState, setAuthState] = useState<"checking" | "authed" | "guest">("checking");
  /** Open a live conversation inside the AI Vasooli Agent tab. */
  const openInAgent = useCallback((_target: AgentTargetDetails) => {
    // setActiveView("agent");
  }, []);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => setAuthState(r.ok ? "authed" : "guest"))
      .catch(() => setAuthState("guest"));
  }, []);

  const renderView = () => {
    switch (activeView) {
      case "overview":
        return <OverviewView />;
      case "invoices":
        return <FailedInvoicesView />;
      case "webhooks":
        return <div>Webhooks View (Moved to Backend)</div>;
      case "playbooks":
        return <RecoveryPlaybooksView />;
      case "cases":
        return <CaseDirectoryView onOpenInAgent={openInAgent} />;
      case "telegram":
        return <TelegramLiveView onOpenInAgent={openInAgent} />;
      case "email":
        return <EmailConversationsView onOpenInAgent={openInAgent} />;
      case "whatsapp":
        return (
          <ComingSoonView
            title="WhatsApp Recovery Channel"
            icon={MessageSquare}
            accent="emerald"
            reason="Meta Business verification and message-template approvals are pending. WhatsApp Cloud API integration will activate as soon as the business account is approved."
          />
        );
      case "ivr":
        return (
          <ComingSoonView
            title="IVR Voice Calls"
            icon={Phone}
            accent="violet"
            reason="Regulatory decision pending — a telephony provider (Exotel/Knowlarity/Twilio) must be onboarded and call-recording compliance signed off before live outbound voice calls go out."
            detail="Voice scripts and Gemini TTS audio generation are already working (see AI Vasooli Agent → 🎙️ Simulate Voice Call). Only the phone-line transport is waiting."
          />
        );
      case "audit":
        return <AuditLedgerView />;
      default:
        return <OverviewView />;
    }
  };

  if (authState === "checking") {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-sm font-body text-slate-400">Loading…</p>
      </div>
    );
  }

  if (authState === "guest") {
    return <LoginPage onLogin={() => setAuthState("authed")} />;
  }

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-800">
      <Sidebar activeView={activeView} onNavigate={setActiveView} />
      <div className="flex-1 ml-64 flex flex-col min-w-0">
        <Navbar onNavigate={setActiveView} />
        <main className="p-8 max-w-7xl w-full mx-auto">{renderView()}</main>
      </div>
    </div>
  );
}

export default App;
