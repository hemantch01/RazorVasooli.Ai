import { Search, Filter } from "lucide-react";
import type { RecoveryStatus } from "../../types";
import { STATUS_STYLES } from "./constants";

export function InvoiceFilters({
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
}: {
  searchQuery: string;
  setSearchQuery: (s: string) => void;
  statusFilter: RecoveryStatus | "all";
  setStatusFilter: (s: RecoveryStatus | "all") => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search by ID, customer, or decline code…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-sm font-body text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 shadow-2xs transition-all"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="w-4 h-4 text-slate-400 mr-1" />
        {(
          ["all", "pending", "ai_contacted", "link_sent", "recovered", "failed", "escalated"] as const
        ).map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-3 py-1.5 rounded-xl text-xs font-body font-medium transition-all cursor-pointer border
              ${
                statusFilter === status
                  ? "bg-orange-50 text-brand-orange font-semibold border-orange-300 shadow-2xs"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900"
              }`}
          >
            {status === "all" ? "All" : STATUS_STYLES[status as RecoveryStatus]?.label || status}
          </button>
        ))}
      </div>
    </div>
  );
}
