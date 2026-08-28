import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { THEME } from "../../theme";
import type { RecoveryTimelineDataPoint } from "../../types";

export function RecoveryTimelineChart({
  data,
}: {
  data: RecoveryTimelineDataPoint[];
}) {
  return (
    <div className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm hover:shadow-md transition-shadow animate-slide-up">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-lg font-bold text-slate-900 font-heading">
            7-Day Recovery Trend
          </h3>
          <p className="text-xs text-slate-500 font-body mt-0.5">
            Real-time successful vs pending settlements
          </p>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="gradRecovered" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#ff8906" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#ff8906" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#e53170" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#e53170" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradPending" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray={THEME.charts.grid.strokeDasharray}
            stroke={THEME.charts.grid.stroke}
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={{ fill: THEME.charts.axis.fill, fontSize: THEME.charts.axis.fontSize }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: THEME.charts.axis.fill, fontSize: THEME.charts.axis.fontSize }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={THEME.charts.tooltip}
            cursor={{ stroke: "#cbd5e1", strokeDasharray: "2 2" }}
          />
          <Area
            type="monotone"
            dataKey="recovered"
            stroke="#ff8906"
            strokeWidth={2.5}
            fill="url(#gradRecovered)"
            name="Recovered"
          />
          <Area
            type="monotone"
            dataKey="failed"
            stroke="#e53170"
            strokeWidth={2.5}
            fill="url(#gradFailed)"
            name="Failed"
          />
          <Area
            type="monotone"
            dataKey="pending"
            stroke="#8b5cf6"
            strokeWidth={2.5}
            fill="url(#gradPending)"
            name="Pending"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
