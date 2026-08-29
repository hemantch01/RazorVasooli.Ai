export const THEME = {
  fonts: {
    heading: "'Outfit', system-ui, sans-serif",
    body: "'Sora', system-ui, sans-serif",
  },
  colors: {
    canvas: {
      light: "#f8fafc",
      dark: "#0f0e17",
    },
    surface: {
      card: "#ffffff",
      subtle: "#f1f5f9",
      border: "#e2e8f0",
      borderDark: "#2e2f3e",
    },
    text: {
      headline: "#0f172a",
      paragraph: "#64748b",
      subtext: "#94a3b8",
    },
    brand: {
      orange: "#ff8906",
      peach: "#f5b771",
      pinkRed: "#e53170",
      violet: "#8b5cf6",
      emerald: "#10b981",
      crimson: "#ef4444",
    },
  },
  charts: {
    series: ["#ff8906", "#e53170", "#8b5cf6", "#10b981", "#3b82f6"],
    breakdown: {
      recovered: "#ff8906",
      atRisk: "#e53170",
      totalRevenue: "#10b981",
      totalCost: "#ef4444",
      efficiency: "#8b5cf6",
    },
    grid: {
      strokeDasharray: "3 3",
      stroke: "#e2e8f0",
    },
    axis: {
      fontSize: 11,
      fill: "#64748b",
    },
    tooltip: {
      backgroundColor: "#ffffff",
      border: "1px solid #e2e8f0",
      borderRadius: "10px",
      color: "#0f172a",
      fontSize: "12px",
      boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
    },
  },
} as const;
