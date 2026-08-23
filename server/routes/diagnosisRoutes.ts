// AUTO-GENERATED (Pass 2) — diagnosis routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { applyFallbackRules, classifyErrorCode } from "../services/diagnosis.js";

export function registerDiagnosisRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { diagnosisService } = ctx;

app.post("/api/diagnosis/diagnose", async (req: Request, res: Response) => {
  const {
    errorCode,
    amount = 10000,
    retryCount = 0,
    paymentMethod,
    hoursSinceFailure = 0,
    customerTenure,
    previousRecoveries,
    isSubscription = false,
  } = req.body;

  if (!errorCode || typeof errorCode !== "string") {
    return res.status(400).json({ error: "errorCode (string) is required" });
  }

  const diagnosis = await diagnosisService.diagnose({
    caseId: `manual_${Date.now().toString(36)}`,
    errorCode,
    amount,
    retryCount,
    paymentMethod,
    hoursSinceFailure,
    customerTenure,
    previousRecoveries,
    isSubscription,
    rawPayload: req.body,
  });

  return res.status(200).json({
    success: true,
    diagnosis,
  });
});

app.get("/api/diagnosis/classify/:errorCode", (req: Request, res: Response) => {
  const rawCode = req.params.errorCode;
  const errorCode = Array.isArray(rawCode) ? rawCode[0] : (rawCode || "");
  const taxonomy = classifyErrorCode(errorCode);

  if (taxonomy) {
    return res.status(200).json({
      source: "taxonomy",
      errorCode,
      ...taxonomy,
    });
  }

  // Fallback rules
  const fallback = applyFallbackRules(errorCode);
  return res.status(200).json({
    source: fallback.source,
    errorCode,
    category: fallback.category,
    subcategory: fallback.subcategory,
    isTransient: fallback.isTransient,
    reasoning: fallback.reasoning,
  });
});

app.get("/api/diagnosis/results", (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string || "50", 10);
  const results = diagnosisService.getResults(Math.min(limit, 200));

  return res.status(200).json({
    count: results.length,
    results,
  });
});

app.get("/api/diagnosis/stats", (_req: Request, res: Response) => {
  return res.status(200).json(diagnosisService.getStats());
});

}
