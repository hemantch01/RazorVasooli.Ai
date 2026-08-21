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

// TODO: complete implementation step 7
