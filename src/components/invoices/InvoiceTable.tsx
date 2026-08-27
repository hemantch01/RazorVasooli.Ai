import { ArrowUpDown } from "lucide-react";
import type { FailedInvoice } from "../../types";
import { InvoiceTableRow } from "./InvoiceTableRow";
import { useState } from "react";

export function InvoiceTable({
  invoices,
  isProcessing,
  expandedId,
  setExpandedId,
  handleRecoverInvoice,
}: {
  invoices: FailedInvoice[];
  isProcessing: boolean;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  handleRecoverInvoice: (inv: FailedInvoice) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof FailedInvoice | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (key: keyof FailedInvoice) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sorted = sortKey
    ? [...invoices].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        let cmp: number;
        if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
        else if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
        else cmp = 0;
        return sortDir === "asc" ? cmp : -cmp;
      })
    : invoices;

  return (
    <div className="rounded-2xl bg-white border border-slate-200/90 overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70">
              {[
                { label: "Invoice ID", key: "id" as const },
                { label: "Customer (PII Masked)", key: "customerName" as const },
                { label: "Amount", key: "amount" as const },
                { label: "Decline Code", key: "declineCode" as const },
                { label: "Recovery Status", key: "status" as const },
                { label: "Channel", key: "channel" as const },
                { label: "Failed At", key: "failedAt" as const },
                { label: "Retries", key: "retryCount" as const },
                { label: "Action", key: null },
              ].map(({ label, key }) => (
                <th
                  key={label}
                  className="px-4 py-3.5 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500 font-body"
                >
                  <span
                    onClick={() => key && toggleSort(key)}
                    className={`flex items-center gap-1 transition-colors ${
                      key ? "cursor-pointer hover:text-slate-900" : ""
                    }`}
                  >
                    {label}
                    {key && (
                      <ArrowUpDown
                        className={`w-3 h-3 ${
                          sortKey === key ? "text-brand-orange opacity-100" : "opacity-40"
                        } ${sortKey === key && sortDir === "asc" ? "rotate-180" : ""}`}
                      />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((inv) => (
              <InvoiceTableRow
                key={inv.id}
                inv={inv}
                isExpanded={expandedId === inv.id}
                onToggleExpand={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
                onRecover={() => handleRecoverInvoice(inv)}
                isProcessing={isProcessing}
              />
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <p className="text-sm text-slate-500 font-body">
            No failed invoices found
          </p>
        </div>
      )}
    </div>
  );
}
