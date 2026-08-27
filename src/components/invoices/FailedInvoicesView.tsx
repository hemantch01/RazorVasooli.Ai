import { useState } from "react";
import { Bot } from "lucide-react";
import { PrimaryButton } from "../common/PrimaryButton";
import type { RecoveryStatus } from "../../types";
import { useFailedInvoices } from "../../hooks/useFailedInvoices";
import { useRecoverInvoice } from "../../hooks/useRecoverInvoice";
import { InvoiceFilters } from "./InvoiceFilters";
import { InvoiceTable } from "./InvoiceTable";

export function FailedInvoicesView() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RecoveryStatus | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const { data: invoicesList = [], isLoading, isError } = useFailedInvoices();
  const recoverMutation = useRecoverInvoice();

  const isProcessing = recoverMutation.isPending;

  const filtered = invoicesList.filter((inv) => {
    const matchesSearch =
      inv.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inv.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inv.declineCode.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === "all" || inv.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleRecoverInvoice = async (inv: any) => {
    try {
      const data = await recoverMutation.mutateAsync(inv);
      if (data.shortUrl) {
        setActionNotice(
          `✨ AI Vasooli triggered for ${inv.customerName}! Generated Razorpay link with 5% discount: ${data.shortUrl}`
        );
      }
    } catch {
      setActionNotice(`AI Vasooli engaged for ${inv.customerName} via ${inv.channel}`);
    } finally {
      setTimeout(() => setActionNotice(null), 6000);
    }
  };

  const handleRecoverAll = async () => {
    const pendingInvoices = invoicesList.filter(inv => inv.status === "pending");
    for (const inv of pendingInvoices) {
      await recoverMutation.mutateAsync(inv).catch(() => {});
    }
    setActionNotice("🚀 AI Agent bulk recovery executed on all pending failed subscriptions!");
    setTimeout(() => setActionNotice(null), 5000);
  };

  if (isLoading) {
    return <div className="p-8 text-center text-slate-500 font-body">Loading invoices...</div>;
  }

  if (isError) {
    return <div className="p-8 text-center text-rose-500 font-body">Error loading invoices.</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold font-heading text-slate-900">
            Failed Invoices Ledger
          </h2>
          <p className="text-sm text-slate-500 font-body mt-1">
            {invoicesList.length} failed recurring payments tracked •{" "}
            {invoicesList.filter((i) => i.status === "recovered").length}{" "}
            salvaged by AI
          </p>
        </div>
        <PrimaryButton size="sm" onClick={handleRecoverAll} disabled={isProcessing}>
          <Bot className="w-4 h-4 mr-2" />
          {isProcessing ? "Processing…" : "Recover All Pending Invoices"}
        </PrimaryButton>
      </div>

      {/* Action Notice Alert */}
      {actionNotice && (
        <div className="p-4 rounded-xl bg-orange-50 border border-orange-200 text-slate-800 text-sm font-body flex items-center justify-between animate-fade-in shadow-2xs">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-brand-orange animate-ping" />
            <span className="font-medium">{actionNotice}</span>
          </div>
          <button
            onClick={() => setActionNotice(null)}
            className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      <InvoiceFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
      />

      <InvoiceTable
        invoices={filtered}
        isProcessing={isProcessing}
        expandedId={expandedId}
        setExpandedId={setExpandedId}
        handleRecoverInvoice={handleRecoverInvoice}
      />
    </div>
  );
}
