// AUTO-GENERATED (Pass 2) — voice routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";
import { generateGeminiVoiceResponse, generateHinglishVoiceScript } from "../services/voice.js";

export function registerVoiceRoutes(app: express.Express, _ctx: Record<string, any>): void {
app.post("/api/voice/generate", async (req: Request, res: Response) => {
  const { invoiceId, customerName = "Subscriber", amount = 501, declineCode = "INSUFFICIENT_FUNDS", discountPercent = 5 } = req.body;

  const result = await generateGeminiVoiceResponse({
    invoiceId: invoiceId || `inv_${Date.now().toString(36)}`,
    customerName,
    amount,
    declineCode,
    discountPercent,
  });

  return res.status(200).json({
    success: true,
    ...result,
  });
});

app.post("/api/voice/script", (req: Request, res: Response) => {
  const { customerName = "Subscriber", amount = 501, declineCode = "INSUFFICIENT_FUNDS", discountPercent = 5 } = req.body;

  const scriptResult = generateHinglishVoiceScript({
    invoiceId: `inv_${Date.now().toString(36)}`,
    customerName,
    amount,
    declineCode,
    discountPercent,
  });

  return res.status(200).json({
    success: true,
    ...scriptResult,
  });
});

}
