// Domain Types

export type RecoveryStatus =
  | "pending"
  | "ai_contacted"
  | "link_sent"
  | "recovered"
  | "failed"
  | "escalated";

export type DeclineCode =
  | "BAD_REQUEST_PAYMENT_TIMED_OUT"
  | "INSUFFICIENT_FUNDS"
  | "CARD_EXPIRED"
  | "BANK_DECLINED"
  | "FRAUD_SUSPECTED"
  | "NETWORK_ERROR"
  | "AUTHENTICATION_FAILED"
  | "LIMIT_EXCEEDED";

export type Channel = "whatsapp" | "sms" | "email" | "ivr";

export type PlaybookPersona =
  | "empathetic_saas"
  | "strict_b2b"
  | "discount_incentivized"
  | "dynamic_upi";

export interface FailedInvoice {
  id: string;
  customerName: string;
  customerEmail: string;
  amount: number;
  currency: string;
  declineCode: DeclineCode;
  status: RecoveryStatus;
  subscriptionId: string;
  failedAt: string;
  retryCount: number;
  channel: Channel;
  lastContactedAt?: string;
}

export interface RecoveryBreakdownDataPoint {
  label: string;
  recovered: number;
  atRisk: number;
}

export interface RecoveryTimelineDataPoint {
  date: string;
  recovered: number;
  failed: number;
  pending: number;
}

export interface DeclineReasonDataPoint {
  name: string;
  value: number;
  code: DeclineCode;
}

export interface WebhookEvent {
  id: string;
  event: string;
  payload: string;
  receivedAt: string;
  processed: boolean;
  aiAction?: string;
}

export interface ChatMessage {
  id: string;
  sender: "ai" | "customer";
  content: string;
  timestamp: string;
  channel: Channel;
}

export interface RecoveryPlaybook {
  id: string;
  name: string;
  persona: PlaybookPersona;
  description: string;
  channels: Channel[];
  maxRetries: number;
  retryDelayHours: number;
  discountPercent?: number;
  active: boolean;
  successRate: number;
}

export interface KPIMetric {
  title: string;
  value: string | number;
  subtitle?: string;
  accent: "orange" | "pink" | "violet" | "emerald";
  trend?: { direction: "up" | "down"; percent: number };
}

export type ViewId =
  | "overview"
  | "agent"
  | "invoices"
  | "webhooks"
  | "playbooks"
  | "cases"
  | "telegram"
  | "email"
  | "whatsapp"
  | "ivr"
  | "audit";

/** Details passed to the AI Vasooli Agent tab when opened from a live channel. */
export interface AgentTargetDetails {
  id: string;
  customerName: string;
  customerEmail?: string;
  amount: number;
  declineCode?: string;
  channel: "telegram" | "email" | "invoice";
  state?: string;
  promisedDate?: string;
  optedOut?: boolean;
  recovered?: boolean;
  paymentLinkStatus?: string;
}
