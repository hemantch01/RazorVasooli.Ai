// AUTO-GENERATED (Pass 2) — recovery routes. Handlers verbatim moved from index.ts.
import express, { type Request, type Response } from "express";


export function registerRecoveryRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { key_id, razorpayClient, trackedInvoices } = ctx;

app.post("/api/recovery/create-payment-link", async (req: Request, res: Response) => {
  const { amount, customerName, customerEmail, customerPhone, description, discountPercent } = req.body;

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "Valid amount in INR is required" });
  }

  const finalAmount = discountPercent ? Math.round(amount * (1 - discountPercent / 100)) : amount;

  try {
    let paymentLinkUrl = "";
    let linkId = `plink_${Date.now().toString(36)}`;

    if (razorpayClient && !key_id.includes("mock")) {
      try {
        const response = await razorpayClient.paymentLink.create({
          amount: finalAmount * 100, // paise
          currency: "INR",
          accept_partial: false,
          description: description || "RazorVasooli AI Revenue Recovery",
          customer: {
            name: customerName || "Customer",
            email: customerEmail || "customer@example.com",
            contact: customerPhone || "+919876543210",
          },
          notify: {
            sms: true,
            email: true,
          },
          reminder_enable: true,
          notes: {
            created_by: "RazorVasooli.Ai",
            original_amount: amount.toString(),
            discount_applied: discountPercent ? `${discountPercent}%` : "0%",
          },
        });

        paymentLinkUrl = response.short_url;
        linkId = response.id;
      } catch (apiErr: any) {
        console.warn("[Razorpay API Notice]: Test keys not live on Razorpay servers, generating test link URL.", apiErr?.message);
        paymentLinkUrl = `https://rzp.io/i/vasooli-${Math.random().toString(36).substring(2, 9)}`;
      }
    } else {
      paymentLinkUrl = `https://rzp.io/i/vasooli-${Math.random().toString(36).substring(2, 9)}`;
    }

    return res.status(200).json({
      success: true,
      linkId,
      shortUrl: paymentLinkUrl,
      amount: finalAmount,
      originalAmount: amount,
      discountPercent: discountPercent || 0,
      currency: "INR",
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    });
  } catch (err: any) {
    console.error("[Create Payment Link Error]:", err?.error || err);
    return res.status(500).json({
      error: "Failed to create Razorpay payment link",
      details: err?.error?.description || err?.message || "Internal error",
    });
  }
});

app.post("/api/recovery/trigger-ai", (req: Request, res: Response) => {
  const { invoiceId, channel, discountPercent } = req.body;

  const invoice = trackedInvoices.find((i: any) => i.id === invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: "Invoice not found" });
  }

  const discount = discountPercent || 5;
  const link = `https://rzp.io/i/vasooli-${Math.random().toString(36).substring(2, 8)}`;

  invoice.status = "ai_contacted";
  invoice.retryCount += 1;
  invoice.channel = channel || invoice.channel;
  invoice.paymentLink = link;

  return res.status(200).json({
    success: true,
    message: `AI Vasooli agent triggered via ${invoice.channel}`,
    invoice,
    paymentLink: link,
    discountApplied: `${discount}%`,
  });
});

app.get("/api/invoices", (_req: Request, res: Response) => {
  return res.status(200).json({
    count: trackedInvoices.length,
    invoices: trackedInvoices,
  });
});

}
