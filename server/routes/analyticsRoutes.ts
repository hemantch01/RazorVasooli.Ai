// AUTO-GENERATED (Pass 2) — recovery analytics leaderboard.
import express, { type Request, type Response } from "express";
import { computeRecoveryLeaderboard } from "../services/analytics.js";

export function registerAnalyticsRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { orchestrator } = ctx;

  app.get("/api/analytics/leaderboard", (_req: Request, res: Response) => {
    const cases = orchestrator.getCases({ limit: 500 });
    const leaderboard = computeRecoveryLeaderboard(cases);
    res.json({
      success: true,
      totalCases: cases.length,
      generatedAt: new Date().toISOString(),
      leaderboard,
    });
  });

  app.get("/api/analytics/overview", (_req: Request, res: Response) => {
    const cases = orchestrator.getCases({ limit: 2000 });
    
    // Decline Reasons
    const declineCodeMap = new Map<string, number>();
    for (const c of cases) {
      const code = c.declineCode || "UNKNOWN";
      declineCodeMap.set(code, (declineCodeMap.get(code) || 0) + 1);
    }
    const declineReasonData = Array.from(declineCodeMap.entries()).map(([code, value]) => ({
      name: code.replace(/_/g, " "),
      value,
      code
    })).sort((a, b) => b.value - a.value);

    // KPI Metrics
    const totalRecovered = cases.filter((c: any) => c.state === "RECOVERED");
    const recoveredARR = totalRecovered.reduce((sum: number, c: any) => sum + (c.amount || 0), 0);
    const atRiskARR = cases.filter((c: any) => c.state !== "RECOVERED" && c.state !== "CLOSED_LOST" && c.state !== "SKIPPED_COMPLIANCE").reduce((sum: number, c: any) => sum + (c.amount || 0), 0);
    const activeDunning = cases.filter((c: any) => c.state === "INTERVENING").length;
    
    let successRate = 0;
    const closedCases = cases.filter((c: any) => c.state === "RECOVERED" || c.state === "CLOSED_LOST" || c.state === "ESCALATED");
    if (closedCases.length > 0) {
      successRate = (totalRecovered.length / closedCases.length) * 100;
    }

    const formatLakhs = (val: number) => "₹" + (val / 100000).toFixed(1) + "L";

    const kpiMetrics = [
      {
        title: "At-Risk Revenue",
        value: formatLakhs(atRiskARR),
        subtitle: `${cases.length - totalRecovered.length} subscriptions at risk`,
        accent: "pink",
        trend: { direction: "down", percent: 0 },
      },
      {
        title: "Recovered ARR",
        value: formatLakhs(recoveredARR),
        subtitle: "Via AI agent",
        accent: "orange",
        trend: { direction: "up", percent: 0 },
      },
      {
        title: "Success Rate",
        value: successRate.toFixed(1) + "%",
        subtitle: "Avg across closed cases",
        accent: "emerald",
        trend: { direction: "up", percent: 0 },
      },
      {
        title: "Active Dunning",
        value: activeDunning.toString(),
        subtitle: "Workflows running now",
        accent: "violet",
        trend: { direction: "up", percent: 0 },
      },
    ];

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Timeline Data (Last 7 days)
    const timelineMap = new Map<string, any>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      timelineMap.set(d, { date: d, recovered: 0, failed: 0, pending: 0 });
    }
    
    // Breakdown buckets
    const breakdown = {
      "0-3 Days": { recovered: 0, atRisk: 0 },
      "4-7 Days": { recovered: 0, atRisk: 0 },
      "8-14 Days": { recovered: 0, atRisk: 0 },
      "15+ Days": { recovered: 0, atRisk: 0 },
    };

    for (const c of cases) {
      // Timeline
      const d = new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (timelineMap.has(d)) {
        const entry = timelineMap.get(d);
        if (c.state === "RECOVERED") entry.recovered++;
        else if (c.state === "CLOSED_LOST" || c.state === "ESCALATED") entry.failed++;
        else entry.pending++;
      }

      // Breakdown
      const ageDays = Math.floor((now - new Date(c.createdAt).getTime()) / DAY);
      let bucket = "15+ Days";
      if (ageDays <= 3) bucket = "0-3 Days";
      else if (ageDays <= 7) bucket = "4-7 Days";
      else if (ageDays <= 14) bucket = "8-14 Days";

      if (c.state === "RECOVERED") {
        breakdown[bucket as keyof typeof breakdown].recovered += (c.amount || 0);
      } else if (c.state !== "CLOSED_LOST" && c.state !== "SKIPPED_COMPLIANCE") {
        breakdown[bucket as keyof typeof breakdown].atRisk += (c.amount || 0);
      }
    }

    const timeline = Array.from(timelineMap.values());
    const recoveryBreakdownData = Object.entries(breakdown).map(([label, data]) => ({ label, ...data }));

    res.json({
      success: true,
      kpiMetrics,
      declineReasonData,
      recoveryTimelineData: timeline,
      recoveryBreakdownData,
    });
  });
}
