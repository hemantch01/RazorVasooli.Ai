// AUTO-GENERATED (Pass 2) — compliance routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { checkCompliance, getDpdpOptOuts, isDpdpOptedOut, registerDpdpOptOut, removeDpdpOptOut } from "../services/orchestrator.js";

export function registerComplianceRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { orchestrator } = ctx;

app.post("/api/compliance/dpdp/opt-out", (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email (string) is required" });
  }

  registerDpdpOptOut(email);

  return res.status(200).json({
    success: true,
    message: `DPDP opt-out registered for ${email}`,
    isOptedOut: true,
  });
});

app.get("/api/compliance/dpdp/check/:email", (req: Request, res: Response) => {
  const rawEmail = req.params.email;
  const email = Array.isArray(rawEmail) ? rawEmail[0] : (rawEmail || "");

  return res.status(200).json({
    email,
    isOptedOut: isDpdpOptedOut(email),
  });
});

app.delete("/api/compliance/dpdp/opt-out/:email", (req: Request, res: Response) => {
  const rawEmail = req.params.email;
  const email = Array.isArray(rawEmail) ? rawEmail[0] : (rawEmail || "");

  const removed = removeDpdpOptOut(email);

  return res.status(200).json({
    success: removed,
    message: removed ? `Opt-out removed for ${email}` : `No opt-out found for ${email}`,
  });
});

app.get("/api/compliance/dpdp/opt-outs", (_req: Request, res: Response) => {
  const optOuts = getDpdpOptOuts();
  return res.status(200).json({
    count: optOuts.length,
    optOuts,
  });
});

app.post("/api/compliance/check", (req: Request, res: Response) => {
  const { caseId } = req.body;

  if (!caseId) {
    return res.status(400).json({ error: "caseId is required" });
  }

  const caseData = orchestrator.getCase(caseId);
  if (!caseData) {
    return res.status(404).json({ error: "Case not found" });
  }

  const result = checkCompliance(caseData);

  return res.status(200).json({
    success: true,
    caseId,
    compliance: result,
  });
});

app.get("/api/compliance/config", (_req: Request, res: Response) => {
  return res.status(200).json(orchestrator.getComplianceConfig());
});

app.put("/api/compliance/config", (req: Request, res: Response) => {
  const updated = orchestrator.updateComplianceConfig(req.body);
  return res.status(200).json({
    success: true,
    config: updated,
  });
});

}
