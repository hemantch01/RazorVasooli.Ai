import express, { type Request, type Response } from "express";
import { safeNextMandateAction } from "../services/mandateSequencer.js";
import { createSubscriptionUpdateMethodLink } from "../services/channels.js";
import type { AuditService } from "../services/audit.js";
import type Razorpay from "razorpay";

export function mandateRoutes(deps: {
  razorpayClient: Razorpay | null;
  auditService: AuditService;
}): express.Router {
  const r = express.Router();

  r.post("/evaluate", async (req: Request, res: Response) => {
    const { mandateKey, declineCode, subscriptionId, customerName, customerEmail } = req.body || {};
    if (!mandateKey || !declineCode) {
      return res.status(400).json({ error: "mandateKey and declineCode required" });
    }
    const decision = await safeNextMandateAction(String(mandateKey), String(declineCode), deps.auditService);

    let recreationLink: string | undefined;
    let recreationSimulated: boolean | undefined;
    if (decision.action === "recreate_mandate" && subscriptionId) {
      try {
        const link = await createSubscriptionUpdateMethodLink(deps.razorpayClient, {
          subscriptionId: String(subscriptionId),
          customerEmail: customerEmail || `${String(mandateKey)}@mandate.demo`,
          description: `Recreate UPI Autopay mandate — ${customerName || mandateKey}`,
        });
        recreationLink = link.shortUrl;
        recreationSimulated = link.simulated;
        deps.auditService.append("mandate.recreation_link_created", {
          mandateKey: String(mandateKey), subscriptionId: String(subscriptionId),
          shortUrl: link.shortUrl, simulated: link.simulated,
        });
      } catch (err: any) {
        console.warn("[Mandate] recreation link failed:", err?.message);
      }
    }

    return res.json({ success: true, decision, recreationLink, recreationSimulated });
  });

  return r;
}
