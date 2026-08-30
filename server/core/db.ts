/**
 * RazorVasooli.Ai — Persistence Layer (Prisma / PostgreSQL)
 *
 * Enabled automatically when DATABASE_URL is set (docker compose up -d).
 * Falls back to in-memory demo mode otherwise.
 * Schema: prisma/schema.prisma → npx prisma migrate dev
 */

import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;
let healthy = false;
let lastAttempt = 0;

export function dbEnabled(): boolean {
  if (!process.env.DATABASE_URL) return false;
  if (healthy) return true;
  // Retry connection at most once every 30s (lazy self-heal, never crashes)
  if (Date.now() - lastAttempt > 30000) {
    lastAttempt = Date.now();
    initDb().catch(() => { /* already logged inside initDb */ });
  }
  return false;
}

export function getPrisma(): PrismaClient {
  if (!prisma) prisma = new PrismaClient({ log: ["warn", "error"] });
  return prisma;
}

let schemaReady: Promise<void> | null = null;

export function initDb(): Promise<void> {
  if (!process.env.DATABASE_URL) return Promise.resolve();
  if (!schemaReady) {
    schemaReady = (async () => {
      await getPrisma().$queryRaw`SELECT 1`;
      healthy = true;
      console.log("[DB] ✅ PostgreSQL connected (Prisma)");
    })().catch((err) => {
      console.error("[DB] connection failed:", err?.message);
      schemaReady = null;
      healthy = false;
      throw err;
    });
  }
  return schemaReady;
}

// Audit ledger

export async function dbAppendAudit(entry: {
  seq: number; timestamp: string; eventType: string;
  payload: Record<string, unknown>; prevHash: string; hash: string;
}): Promise<void> {
  if (!dbEnabled()) return;
  const data = {
    seq: entry.seq,
    ts: new Date(entry.timestamp),
    eventType: entry.eventType,
    payload: entry.payload as any,
    prevHash: entry.prevHash,
    hash: entry.hash,
  };
  await getPrisma().auditEntry.upsert({
    where: { seq: entry.seq },
    update: data,
    create: data,
  }).catch((err) => console.warn("[Audit] DB persist failed:", err?.message));
}

export async function dbLoadAuditTail(limit = 2000): Promise<Array<{
  seq: number; timestamp: string; eventType: string;
  payload: Record<string, unknown>; prevHash: string; hash: string;
}>> {
  if (!dbEnabled()) return [];
  const rows = await getPrisma().auditEntry.findMany({ orderBy: { seq: "asc" }, take: limit });
  return rows.map((r) => ({
    seq: r.seq,
    timestamp: r.ts.toISOString(),
    eventType: r.eventType,
    payload: r.payload as Record<string, unknown>,
    prevHash: r.prevHash,
    hash: r.hash,
  }));
}

// Recovery case snapshots

export async function dbUpsertCaseSnapshot(c: {
  id: string; state: string; amount: number; updatedAt: string;
  snapshot: Record<string, unknown>;
}): Promise<void> {
  if (!dbEnabled()) return;
  const data = { state: c.state, amount: c.amount, snapshot: c.snapshot as any, updatedAt: new Date(c.updatedAt) };
  await getPrisma().recoveryCase.upsert({
    where: { id: c.id },
    update: data,
    create: { id: c.id, ...data },
  }).catch((err) => console.warn("[DB] case snapshot failed:", err?.message));
}

export async function dbLoadCaseSnapshots(): Promise<Array<Record<string, unknown>>> {
  if (!dbEnabled()) return [];
  const rows = await getPrisma().recoveryCase.findMany({ orderBy: { updatedAt: "asc" }, take: 1000 });
  return rows.map((r) => ({ ...(r.snapshot as Record<string, unknown>) }));
}

// Users (auth)

export async function dbFindUser(email: string): Promise<{
  email: string; name: string; password_hash: string; salt: string; role: string;
} | null> {
  if (!dbEnabled()) return null;
  const u = await getPrisma().user.findUnique({ where: { email: email.toLowerCase() } });
  return u ? { email: u.email, name: u.name, password_hash: u.passwordHash, salt: u.salt, role: u.role } : null;
}

export async function dbCreateUser(u: {
  email: string; name: string; password_hash: string; salt: string; role?: string;
}): Promise<void> {
  await getPrisma().user.upsert({
    where: { email: u.email.toLowerCase() },
    update: {
      passwordHash: u.password_hash,
      salt: u.salt,
    },
    create: {
      email: u.email.toLowerCase(), name: u.name,
      passwordHash: u.password_hash, salt: u.salt, role: u.role || "merchant_admin",
    },
  });
}

export async function dbUserCount(): Promise<number> {
  if (!dbEnabled()) return 0;
  return getPrisma().user.count();
}

// Scheduled jobs durability

export async function dbUpsertJob(j: {
  id: string; caseId: string; type: string; executeAt: string;
  status?: string; payload?: Record<string, unknown>;
}): Promise<void> {
  if (!dbEnabled()) return;
  const executeAt = new Date(j.executeAt);
  const status = j.status || "scheduled";
  await getPrisma().scheduledJob.upsert({
    where: { id: j.id },
    update: { executeAt, status, payload: (j.payload || {}) as any },
    create: { id: j.id, caseId: j.caseId, type: j.type, executeAt, status, payload: (j.payload || {}) as any },
  }).catch((err) => console.warn("[DB] job persist failed:", err?.message));
}

export async function dbMarkJob(id: string, status: string): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().scheduledJob.updateMany({ where: { id }, data: { status } });
}

export async function dbLoadPendingJobs(): Promise<Array<{
  id: string; caseId: string; type: string; executeAt: Date; payload: any;
}>> {
  if (!dbEnabled()) return [];
  return getPrisma().scheduledJob.findMany({
    where: { status: "scheduled" },
    orderBy: { executeAt: "asc" },
    take: 500,
  });
}

// Interventions

export async function dbSaveIntervention(i: {
  id: string; caseId: string; channel: string;
  subject?: string; body: string; paymentLink?: string;
}): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().intervention.upsert({
    where: { id: i.id },
    update: { body: i.body, paymentLink: i.paymentLink },
    create: i,
  }).catch((err) => console.warn("[DB] intervention save failed:", err?.message));
}

// Simulator batches

export async function dbSaveBatch(b: {
  id: string; label: string; agentOn: boolean; seed: number;
  summary: Record<string, unknown>; results: unknown[];
}): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().simulatorBatch.upsert({
    where: { id: b.id },
    update: { summary: b.summary as any, results: b.results as any },
    create: {
      id: b.id, label: b.label, agentOn: b.agentOn, seed: BigInt(b.seed),
      summary: b.summary as any, results: b.results as any,
    },
  }).catch((err) => console.warn("[DB] batch save failed:", err?.message));
}

// Telegram sessions

export async function dbSaveTelegramSession(chatId: number, data: Record<string, unknown>): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().telegramSession.upsert({
    where: { chatId: BigInt(chatId) },
    update: { data: data as any },
    create: { chatId: BigInt(chatId), data: data as any },
  }).catch((err) => console.warn("[DB] telegram session save failed:", err?.message));
}

export async function dbLoadTelegramSessions(): Promise<Array<{ chat_id: string; data: Record<string, unknown> }>> {
  if (!dbEnabled()) return [];
  const rows = await getPrisma().telegramSession.findMany({ orderBy: { updatedAt: "desc" }, take: 200 });
  return rows.map((r) => ({ chat_id: r.chatId.toString(), data: r.data as Record<string, unknown> }));
}

// Mail conversations

export async function dbSaveMailConversation(email: string, data: Record<string, unknown>): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().mailConversation.upsert({
    where: { email: email.toLowerCase() },
    update: { data: data as any },
    create: { email: email.toLowerCase(), data: data as any },
  }).catch((err) => console.warn("[DB] mail conversation save failed:", err?.message));
}

export async function dbLoadMailConversations(): Promise<Array<{ email: string; data: Record<string, unknown> }>> {
  if (!dbEnabled()) return [];
  const rows = await getPrisma().mailConversation.findMany({ orderBy: { updatedAt: "desc" }, take: 200 });
  return rows.map((r) => ({ email: r.email, data: r.data as Record<string, unknown> }));
}

// Mandate retry cap tracker (NPCI)

export async function dbGetMandateRetries(mandateKey: string): Promise<number> {
  if (!dbEnabled()) return 0;
  const m = await getPrisma().mandateRetry.findUnique({ where: { mandateKey } });
  return m?.retriesUsed ?? 0;
}

export async function dbUpsertMandate(mandateKey: string, updates: {
  retriesUsed?: number; lastReason?: string; nextAction?: string;
}): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().mandateRetry.upsert({
    where: { mandateKey },
    update: {
      ...(updates.retriesUsed !== undefined ? { retriesUsed: updates.retriesUsed } : {}),
      ...(updates.lastReason ? { lastReason: updates.lastReason } : {}),
      ...(updates.nextAction ? { nextAction: updates.nextAction } : {}),
    },
    create: {
      mandateKey,
      retriesUsed: updates.retriesUsed ?? 0,
      lastReason: updates.lastReason,
      nextAction: updates.nextAction,
    },
  }).catch((err) => console.warn("[DB] mandate upsert failed:", err?.message));
}

export async function dbLoadBatches(): Promise<Array<{
  id: string; label: string; agent_on: boolean; seed: string;
  summary: Record<string, unknown>; results: unknown[]; updated_at?: Date;
}>> {
  if (!dbEnabled()) return [];
  const rows = await getPrisma().simulatorBatch.findMany({ orderBy: { completedAt: "desc" }, take: 50 });
  return rows.map((r) => ({
    id: r.id, label: r.label, agent_on: r.agentOn, seed: r.seed.toString(),
    summary: r.summary as Record<string, unknown>,
    results: (r.results as unknown[]) || [],
  }));
}

// Interventions list

export async function dbListInterventions(caseId?: string, limit = 100): Promise<unknown[]> {
  if (!dbEnabled()) return [];
  return getPrisma().intervention.findMany({
    where: caseId ? { caseId } : undefined,
    orderBy: { sentAt: "desc" },
    take: limit,
  });
}

// DPDP opt-out registry (durable, Phase H1)

export async function dbAddDpdpOptOut(email: string): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().dpdpOptOut.upsert({
    where: { email: email.toLowerCase() },
    update: {},
    create: { email: email.toLowerCase() },
  }).catch((err) => console.warn("[DB] DPDP opt-out save failed:", err?.message));
}

export async function dbRemoveDpdpOptOut(email: string): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().dpdpOptOut.delete({
    where: { email: email.toLowerCase() },
  }).catch((err) => console.warn("[DB] DPDP opt-out delete failed:", err?.message));
}

export async function dbLoadDpdpOptOuts(): Promise<string[]> {
  if (!dbEnabled()) return [];
  const rows = await getPrisma().dpdpOptOut.findMany({ take: 10000 });
  return rows.map((r) => r.email);
}

// System settings key/value (kill-switch durability, Phase H1)

export async function dbGetSetting(key: string): Promise<string | null> {
  if (!dbEnabled()) return null;
  const row = await getPrisma().systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function dbSetSetting(key: string, value: string): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().systemSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

// Learning loop (Phase L1)

/** Increment aggregated outcome counters (upsert, atomic-ish). */
export async function dbUpsertOutcomeStat(
  key: string,
  recoveredDelta: number,
  attemptedDelta = 1
): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().outcomeStat.upsert({
    where: { key },
    update: {
      attempted: { increment: attemptedDelta },
      recovered: { increment: recoveredDelta },
    },
    create: { key, attempted: attemptedDelta, recovered: recoveredDelta },
  }).catch((err) => console.warn("[DB] outcome stat upsert failed:", err?.message));
}

export async function dbLoadOutcomeStats(): Promise<Array<{ key: string; attempted: number; recovered: number }>> {
  if (!dbEnabled()) return [];
  const rows = await getPrisma().outcomeStat.findMany({ take: 5000 });
  return rows.map((r) => ({ key: r.key, attempted: r.attempted, recovered: r.recovered }));
}

export async function dbClearOutcomeStats(): Promise<void> {
  if (!dbEnabled()) return;
  await getPrisma().learningEvent.deleteMany().catch(() => undefined);
  await getPrisma().outcomeStat.deleteMany().catch(() => undefined);
}

export async function dbSaveLearningEvents(events: Array<{
  category: string; channel: string; attempt: number; recovered: boolean;
  amountInr?: number; discountPercent?: number; customerSegment?: string; source: string;
}>): Promise<void> {
  if (!dbEnabled() || events.length === 0) return;
  // Chunked insert to stay well under parameter limits
  for (let i = 0; i < events.length; i += 100) {
    const chunk = events.slice(i, i + 100);
    await getPrisma().learningEvent.createMany({ data: chunk as never }).catch(
      (err) => console.warn("[DB] learning event insert failed:", err?.message)
    );
  }
}

// RAG Embeddings (Phase L2)

export async function dbUpsertCaseEmbedding(
  caseId: string,
  category: string,
  channel: string,
  recovered: boolean,
  amountInr: number,
  discount: number,
  narrative: string,
  embedding?: number[]
): Promise<void> {
  if (!dbEnabled()) return;
  
  try {
    if (embedding && embedding.length === 768) {
      const vectorLiteral = `[${embedding.join(',')}]`;
      await getPrisma().$executeRaw`
        INSERT INTO "CaseEmbedding" ("caseId", category, channel, recovered, "amountInr", discount, narrative, embedding)
        VALUES (${caseId}, ${category}, ${channel}, ${recovered}, ${amountInr}, ${discount}, ${narrative}, ${vectorLiteral}::vector)
        ON CONFLICT ("caseId") DO UPDATE SET
          category = EXCLUDED.category,
          channel = EXCLUDED.channel,
          recovered = EXCLUDED.recovered,
          "amountInr" = EXCLUDED."amountInr",
          discount = EXCLUDED.discount,
          narrative = EXCLUDED.narrative,
          embedding = EXCLUDED.embedding
      `;
    } else {
      await getPrisma().$executeRaw`
        INSERT INTO "CaseEmbedding" ("caseId", category, channel, recovered, "amountInr", discount, narrative, embedding)
        VALUES (${caseId}, ${category}, ${channel}, ${recovered}, ${amountInr}, ${discount}, ${narrative}, NULL)
        ON CONFLICT ("caseId") DO UPDATE SET
          category = EXCLUDED.category,
          channel = EXCLUDED.channel,
          recovered = EXCLUDED.recovered,
          "amountInr" = EXCLUDED."amountInr",
          discount = EXCLUDED.discount,
          narrative = EXCLUDED.narrative,
          embedding = EXCLUDED.embedding
      `;
    }
  } catch (err: any) {
    console.warn(`[DB] Embedding upsert failed for ${caseId}:`, err?.message);
  }
}

export async function dbFindSimilar(
  queryEmbedding: number[],
  category?: string,
  limit = 3,
  threshold = 0.65
): Promise<Array<{
  caseId: string;
  category: string;
  channel: string;
  recovered: boolean;
  amountInr: number;
  discount: number;
  narrative: string;
  similarity: number;
}>> {
  if (!dbEnabled()) return [];
  
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  try {
    const rows = await getPrisma().$queryRawUnsafe<any[]>(`
      SELECT 
        "caseId", category, channel, recovered, "amountInr", discount, narrative,
        1 - (embedding <=> $1::vector) AS similarity
      FROM "CaseEmbedding"
      WHERE embedding IS NOT NULL
        AND ($2::text IS NULL OR category = $2::text OR category = 'unknown')
        AND 1 - (embedding <=> $1::vector) >= $3::float
      ORDER BY embedding <=> $1::vector
      LIMIT $4::integer
    `, vectorLiteral, category || null, threshold, limit);

    return rows.map((r) => ({
      caseId: r.caseId,
      category: r.category,
      channel: r.channel,
      recovered: r.recovered,
      amountInr: r.amountInr,
      discount: r.discount,
      narrative: r.narrative,
      similarity: r.similarity,
    }));
  } catch (err: any) {
    console.warn(`[DB] Similar search failed:`, err?.message);
    return [];
  }
}

// Webhook Logs
export async function dbSaveWebhookLog(log: {
  id: string;
  event: string;
  payload: any;
  signatureVerified: boolean;
  aiAction?: string;
  paymentLink?: string;
}): Promise<void> {
  if (!dbEnabled()) return;
  try {
    await getPrisma().webhookLog.create({
      data: {
        id: log.id,
        event: log.event,
        payload: log.payload as object,
        signatureVerified: log.signatureVerified,
        aiAction: log.aiAction,
        paymentLink: log.paymentLink,
      },
    });
  } catch (err: any) {
    console.error("[DB] Failed to save webhook log:", err.message);
  }
}

export async function dbLoadWebhookLogs(limit = 50): Promise<Array<any>> {
  if (!dbEnabled()) return [];
  try {
    return await getPrisma().webhookLog.findMany({
      orderBy: { receivedAt: "desc" },
      take: limit,
    });
  } catch (err: any) {
    console.error("[DB] Failed to load webhook logs:", err.message);
    return [];
  }
}

// ── Registered Payment Links Persistence ────────────────────────────────────

export interface DbPaymentLink {
  id: string;
  shortUrl: string;
  amountInr: number;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  caseId?: string | null;
  notes?: string | null;
  status?: string;
  simulated?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export async function dbSaveRegisteredPaymentLink(link: DbPaymentLink): Promise<DbPaymentLink | null> {
  if (!dbEnabled()) return link;
  try {
    const record = await getPrisma().registeredPaymentLink.upsert({
      where: { id: link.id },
      update: {
        shortUrl: link.shortUrl,
        amountInr: link.amountInr,
        customerName: link.customerName || null,
        customerEmail: link.customerEmail || null,
        customerPhone: link.customerPhone || null,
        caseId: link.caseId || null,
        notes: link.notes || null,
        status: link.status || "created",
        simulated: link.simulated || false,
      },
      create: {
        id: link.id,
        shortUrl: link.shortUrl,
        amountInr: link.amountInr,
        customerName: link.customerName || null,
        customerEmail: link.customerEmail || null,
        customerPhone: link.customerPhone || null,
        caseId: link.caseId || null,
        notes: link.notes || null,
        status: link.status || "created",
        simulated: link.simulated || false,
      },
    });
    return {
      id: record.id,
      shortUrl: record.shortUrl,
      amountInr: record.amountInr,
      customerName: record.customerName,
      customerEmail: record.customerEmail,
      customerPhone: record.customerPhone,
      caseId: record.caseId,
      notes: record.notes,
      status: record.status,
      simulated: record.simulated,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  } catch (err: any) {
    console.error("[DB] Failed to save registered payment link:", err?.message);
    return link;
  }
}

export async function dbLoadRegisteredPaymentLinks(limit = 100): Promise<DbPaymentLink[]> {
  if (!dbEnabled()) return [];
  try {
    const rows = await getPrisma().registeredPaymentLink.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      shortUrl: r.shortUrl,
      amountInr: r.amountInr,
      customerName: r.customerName,
      customerEmail: r.customerEmail,
      customerPhone: r.customerPhone,
      caseId: r.caseId,
      notes: r.notes,
      status: r.status,
      simulated: r.simulated,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  } catch (err: any) {
    console.error("[DB] Failed to load registered payment links:", err?.message);
    return [];
  }
}

export async function dbDeleteRegisteredPaymentLink(id: string): Promise<boolean> {
  if (!dbEnabled()) return true;
  try {
    await getPrisma().registeredPaymentLink.delete({ where: { id } });
    return true;
  } catch (err: any) {
    console.error("[DB] Failed to delete registered payment link:", err?.message);
    return false;
  }
}

