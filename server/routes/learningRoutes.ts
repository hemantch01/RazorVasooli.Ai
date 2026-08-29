// RazorVasooli.Ai — Learning Loop API (Phase L1)
import express, { type Request, type Response } from "express";
import {
  seedFromPersonas,
  clearOutcomeMemory,
  getCategorySummary,
  getTopLearnedRules,
  getMemorySize,
} from "../services/outcomeMemory.js";

const TRACKED_CATEGORIES = [
  "soft_decline_funds",
  "soft_decline_network",
  "hard_decline_card",
  "invoice_overdue",
  "abandoned_checkout",
  "upgrade_offer",
] as const;

export function registerLearningRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { auditService } = ctx;

  // Aggregated learning stats — powers the dashboard "Agent Learning" card.
  app.get("/api/learning/stats", (_req: Request, res: Response) => {
    const summaries = Object.fromEntries(
      TRACKED_CATEGORIES.map((c) => [c, getCategorySummary(c, 6)])
    );
    return res.status(200).json({
      memoryKeys: getMemorySize(),
      seeded: getMemorySize() > 0,
      topLearnedRules: getTopLearnedRules(5),
      summaries,
    });
  });

  // Bootstrap cold-start memory with synthetic persona history (default 250 users).
  app.post("/api/learning/seed", async (req: Request, res: Response) => {
    const size = Math.min(5000, Math.max(10, parseInt(req.body?.size, 10) || 250));
    try {
      const summary = await seedFromPersonas(size);
      auditService.append("learning.seeded", {
        totalUsers: summary.totalUsers,
        totalOutcomes: summary.totalOutcomes,
        recovered: summary.recovered,
      });
      return res.status(200).json({ success: true, ...summary });
    } catch (err: any) {
      return res.status(500).json({ error: "Seed failed", details: err?.message });
    }
  });

  // Reset memory to cold start.
  app.post("/api/learning/reset", async (_req: Request, res: Response) => {
    await clearOutcomeMemory();
    auditService.append("learning.reset", {});
    return res.status(200).json({ success: true, memoryKeys: getMemorySize() });
  });

  // Phase L2: RAG Similar Cases

  app.get("/api/learning/similar", async (req: Request, res: Response) => {
    try {
      const { findSimilarCases } = await import("../services/embeddings.js");
      const category = req.query.category as string;
      const amount = req.query.amount as string;
      const declineCode = req.query.declineCode as string;
      
      const queryText = `${category || ""} ₹${amount || ""} ${declineCode || ""}`;
      const similar = await findSimilarCases(queryText, category, 3, 0.65);
      
      return res.status(200).json({ similar });
    } catch (err: any) {
      return res.status(500).json({ error: "Failed to find similar cases", details: err?.message });
    }
  });

  app.post("/api/learning/embeddings/backfill", async (_req: Request, res: Response) => {
    try {
      // Lazy load to avoid cycle/init issues
      
      // Get completed cases from DB that don't have embeddings yet
      // This is a naive backfill that checks state and lacks embeddings.
      // In a real app we'd query Orchestrator's persistence layer properly, 
      // but we don't have a direct case table, we rely on the state json.
      // For this demo, we'll return a stub indicating manual backfill is required
      // or we just process active ones if they were saved somewhere.
      
      return res.status(200).json({ success: true, message: "Backfill stub. In-memory cases must be resolved to embed automatically." });
    } catch (err: any) {
      return res.status(500).json({ error: "Backfill failed", details: err?.message });
    }
  });
}
