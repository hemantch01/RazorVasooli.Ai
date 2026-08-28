/**
 * Diagnosis Engine — decline-code taxonomy mapping tests.
 */
import { describe, it, expect } from "vitest";
import { DiagnosisService } from "../../server/services/diagnosis.js";

process.env.DATABASE_URL = "";

const svc = new DiagnosisService();

async function categoryFor(errorCode: string): Promise<string> {
  const result = await svc.diagnose({
    caseId: `case_${errorCode}`,
    errorCode,
    amount: 5000,
    retryCount: 0,
    hoursSinceFailure: 1,
  });
  return result.taxonomy.category;
}

describe("decline-code taxonomy", () => {
  it("maps insufficient funds to a soft, retry-friendly funds decline", async () => {
    expect(await categoryFor("INSUFFICIENT_FUNDS")).toBe("soft_decline_funds");
  });

  it("maps network/timeout codes to soft network declines", async () => {
    expect(await categoryFor("NETWORK_ERROR")).toBe("soft_decline_network");
    expect(await categoryFor("UPI_COLLECT_TIMEOUT")).toBe("soft_decline_network");
  });

  it("maps card problems to hard card declines", async () => {
    expect(await categoryFor("CARD_EXPIRED")).toBe("hard_decline_card");
  });

  it("maps bank/account problems to hard account declines", async () => {
    expect(await categoryFor("BANK_DECLINED")).toBe("hard_decline_account");
  });

  it("produces recoverability scoring with a valid score range", async () => {
    const result = await svc.diagnose({
      caseId: "case_score",
      errorCode: "INSUFFICIENT_FUNDS",
      amount: 5000,
      retryCount: 0,
      hoursSinceFailure: 1,
    });
    expect(result.recoverability.score).toBeGreaterThanOrEqual(0);
    expect(result.recoverability.score).toBeLessThanOrEqual(1);
  });

  it("classifies unknown codes via deterministic fallback (no LLM configured)", async () => {
    const result = await svc.diagnose({
      caseId: "case_unknown",
      errorCode: "TOTALLY_MADE_UP_CODE_XYZ",
      amount: 100,
      retryCount: 0,
      hoursSinceFailure: 1,
    });
    // Must still return a usable taxonomy — never undefined
    expect(result.taxonomy.category).toBeTruthy();
    expect(result.diagnosisSource).not.toBe("taxonomy"); // came from fallback
  });
});
