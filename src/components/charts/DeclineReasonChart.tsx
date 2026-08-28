import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { THEME } from "../../theme";
import type { DeclineReasonDataPoint } from "../../types";

const COLORS = ["#ff8906", "#e53170", "#8b5cf6", "#10b981", "#3b82f6", "#f5b771"];

export function DeclineReasonChart({
  data,
}: {
  data: DeclineReasonDataPoint[];
}) {
  return (
    <div className="rounded-2xl bg-white border border-slate-200/90 p-6 shadow-sm hover:shadow-md transition-shadow animate-slide-up">
      <div className="mb-5">
        <h3 className="text-lg font-bold text-slate-900 font-heading">
          Decline Code Distribution
        </h3>
        <p className="text-xs text-slate-500 font-body mt-0.5">
          Breakdown of card declines & mandate failures
        </p>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={65}
            outerRadius={105}
            dataKey="value"
            nameKey="name"
            stroke="#ffffff"
            strokeWidth={3}
          >
            {data.map((_, index) => (
              <Cell
                key={`cell-${index}`}
                fill={COLORS[index % COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={THEME.charts.tooltip}
            formatter={(value: any) => [`${Number(value)}%`, ""]}
          />
          <Legend
            wrapperStyle={{ fontSize: "11px", paddingTop: "12px" }}
            formatter={(val: string) => (
              <span style={{ color: "#475569", fontWeight: 500 }}>{val}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
