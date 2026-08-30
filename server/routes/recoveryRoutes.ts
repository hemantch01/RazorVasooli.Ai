import express, { type Request, type Response } from "express";
import { getOrCreateRecoveryPaymentLink } from "../services/channels.js";
import type { OrchestratorService } from "../services/orchestrator.js";
import type { AuditService } from "../services/audit.js";

export function registerRecoveryRoutes(app: express.Express, ctx: Record<string, any>): void {
  const { razorpayClient, trackedInvoices, orchestrator, auditService }: {
    razorpayClient: any;
    trackedInvoices: any[];
    orchestrator?: OrchestratorService;
    auditService?: AuditService;
  } = ctx as any;

  app.post("/api/recovery/create-payment-link", async (req: Request, res: Response) => {
    const { caseId, invoiceId, amount, customerName, customerEmail, customerPhone, description, discountPercent } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Valid amount in INR is required" });
    }

    const finalAmount = discountPercent ? Math.round(amount * (1 - discountPercent / 100)) : amount;
    const existingCase = caseId && orchestrator ? orchestrator.getCase(caseId) : undefined;

    try {
      const { link, reused } = await getOrCreateRecoveryPaymentLink(
        razorpayClient,
        existingCase?.paymentLink,
        {
          amountInr: finalAmount,
          customerName: customerName || existingCase?.customerName || "Customer",
          customerEmail: customerEmail || existingCase?.customerEmail || "customer@example.com",
          customerContact: customerPhone || existingCase?.customerPhone,
          description: description || `RazorVasooli AI Revenue Recovery for ${caseId || invoiceId || "invoice"}`,
          notes: {
            ...(caseId ? { case_id: caseId } : {}),
            ...(invoiceId ? { invoice_id: invoiceId } : {}),
            discount_applied: discountPercent ? `${discountPercent}%` : "0%",
          },
        }
      );

      if (caseId && orchestrator) {
        orchestrator.recordPaymentLink(caseId, link);
      }

      if (auditService) {
        auditService.append("payment_link.created", {
          caseId,
          invoiceId,
          amount: finalAmount,
          originalAmount: amount,
          paymentLink: link.shortUrl,
          linkId: link.linkId,
          simulated: link.simulated,
          paymentLinkReused: reused,
        });
      }

      // Update matching invoice in trackedInvoices
      const matchInv = trackedInvoices.find(
        (i: any) => (invoiceId && i.id === invoiceId) || (customerEmail && i.customerEmail === customerEmail)
      );
      if (matchInv) {
        matchInv.paymentLink = link.shortUrl;
        matchInv.status = "link_sent";
      }

      return res.status(200).json({
        success: true,
        linkId: link.linkId,
        shortUrl: link.shortUrl,
        amount: finalAmount,
        originalAmount: amount,
        discountPercent: discountPercent || 0,
        currency: "INR",
        simulated: link.simulated,
        reused,
        expiresAt: link.expiresAt,
      });
    } catch (err: any) {
      console.error("[Create Payment Link Error]:", err?.error || err);
      return res.status(500).json({
        error: "Failed to create Razorpay payment link",
        details: err?.error?.description || err?.message || "Internal error",
      });
    }
  });

  app.post("/api/recovery/trigger-ai", async (req: Request, res: Response) => {
    const { invoiceId, channel, discountPercent } = req.body;

    const invoice = trackedInvoices.find((i: any) => i.id === invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const discount = discountPercent || 5;
    const finalAmount = Math.round(invoice.amount * (1 - discount / 100));

    const { link, reused } = await getOrCreateRecoveryPaymentLink(razorpayClient, undefined, {
      amountInr: finalAmount,
      customerName: invoice.customerName,
      customerEmail: invoice.customerEmail,
      customerContact: invoice.customerPhone,
      description: `RazorVasooli AI Recovery for ${invoice.id}`,
      notes: { invoice_id: invoice.id, discount: `${discount}%` },
    });

    invoice.status = "ai_contacted";
    invoice.retryCount += 1;
    invoice.channel = channel || invoice.channel;
    invoice.paymentLink = link.shortUrl;

    if (auditService) {
      auditService.append("intervention.executed", {
        invoiceId: invoice.id,
        channel: invoice.channel,
        amount: finalAmount,
        paymentLink: link.shortUrl,
        simulated: link.simulated,
        paymentLinkReused: reused,
      });
    }

    return res.status(200).json({
      success: true,
      message: `AI Vasooli agent triggered via ${invoice.channel}`,
      invoice,
      paymentLink: link.shortUrl,
      simulated: link.simulated,
      discountApplied: `${discount}%`,
    });
  });

  app.get("/api/invoices", (_req: Request, res: Response) => {
    return res.status(200).json({
      count: trackedInvoices.length,
      invoices: trackedInvoices,
    });
  });

  // ── Registered Payment Links Management (Dashboard Link Repository) ────────

  app.get("/api/recovery/payment-links", async (_req: Request, res: Response) => {
    try {
      const { dbLoadRegisteredPaymentLinks } = await import("../core/db.js");
      const links = await dbLoadRegisteredPaymentLinks(200);
      return res.status(200).json({
        count: links.length,
        links,
      });
    } catch (err: any) {
      console.error("[Get Payment Links Error]:", err);
      return res.status(500).json({ error: "Failed to fetch payment links" });
    }
  });

  app.post("/api/recovery/payment-links", async (req: Request, res: Response) => {
    const { linkId, shortUrl, amountInr, customerName, customerEmail, customerPhone, caseId, notes, status } = req.body;

    if (!shortUrl || typeof shortUrl !== "string" || !shortUrl.trim()) {
      return res.status(400).json({ error: "shortUrl is required" });
    }
    const parsedAmount = typeof amountInr === "number" ? amountInr : parseFloat(String(amountInr || "0"));
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: "Valid amountInr in INR is required" });
    }

    const trimmedUrl = shortUrl.trim();
    // Auto-generate or extract linkId if not supplied
    let derivedId = (linkId && String(linkId).trim()) || "";
    if (!derivedId) {
      const match = trimmedUrl.match(/plink_[a-zA-Z0-9_-]+/);
      if (match) {
        derivedId = match[0];
      } else {
        const slug = trimmedUrl.split("/").filter(Boolean).pop() || Date.now().toString(36);
        derivedId = `plink_${slug}`;
      }
    }

    try {
      const { dbSaveRegisteredPaymentLink } = await import("../core/db.js");
      const saved = await dbSaveRegisteredPaymentLink({
        id: derivedId,
        shortUrl: trimmedUrl,
        amountInr: parsedAmount,
        customerName: customerName ? String(customerName).trim() : null,
        customerEmail: customerEmail ? String(customerEmail).trim() : null,
        customerPhone: customerPhone ? String(customerPhone).trim() : null,
        caseId: caseId ? String(caseId).trim() : null,
        notes: notes ? String(notes).trim() : null,
        status: status || "created",
        simulated: trimmedUrl.includes("vasooli-sim") || !trimmedUrl.includes("rzp.io"),
      });

      // Bind to orchestrator case if caseId is supplied
      if (caseId && orchestrator) {
        orchestrator.recordPaymentLink(caseId, {
          linkId: derivedId,
          shortUrl: trimmedUrl,
          amountInr: parsedAmount,
          simulated: saved?.simulated || false,
          status: (status as any) || "created",
        });
      }

      if (auditService) {
        auditService.append("payment_link.registered", {
          linkId: derivedId,
          shortUrl: trimmedUrl,
          amountInr: parsedAmount,
          caseId: caseId || null,
          customerEmail: customerEmail || null,
        });
      }

      return res.status(201).json({
        success: true,
        message: "Payment link saved to database successfully",
        link: saved,
      });
    } catch (err: any) {
      console.error("[Save Payment Link Error]:", err);
      return res.status(500).json({ error: "Failed to save payment link to database", details: err?.message });
    }
  });

  app.delete("/api/recovery/payment-links/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Link ID is required" });
    }

    try {
      const { dbDeleteRegisteredPaymentLink } = await import("../core/db.js");
      const ok = await dbDeleteRegisteredPaymentLink(id);
      if (auditService) {
        auditService.append("payment_link.deleted", { linkId: id });
      }
      return res.status(200).json({ success: ok, message: "Payment link deleted" });
    } catch (err: any) {
      console.error("[Delete Payment Link Error]:", err);
      return res.status(500).json({ error: "Failed to delete payment link" });
    }
  });
}


