import Razorpay from "razorpay";
import { EventDeduplicator, RiskEventBus } from "../services/ingestion.js";
import { DiagnosisService } from "../services/diagnosis.js";
import { PolicyService } from "../services/policy.js";
import { OrchestratorService } from "../services/orchestrator.js";
import { AuditService } from "../services/audit.js";

// Moving state out of module scope and into a shared container/repository structure
export const trackedInvoices = [
  {
    id: "inv_Rz4k8mPqN2x7Lb",
    customerName: "A***a Sharma",
    customerEmail: "a***a@techcorp.in",
    customerPhone: "+91 98765 43210",
    amount: 24999,
    currency: "INR",
    declineCode: "INSUFFICIENT_FUNDS",
    status: "ai_contacted",
    subscriptionId: "sub_Rz4k8mPqN2x7",
    failedAt: new Date(Date.now() - 3600000).toISOString(),
    retryCount: 2,
    channel: "whatsapp",
    paymentLink: "https://rzp.io/i/vasooli-Rz4k8m",
  },
  {
    id: "inv_Qw9j7nRsM1y6Ka",
    customerName: "R***j Patel",
    customerEmail: "r***j@startup.io",
    customerPhone: "+91 98111 22233",
    amount: 49999,
    currency: "INR",
    declineCode: "BAD_REQUEST_PAYMENT_TIMED_OUT",
    status: "link_sent",
    subscriptionId: "sub_Qw9j7nRsM1y6",
    failedAt: new Date(Date.now() - 86400000).toISOString(),
    retryCount: 1,
    channel: "email",
    paymentLink: "https://rzp.io/i/vasooli-Qw9j7n",
  },
  {
    id: "inv_Uw3g5pTuJ4a9Ic",
    customerName: "S***n Reddy",
    customerEmail: "s***n@saasly.in",
    customerPhone: "+91 99000 88776",
    amount: 14999,
    currency: "INR",
    declineCode: "BANK_DECLINED",
    status: "pending",
    subscriptionId: "sub_Uw3g5pTuJ4a9",
    failedAt: new Date().toISOString(),
    retryCount: 0,
    channel: "whatsapp",
  },
];

export interface Container {
  razorpayClient: Razorpay | null;
  key_id: string;
  webhook_secret: string;
  deduplicator: EventDeduplicator;
  riskEventBus: RiskEventBus;
  diagnosisService: DiagnosisService;
  policyService: PolicyService;
  orchestrator: OrchestratorService;
  auditService: AuditService;
  trackedInvoices: any[];
  HOST: string;
  PORT: number;
}

/**
 * Initializes the Dependency Injection container.
 * This ensures strict lifecycle management and avoids module-level globals.
 */
export function createContainer(): Container {
  const key_id = process.env.RAZORPAY_KEY_ID || "";
  const key_secret = process.env.RAZORPAY_KEY_SECRET || "";
  const webhook_secret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

  let razorpayClient: Razorpay | null = null;
  if (key_id && key_secret && !key_id.includes("YourKeyId")) {
    try {
      razorpayClient = new Razorpay({ key_id, key_secret });
      console.log("[Razorpay] Client initialized with Key ID:", key_id.slice(0, 8) + "...");
    } catch {
      console.warn("[Razorpay] Could not initialize client with provided keys, running in simulation mode");
    }
  } else {
    console.log("[Razorpay] Running in simulation mode (Set RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET in .env for live API calls)");
  }

  const deduplicator = new EventDeduplicator(60);
  const riskEventBus = new RiskEventBus(200);
  const diagnosisService = new DiagnosisService(200);
  const policyService = new PolicyService(200);
  const orchestrator = new OrchestratorService();
  const auditService = new AuditService(2000);

  return {
    razorpayClient,
    key_id,
    webhook_secret,
    deduplicator,
    riskEventBus,
    diagnosisService,
    policyService,
    orchestrator,
    auditService,
    trackedInvoices,
    HOST: process.env.HOST || "127.0.0.1",
    PORT: parseInt(process.env.PORT || "5000", 10),
  };
}
