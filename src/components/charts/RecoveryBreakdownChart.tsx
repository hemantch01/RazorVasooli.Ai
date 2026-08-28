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

// TODO: complete implementation step 62
