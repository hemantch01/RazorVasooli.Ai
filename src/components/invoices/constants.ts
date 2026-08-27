import type { RecoveryStatus } from "../../types";

export const STATUS_STYLES: Record<
  RecoveryStatus,
  { bg: string; text: string; border: string; label: string }
> = {
  pending: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    border: "border-slate-200",
    label: "Pending",
  },
  ai_contacted: {
    bg: "bg-orange-50",
    text: "text-brand-orange",
    border: "border-orange-200",
    label: "AI Contacted",
  },
  link_sent: {
    bg: "bg-purple-50",
    text: "text-brand-violet",
    border: "border-purple-200",
    label: "Link Sent",
  },
  recovered: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    label: "Recovered",
  },
  failed: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    border: "border-rose-200",
    label: "Failed",
  },
  escalated: {
    bg: "bg-pink-50",
    text: "text-brand-pink",
    border: "border-pink-200",
    label: "Escalated",
  },
};
