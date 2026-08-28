import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { THEME } from "../../theme";
import type { RecoveryBreakdownDataPoint } from "../../types";

export function RecoveryBreakdownChart({
  data,
}: {
  data: RecoveryBreakdownDataPoint[];
}) {
  return (
    <div className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm hover:shadow-md transition-shadow animate-slide-up">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-lg font-bold text-slate-900 font-heading">
            Operational Recovery Breakdown
          </h3>
          <p className="text-xs text-slate-500 font-body mt-0.5">
            Recovered vs. At-Risk subscription volume
          </p>
        </div>
        <span className="px-3 py-1 text-xs font-semibold rounded-full bg-orange-50 text-brand-orange border border-orange-200 font-body">
          Live Telemetry
        </span>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} barCategoryGap="20%">
          <CartesianGrid
            strokeDasharray={THEME.charts.grid.strokeDasharray}
            stroke={THEME.charts.grid.stroke}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: THEME.charts.axis.fill, fontSize: THEME.charts.axis.fontSize }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: THEME.charts.axis.fill, fontSize: THEME.charts.axis.fontSize }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) =>
              v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${(v / 1000).toFixed(0)}K`
            }
          />
          <Tooltip
            contentStyle={THEME.charts.tooltip}
            formatter={(value: any) => [`₹${Number(value).toLocaleString("en-IN")}`, ""]}
            cursor={{ fill: "rgba(241, 245, 249, 0.6)" }}
          />
          <Legend
            wrapperStyle={{ fontSize: "12px", paddingTop: "12px" }}
            formatter={(val: string) => (
              <span style={{ color: "#475569", fontWeight: 500 }}>{val}</span>
            )}
          />
          <Bar
            dataKey="recovered"
            fill={THEME.charts.breakdown.recovered}
            radius={[0, 0, 0, 0]}
            name="Recovered Revenue"
            stackId="revenue"
          />
          <Bar
            dataKey="atRisk"
            fill={THEME.charts.breakdown.atRisk}
            radius={[8, 8, 0, 0]}
            name="At-Risk Revenue"
            stackId="revenue"
            activeBar={{ fill: "rgba(229, 49, 112, 0.85)" }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
