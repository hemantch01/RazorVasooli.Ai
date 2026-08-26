/**
 * RazorVasooli.Ai — Recovery Analytics
 * "Kaunse decline reasons best convert karte hain?" ka jawab.
 */
import type { RecoveryCase } from "./orchestrator.js";

export interface LeaderboardRow {
  rank: number;
  declineCode: string;
  totalCases: number;
  recoveredCount: number;
  recoveryRate: number;      // 0–1
  recoveredAmount: number;
  avgAttempts: number;       // avg attempts on recovered cases
  bestChannel: string;
}

export function computeRecoveryLeaderboard(cases: RecoveryCase[]): LeaderboardRow[] {
  const groups = new Map<string, { cases: RecoveryCase[] }>();
  for (const c of cases) {
    const key = c.declineCode || "UNKNOWN";
    if (!groups.has(key)) groups.set(key, { cases: [] });
    groups.get(key)!.cases.push(c);
  }

  const rows: Omit<LeaderboardRow, "rank">[] = [];
  for (const [code, { cases: list }] of groups) {
    const recovered = list.filter((c) => c.state === "RECOVERED");
    const channelCount = new Map<string, number>();
    for (const c of recovered) {
      const ch = c.currentDecision?.channel || c.transitions.at(-1)?.metadata?.channel as string || "unknown";
      channelCount.set(ch, (channelCount.get(ch) || 0) + 1);
    }
    const bestChannel = [...channelCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
    const avgAttempts = recovered.length
      ? recovered.reduce((s, c) => s + c.attemptCount, 0) / recovered.length
      : 0;
    rows.push({
      declineCode: code,
      totalCases: list.length,
      recoveredCount: recovered.length,
      recoveryRate: list.length ? recovered.length / list.length : 0,
      recoveredAmount: recovered.reduce((s, c) => s + (c.recoveredAmount || c.amount), 0),
      avgAttempts: Math.round(avgAttempts * 10) / 10,
      bestChannel,
    });
  }

  rows.sort((a, b) => b.recoveryRate - a.recoveryRate || b.totalCases - a.totalCases);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
