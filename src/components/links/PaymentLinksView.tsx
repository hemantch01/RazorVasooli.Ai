import { useState, useEffect, useCallback } from "react";
import {
  Link2,
  Plus,
  Copy,
  Check,
  Trash2,
  ExternalLink,
  RefreshCw,
  CreditCard,
  Database,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from "lucide-react";

export interface PaymentLinkRecord {
  id: string;
  shortUrl: string;
  amountInr: number;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  caseId?: string | null;
  notes?: string | null;
  status?: string;
  simulated?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export function PaymentLinksView() {
  const [links, setLinks] = useState<PaymentLinkRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  // Generator Form state
  const [form, setForm] = useState({
    amountInr: "501",
    customerEmail: "",
    customerPhone: "",
    customerName: "",
    caseId: "",
    notes: "",
  });

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/recovery/payment-links");
      if (res.ok) {
        const data = await res.json();
        setLinks(data.links || []);
      }
    } catch (err) {
      console.error("Failed to load payment links:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  const handleCopy = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Are you sure you want to remove link ${id} from database?`)) return;
    try {
      const res = await fetch(`/api/recovery/payment-links/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setLinks((prev) => prev.filter((l) => l.id !== id));
        setToast({ type: "success", msg: `Link ${id} deleted from database.` });
      }
    } catch (err) {
      console.error("Failed to delete link:", err);
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(form.amountInr);
    if (isNaN(amt) || amt <= 0) {
      setToast({ type: "error", msg: "Please enter a valid amount in INR" });
      return;
    }

    setSubmitting(true);
    setToast(null);

    try {
      const res = await fetch("/api/recovery/create-payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          customerEmail: form.customerEmail.trim() || undefined,
          customerPhone: form.customerPhone.trim() || undefined,
          customerName: form.customerName.trim() || "Valued Customer",
          caseId: form.caseId.trim() || undefined,
          description: form.notes.trim() || `RazorVasooli AI Recovery Payment for ₹${amt}`,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setToast({
          type: "success",
          msg: `✅ Real Razorpay Link created & persisted to DB: ${data.shortUrl}`,
        });
        setForm({
          amountInr: "501",
          customerEmail: "",
          customerPhone: "",
          customerName: "",
          caseId: "",
          notes: "",
        });
        fetchLinks();
      } else {
        setToast({ type: "error", msg: data.error || data.details || "Failed to generate link" });
      }
    } catch (err: any) {
      setToast({ type: "error", msg: err.message || "Network error" });
    } finally {
      setSubmitting(false);
    }
  };

  const totalActive = links.filter((l) => l.status !== "expired").length;
  const totalAmount = links.reduce((sum, l) => sum + (l.amountInr || 0), 0);

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
              <CreditCard className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 font-heading">
                Payment Links Generator & Registry
              </h1>
              <p className="text-sm text-slate-500 font-body">
                Official Razorpay links stored in PostgreSQL DB — automatically reused across Gmail, Telegram, and Invoices
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchLinks}
            disabled={loading}
            className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 flex items-center gap-2 shadow-xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Sync DB
          </button>
        </div>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-white border border-slate-200/90 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider font-body">
              Active Links in DB
            </p>
            <span className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-xs">
              <Database className="w-4 h-4" />
            </span>
          </div>
          <p className="text-2xl font-bold text-slate-900 font-heading mt-2">{totalActive}</p>
          <p className="text-xs text-slate-400 font-body mt-1">Available for instant outreach</p>
        </div>

        <div className="rounded-2xl bg-white border border-slate-200/90 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider font-body">
              Total Managed Amount
            </p>
            <span className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-xs">
              ₹
            </span>
          </div>
          <p className="text-2xl font-bold text-slate-900 font-heading mt-2">
            ₹{totalAmount.toLocaleString("en-IN")}
          </p>
          <p className="text-xs text-slate-400 font-body mt-1">Across all registered links</p>
        </div>

        <div className="rounded-2xl bg-white border border-slate-200/90 p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider font-body">
              Cross-Channel Reuse
            </p>
            <span className="w-8 h-8 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center font-bold text-xs">
              <Sparkles className="w-4 h-4" />
            </span>
          </div>
          <p className="text-sm font-bold text-emerald-600 font-heading mt-2 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Zero Duplicate Spawns
          </p>
          <p className="text-xs text-slate-400 font-body mt-1">Agents reuse DB links automatically</p>
        </div>
      </div>

      {toast && (
        <div
          className={`p-4 rounded-xl text-xs font-body flex items-center gap-3 animate-slide-up ${
            toast.type === "success"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
          )}
          <span className="font-medium">{toast.msg}</span>
        </div>
      )}

      {/* Generator Form Section */}
      <div className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
            <Plus className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 font-heading">
              Generate Live Razorpay Payment Link
            </h2>
            <p className="text-xs text-slate-500 font-body">
              Creates an authentic Razorpay link via live API and stores it in PostgreSQL
            </p>
          </div>
        </div>

        <form onSubmit={handleGenerate} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Amount in INR (₹) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                required
                min="1"
                step="1"
                placeholder="501"
                value={form.amountInr}
                onChange={(e) => setForm({ ...form, amountInr: e.target.value })}
                className="w-full text-xs px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Customer Email <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="email"
                placeholder="hemantchaudhary905@gmail.com"
                value={form.customerEmail}
                onChange={(e) => setForm({ ...form, customerEmail: e.target.value })}
                className="w-full text-xs px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Customer Phone <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="tel"
                placeholder="+919675007026"
                value={form.customerPhone}
                onChange={(e) => setForm({ ...form, customerPhone: e.target.value })}
                className="w-full text-xs px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Customer Name <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                placeholder="Hemant Kumar"
                value={form.customerName}
                onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                className="w-full text-xs px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Case ID / Ref <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                placeholder="evt_1788102798013"
                value={form.caseId}
                onChange={(e) => setForm({ ...form, caseId: e.target.value })}
                className="w-full text-xs px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Notes / Purpose <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                placeholder="AI Recovery link for failed mandate"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full text-xs px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold font-heading flex items-center gap-2 shadow-sm shadow-indigo-200 cursor-pointer disabled:opacity-50 transition-all"
            >
              {submitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Generating via Razorpay API...
                </>
              ) : (
                <>
                  <CreditCard className="w-3.5 h-3.5" />
                  Generate Razorpay Payment Link
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Database Repository Table */}
      <div className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900 font-heading">
              Persisted Payment Links in Database
            </h2>
            <p className="text-xs text-slate-500 font-body">
              All active records stored in PostgreSQL (`RegisteredPaymentLink` table)
            </p>
          </div>
          <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-700">
            {links.length} total links
          </span>
        </div>

        {links.length === 0 ? (
          <div className="py-12 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-200">
            <Link2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-600 font-heading">No payment links in database</p>
            <p className="text-xs text-slate-400 font-body mt-1">Use the generator above to create your first link.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-left text-xs font-body">
              <thead className="bg-slate-50 text-slate-600 uppercase text-[10px] tracking-wider border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">Amount</th>
                  <th className="py-3 px-4">Razorpay Short URL</th>
                  <th className="py-3 px-4">Link ID</th>
                  <th className="py-3 px-4">Customer Details</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Created / Notes</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {links.map((link) => (
                  <tr key={link.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-heading font-bold text-slate-900 text-sm">
                      ₹{link.amountInr.toLocaleString("en-IN")}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <a
                          href={link.shortUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-indigo-600 hover:text-indigo-800 hover:underline flex items-center gap-1 font-semibold"
                        >
                          {link.shortUrl}
                          <ExternalLink className="w-3 h-3 flex-shrink-0" />
                        </a>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-500">
                      {link.id}
                    </td>
                    <td className="py-3 px-4 text-slate-600">
                      <div>
                        {link.customerEmail && (
                          <span className="block font-mono text-[11px] text-slate-700">
                            {link.customerEmail}
                          </span>
                        )}
                        {link.customerPhone && (
                          <span className="block font-mono text-[10px] text-slate-500">
                            {link.customerPhone}
                          </span>
                        )}
                        {!link.customerEmail && !link.customerPhone && (
                          <span className="text-slate-400">—</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          link.status === "paid"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : link.status === "expired"
                            ? "bg-red-50 text-red-700 border border-red-200"
                            : "bg-indigo-50 text-indigo-700 border border-indigo-200"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            link.status === "paid"
                              ? "bg-emerald-500"
                              : link.status === "expired"
                              ? "bg-red-500"
                              : "bg-indigo-500"
                          }`}
                        />
                        {link.status || "created"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-500 text-[11px]">
                      <div>
                        {link.notes ? (
                          <span className="block text-slate-700 truncate max-w-[160px]" title={link.notes}>
                            {link.notes}
                          </span>
                        ) : null}
                        <span className="text-[10px] text-slate-400">
                          {link.createdAt ? new Date(link.createdAt).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleCopy(link.shortUrl, link.id)}
                          className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                          title="Copy Payment URL"
                        >
                          {copiedId === link.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => handleDelete(link.id)}
                          className="p-2 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors cursor-pointer"
                          title="Delete link from DB"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
