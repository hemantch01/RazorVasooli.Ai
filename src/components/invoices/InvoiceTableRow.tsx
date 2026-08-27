import { Fragment } from "react";
import { Bot, ExternalLink, MessageSquare, Mail, Smartphone, Phone } from "lucide-react";
import type { FailedInvoice } from "../../types";
import { STATUS_STYLES } from "./constants";

const CHANNEL_ICONS = {
  whatsapp: MessageSquare,
  sms: Smartphone,
  email: Mail,
  ivr: Phone,
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function InvoiceTableRow({
  inv,
  isExpanded,
  onToggleExpand,
  onRecover,
  isProcessing,
}: {
  inv: FailedInvoice;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRecover: () => void;
  isProcessing: boolean;
}) {
  const statusStyle = STATUS_STYLES[inv.status];
  const ChannelIcon = CHANNEL_ICONS[inv.channel as keyof typeof CHANNEL_ICONS] || Bot;

  return (
    <Fragment>
      <tr className="hover:bg-slate-50/80 transition-colors">
        <td className="px-4 py-4">
          <span className="text-xs font-mono text-brand-orange font-semibold">
            {inv.id}
          </span>
        </td>
        <td className="px-4 py-4">
          <div>
            <p className="text-sm font-semibold text-slate-900 font-body">
              {inv.customerName}
            </p>
            <p className="text-xs text-slate-400 font-body font-mono">
              {inv.customerEmail}
            </p>
          </div>
        </td>
        <td className="px-4 py-4">
          <span className="text-sm font-bold text-slate-900 font-heading">
            {formatCurrency(inv.amount)}
          </span>
        </td>
        <td className="px-4 py-4">
          <span className="px-2.5 py-1 text-[10px] font-mono font-bold rounded-md bg-pink-50 text-brand-pink border border-pink-200">
            {inv.declineCode}
          </span>
        </td>
        <td className="px-4 py-4">
          <span
            className={`inline-flex items-center px-2.5 py-1 text-[11px] font-semibold rounded-full ${statusStyle.bg} ${statusStyle.text} border ${statusStyle.border}`}
          >
            {statusStyle.label}
          </span>
        </td>
        <td className="px-4 py-4">
          <div className="flex items-center gap-1.5 text-slate-600">
            <ChannelIcon className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs font-body capitalize">{inv.channel}</span>
          </div>
        </td>
        <td className="px-4 py-4">
          <span className="text-xs text-slate-500 font-body">
            {formatDate(inv.failedAt)}
          </span>
        </td>
        <td className="px-4 py-4 text-center">
          <span className="text-xs font-bold text-slate-700 font-body px-2 py-0.5 rounded-full bg-slate-100">
            {inv.retryCount}
          </span>
        </td>
        <td className="px-4 py-4">
          <div className="flex items-center gap-2">
            <button
              onClick={onRecover}
              disabled={isProcessing || inv.status === "recovered"}
              className="p-1.5 rounded-lg bg-orange-50 text-brand-orange hover:bg-orange-100 disabled:opacity-40 transition-colors cursor-pointer border border-orange-200"
              title="Trigger AI Recovery"
            >
              <Bot className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onToggleExpand}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer border ${
                isExpanded
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900 border-transparent"
              }`}
              title="View Details"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-slate-50/70">
          <td colSpan={9} className="px-4 py-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-body">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Customer Email
                </p>
                <p className="font-mono text-slate-700">{inv.customerEmail}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Subscription
                </p>
                <p className="font-mono text-slate-700">{inv.subscriptionId}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Last Contacted
                </p>
                <p className="text-slate-700">
                  {inv.lastContactedAt ? new Date(inv.lastContactedAt).toLocaleString() : "Never"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Recovery Tip
                </p>
                <p className="text-slate-700">
                  {inv.declineCode === "INSUFFICIENT_FUNDS"
                    ? "Soft decline — retry after payday (1st–7th) has highest success."
                    : inv.declineCode === "CARD_EXPIRED"
                    ? "Send update-method link; UPI mandate converts best."
                    : "Hard decline — escalate early, offer settlement link."}
                </p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
