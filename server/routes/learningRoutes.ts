// RazorVasooli.Ai — Learning Loop API (Phase L2 RAG)
import express, { type Request, type Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export function registerLearningRoutes(app: express.Express, _ctx: Record<string, any>): void {
  // Embedding count for RAG Memory Active badge
  app.get("/api/learning/embedding-count", async (_req: Request, res: Response) => {
    try {
      const count = await prisma.caseEmbedding.count();
      return res.status(200).json({ count, active: count > 0 });
    } catch (err: any) {
      return res.status(200).json({ count: 0, active: false });
    }
  });

  // Aggregated learning stats — powers the dashboard "Agent Learning" card via RAG embeddings
  app.get("/api/learning/stats", async (_req: Request, res: Response) => {
    try {
      const count = await prisma.caseEmbedding.count();
      return res.status(200).json({
        memoryKeys: count,
        seeded: count > 0,
        ragMemoryActive: count > 0,
        totalEmbeddings: count,
        topLearnedRules: [],
        summaries: {},
      });
    } catch {
      return res.status(200).json({
        memoryKeys: 0,
        seeded: false,
        ragMemoryActive: false,
        totalEmbeddings: 0,
        topLearnedRules: [],
        summaries: {},
      });
    }
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
    return res.status(200).json({ success: true, message: "Cases are embedded automatically on resolution." });
  });
}
