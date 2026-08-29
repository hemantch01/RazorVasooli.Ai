import { dbUpsertEmbedding, dbFindSimilar } from "../core/db.js";
import { type RecoveryCase } from "./orchestrator.js";
import { type TranscriptEntry } from "./telegram.js";

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

export interface SimilarCase {
  caseId: string;
  category: string;
  channel: string;
  recovered: boolean;
  amountInr: number;
  discount: number;
  narrative: string;
  similarity: number;
}

/** Embed text via Gemini text-embedding-004 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return []; // Graceful degradation

  try {
    const response = await fetch(`${EMBEDDING_API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      }),
    });

    if (!response.ok) {
      console.warn(`[Embeddings] API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as any;
    return data?.embedding?.values || [];
  } catch (err: any) {
    console.warn(`[Embeddings] Network error:`, err?.message);
    return [];
  }
}

/** Build a narrative string from a resolved case */
export function buildCaseNarrative(caseData: RecoveryCase, transcript?: TranscriptEntry[]): string {
  let narrative = `Customer ${caseData.customerName || "Unknown"} (₹${caseData.amount}, ${caseData.declineCode || "unknown"}/${caseData.category || "unknown"}) was contacted via ${caseData.currentDecision?.channel || "unknown"}. `;
  
  if (transcript && transcript.length > 0) {
    narrative += `Conversation summary: `;
    const msgs = transcript.filter(t => t.dir !== "system").map(t => `${t.dir === "in" ? "Cust" : "Agent"}: ${t.text}`);
    // Take a small sample to avoid huge embeddings
    narrative += msgs.slice(-5).join(" | ");
  }

  narrative += ` After ${caseData.attemptCount} attempts, the case ended as ${caseData.state}.`;
  
  // Truncate to a reasonable length (~1000 chars) to keep embeddings focused
  return narrative.slice(0, 1000);
}

export async function embedAndStore(
  caseId: string,
  narrative: string,
  metadata: {
    category?: string;
    channel?: string;
    recovered: boolean;
    amountInr: number;
    discount?: number;
  }
): Promise<void> {
  const embedding = await embedText(narrative);
  if (embedding.length === 0) return;

  await dbUpsertEmbedding(
    caseId,
    metadata.category || "unknown",
    metadata.channel || "unknown",
    metadata.recovered,
    metadata.amountInr,
    metadata.discount || 0,
    narrative,
    embedding
  );
}

/** Cosine similarity search via pgvector */
export async function findSimilarCases(
  queryText: string,
  category?: string,
  limit = 3,
  threshold = 0.65
): Promise<SimilarCase[]> {
  const queryVec = await embedText(queryText);
  if (queryVec.length === 0) return []; // graceful fallback

  return dbFindSimilar(queryVec, category, limit, threshold);
}
