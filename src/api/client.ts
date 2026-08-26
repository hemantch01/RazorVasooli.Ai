/**
 * RazorVasooli.Ai — Central API client
 *
 * Saare dashboard fetch calls ek jagah — typed wrappers.
 * Views isko import karke use karein (raw fetch drift khatam).
 */

async function get<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function post<T>(url: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Typed payloads

export interface TelegramSessionDTO {
  chatId: number;
  customerName: string;
  amountDueInr: number;
  declineCode: string;
  discountPercent: number;
  promisedDate?: string;
  optedOut: boolean;
  recovered: boolean;
  paymentLink?: { shortUrl: string; simulated: boolean; status: string };
  transcript: Array<{ dir: "in" | "out" | "system"; text: string; payLink?: string; at: string }>;
  actions: Array<{ tool: string; detail: string; at: string }>;
  updatedAt: string;
}

export interface HealthDTO {
  phase5?: {
    totalCases?: number;
    totalRecovered?: number;
    totalRecoveredAmount?: number;
    totalEscalated?: number;
    totalSkippedCompliance?: number;
    byState?: Record<string, number>;
  };
}

// Endpoint wrappers

export const api = {
  health: () => get<HealthDTO>("/api/health"),

  telegram: {
    sessions: () =>
      get<{ enabled: boolean; demo?: boolean; sessions: TelegramSessionDTO[] }>(
        "/api/telegram/sessions"
      ),
  },

  audit: {
    verify: () =>
      get<{ valid: boolean; entriesChecked: number; brokenAtSeq?: number; verifiedAt: string }>(
        "/api/audit/verify"
      ),
  },

  recovery: {
    createPaymentLink: (body: {
      amount: number;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
      discountPercent?: number;
      description?: string;
    }) => post<{ shortUrl: string; linkId: string }>(
      "/api/recovery/create-payment-link", body
    ),
  },
};
