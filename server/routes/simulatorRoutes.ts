// Simulator routes — backs `npm run demo:seed` / `npm run simulate:batch`
// and the A/B Recovery Lab. POST /api/simulator/run-batch, GET
// /api/simulator/ab-report, GET /api/simulator/batches.
import express, { type Request, type Response } from "express";
import { executeBatch, buildAbReport, hydrateBatches } from "../services/simulator.js";
import { dbLoadBatches } from "../core/db.js";

export function registerSimulatorRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { auditService } = ctx;

  app.post("/api/simulator/run-batch", async (req: Request, res: Response) => {
    const seed = Number(req.body?.seed ?? 424242);
    const size = Math.min(500, Math.max(1, Number(req.body?.size ?? 45)));
    const agentOn = req.body?.agentOn !== false;

    if (!Number.isFinite(seed) || !Number.isFinite(size)) {
      return res.status(400).json({ success: false, error: "seed and size must be numbers" });
    }

    const batch = await executeBatch({ seed, size, agentOn }, auditService);
    return res.status(200).json({ success: true, batch });
  });

  app.get("/api/simulator/ab-report", async (_req: Request, res: Response) => {
    await hydrateBatches(); // restore the latest A/B pair from Postgres (no-op after first call)
    const report = buildAbReport();
    return res.status(200).json(report);
  });

  app.get("/api/simulator/batches", async (_req: Request, res: Response) => {
    const batches = await dbLoadBatches();
    return res.status(200).json({ count: batches.length, batches });
  });
}
