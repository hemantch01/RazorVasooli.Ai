/**
 * RazorVasooli.Ai — Risk Event Queue (BullMQ + Redis, Phase H1)
 *
 * Durability layer between webhook ingress and the in-process RiskEventBus.
 * Webhook handlers enqueue instead of publishing directly, so a crash after
 * receipt no longer loses the event — BullMQ persists jobs in Redis and
 * redelivers them (with attempts/backoff) until processed.
 *
 * Graceful fallback (project-wide pattern): when REDIS_URL is unset or the
 * connection fails, events are published straight to the bus exactly as
 * before — the app never hard-depends on Redis to run.
 */

import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { RiskEvent } from "../services/ingestion.js";
import { metrics } from "./metrics.js";

const QUEUE_NAME = "risk-events";

// Lazy singletons

let queue: Queue<RiskEvent> | null = null;
let worker: Worker<RiskEvent> | null = null;
let redisAvailable = false;

/** Create a fresh ioredis connection for BullMQ (each Queue/Worker needs its own). */
function makeRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      if (times > 3) return null; // stop retrying after 3 attempts
      return Math.min(times * 500, 3000);
    },
  });
}

export function isQueueEnabled(): boolean {
  return redisAvailable && !!queue;
}

/** Initialize queue (+ optional worker). Safe to call when Redis is absent. */
export async function initQueue(publishToBus: (event: RiskEvent) => Promise<void>): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("[Queue] ⏭️ REDIS_URL not set — risk events publish directly to the in-process bus");
    return;
  }

  try {
    // BullMQ requires separate Redis connections for Queue and Worker
    const queueConn = makeRedis()!;
    const workerConn = makeRedis()!;

    queue = new Queue<RiskEvent>(QUEUE_NAME, {
      connection: queueConn,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });

    worker = new Worker<RiskEvent>(
      QUEUE_NAME,
      async (job) => {
        console.log(`[Queue] 🔄 Processing job ${job.id} (${job.data.type})`);
        await publishToBus(job.data);
        metrics.queueJob("published");
        console.log(`[Queue] ✅ Job ${job.id} published to bus`);
      },
      { connection: workerConn, concurrency: 10 }
    );

    worker.on("completed", (job) => {
      console.log(`[Queue] ✅ Job ${job.id} completed`);
    });

    worker.on("failed", (job, err) => {
      metrics.queueJob("failed");
      console.error(`[Queue] ❌ Job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade}):`, err.message);
    });

    worker.on("error", (err) => {
      console.error("[Queue] Worker error:", err.message);
    });

    // Probe the connection once; fall back permanently if unreachable.
    const probe = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
    });
    await probe.connect();
    await probe.ping();
    probe.disconnect();
    redisAvailable = true;
    console.log("[Queue] ✅ BullMQ connected — webhook events are durable via Redis");
  } catch (err) {
    redisAvailable = false;
    // Shut down worker and connections to stop retry spam
    try { await worker?.close(); } catch { /* ignore */ }
    try { await queue?.close(); } catch { /* ignore */ }
    queue = null;
    worker = null;
    console.warn("[Queue] ⚠️ Redis unavailable — falling back to direct in-process publishing:", (err as Error).message);
  }
}

/**
 * Producer used by webhook routes. Enqueues durably when Redis is up,
 * otherwise publishes straight to the bus (previous behavior).
 */
export async function enqueueRiskEvent(
  event: RiskEvent,
  directPublish: (event: RiskEvent) => Promise<void>
): Promise<void> {
  if (isQueueEnabled()) {
    try {
      await queue!.add(event.type, event, { jobId: `evt_${event.id}` });
      console.log(`[Queue] 📥 Enqueued ${event.type} (${event.id})`);
      return;
    } catch (err) {
      console.error("[Queue] enqueue failed, publishing directly:", (err as Error).message);
    }
  }
  metrics.queueJob("fallback_direct");
  await directPublish(event);
}

export function getQueueStats(): { enabled: boolean; queue: string } {
  return { enabled: isQueueEnabled(), queue: QUEUE_NAME };
}

export async function closeQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
}
