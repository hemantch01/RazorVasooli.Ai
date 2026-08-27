import { TrendingUp, TrendingDown } from "lucide-react";
import type { KPIMetric } from "../../types";

const ACCENT_BORDER: Record<KPIMetric["accent"], string> = {
  orange: "border-l-brand-orange",
  pink: "border-l-brand-pink",
  violet: "border-l-brand-violet",
  emerald: "border-l-brand-emerald",
};

const ACCENT_TEXT: Record<KPIMetric["accent"], string> = {
  orange: "text-slate-900",
  pink: "text-slate-900",
  violet: "text-slate-900",
  emerald: "text-slate-900",
};

export function MetricCard({ title, value, subtitle, accent, trend }: KPIMetric) {
  return (
    <div
      className={`rounded-2xl bg-white border border-slate-200/90 border-l-4 ${ACCENT_BORDER[accent]} p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md shadow-xs animate-slide-up`}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 font-body">
          {title}
        </p>
        {trend && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
              trend.direction === "up"
                ? "bg-emerald-50 text-emerald-600 border border-emerald-200/60"
                : "bg-rose-50 text-rose-600 border border-rose-200/60"
            }`}
          >
            {trend.direction === "up" ? (
              <TrendingUp className="w-3 h-3" />
            ) : (
              <TrendingDown className="w-3 h-3" />
            )}
            {trend.percent}%
          </span>
        )}
      </div>
      <p className={`mt-2.5 text-3xl font-extrabold font-heading ${ACCENT_TEXT[accent]}`}>
        {value}
      </p>
      {subtitle && (
        <p className="mt-1.5 text-xs text-slate-500 font-body flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${ACCENT_BORDER[accent].replace('border-l-', 'bg-')}`} />
          {subtitle}
        </p>
      )}
    </div>
  );
}
