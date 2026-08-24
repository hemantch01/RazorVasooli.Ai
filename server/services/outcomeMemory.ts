/**
 * RazorVasooli.Ai — Outcome Memory & Learning Loop (Phase L1)
 *
 * Closes the loop between intervention outcomes and policy decisions:
 *   every recovery/failure increments aggregated counters keyed by
 *   "{category}|{channel}|{attempt}" and the policy engine ranks allowed
 *   channels by their measured (Laplace-smoothed) success rate.
 *
 * Properties:
 *   • ONLINE — recordOutcome() updates counters immediately; the next
 *     decision reads them (no retraining, no batch job).
 *   • SMOOTHED — Laplace smoothing pulls tiny samples toward 0.5 so a
 *     lucky 1/1 channel can't hijack ranking.
 *   • SAFE — memory can only RE-RANK channels inside the rules-based
 *     Allowed Action Set; it can never bypass veto guardrails or
 *     compliance stops.
 *
 * Cold start: seedFromPersonas() generates ~250 realistic synthetic
 * customers (see PERSONA_SPECS) so day-one decisions have believable
 * priors. Seeded records and live records are indistinguishable after
 * ingestion — real traffic naturally outvotes the seed over time.
 */

import {
  dbUpsertOutcomeStat,
  dbLoadOutcomeStats,
  dbClearOutcomeStats,
  dbSaveLearningEvents,
} from "../core/db.js";

// Types

export interface OutcomeStat {
  key: string;
  category: string;
  channel: string;
  attempt: number;
  attempted: number;
  recovered: number;
  /** Laplace-smoothed success rate: (recovered + 1) / (attempted + 2) */
  rate: number;
}

export interface RecordedOutcome {
  category: string;
  channel: string;
  attempt: number;
  recovered: boolean;
  amountInr?: number;
  discountPercent?: number;
  customerSegment?: string;
  source?: "seed" | "live" | "simulator";
}

export interface SeedSummary {
  totalUsers: number;
  totalOutcomes: number;
  recovered: number;
  byPersona: Record<string, number>;
  sampleConversations: Array<{ persona: string; channel: string; messages: Array<{ dir: "in" | "out"; text: string }> }>;
}

const memStats = new Map<string, Stat>();
interface Stat { attempted: number; recovered: number }

let hydrated = false;

function keyOf(category: string, channel: string, attempt: number): string {
  return `${category}|${channel}|${attempt}`;
}

function parseKey(key: string): { category: string; channel: string; attempt: number } {
  const [category, channel, attempt] = key.split("|");
  return { category, channel, attempt: Number(attempt) || 0 };
}

/** Laplace-smoothed rate — alpha=beta=1 keeps small samples near 0.5. */
export function smoothedRate(recovered: number, attempted: number): number {
  if (attempted <= 0) return 0.5;
  return (recovered + 1) / (attempted + 2);
}

// Hydration

/** Load persisted counters into memory at boot (restart survival). */
export async function hydrateOutcomeMemory(): Promise<number> {
  if (hydrated) return memStats.size;
  const rows = await dbLoadOutcomeStats();
  for (const r of rows) {
    memStats.set(r.key, { attempted: r.attempted, recovered: r.recovered });
  }
  hydrated = true;
  if (rows.length > 0) console.log(`[Learning] ♻️ Restored ${rows.length} outcome stat(s) from PostgreSQL`);
  return memStats.size;
}

// Recording

/** Record one intervention outcome. Updates memory immediately + persists async. */
export function recordOutcome(o: RecordedOutcome): void {
  const key = keyOf(o.category, o.channel, o.attempt);
  const stat = memStats.get(key) ?? { attempted: 0, recovered: 0 };
  stat.attempted += 1;
  if (o.recovered) stat.recovered += 1;
  memStats.set(key, stat);

  // Durable persistence — never blocks the pipeline
  const recoveredDelta = o.recovered ? 1 : 0;
  void dbUpsertOutcomeStat(key, recoveredDelta).catch(() => undefined);
  void dbSaveLearningEvents([{
    category: o.category,
    channel: o.channel,
    attempt: o.attempt,
    recovered: o.recovered,
    amountInr: o.amountInr,
    discountPercent: o.discountPercent,
    customerSegment: o.customerSegment,
    source: o.source ?? "live",
  }]).catch(() => undefined);
}

// Querying

/** All stats for a category, sorted by smoothed rate (best first). */
export function getCategoryStats(category: string): OutcomeStat[] {
  const out: OutcomeStat[] = [];
  for (const [key, s] of memStats.entries()) {
    const parsed = parseKey(key);
    if (parsed.category !== category) continue;
    out.push({
      key, category, channel: parsed.channel, attempt: parsed.attempt,
      attempted: s.attempted, recovered: s.recovered,
      rate: smoothedRate(s.recovered, s.attempted),
    });
  }
  return out.sort((a, b) => b.rate - a.rate);
}

/**
 * Rank allowed channels by measured success for this category (any attempt).
 * Returns the SAME channels, possibly reordered — never adds/removes channels.
 * Cold start (no data): original order preserved (all smoothed rates ≈ 0.5).
 */
export function rankChannelsBySuccess(category: string, allowedChannels: string[]): string[] {
  const stats = getCategoryStats(category);
  if (stats.length === 0) return [...allowedChannels];

  // Best observed rate per channel (across attempts), then sort descending.
  const bestRate = new Map<string, number>();
  for (const s of stats) {
    const cur = bestRate.get(s.channel);
    if (cur === undefined || s.rate > cur) bestRate.set(s.channel, s.rate);
  }
  return [...allowedChannels].sort((a, b) => (bestRate.get(b) ?? 0.5) - (bestRate.get(a) ?? 0.5));
}

/** Compact per-channel performance summary (for LLM prompt / dashboard). */
export function getCategorySummary(category: string, limit = 8): Array<{
  channel: string; attempted: number; recovered: number; rate: number;
}> {
  const agg = new Map<string, Stat>();
  for (const s of getCategoryStats(category)) {
    const cur = agg.get(s.channel) ?? { attempted: 0, recovered: 0 };
    cur.attempted += s.attempted;
    cur.recovered += s.recovered;
    agg.set(s.channel, cur);
  }
  return [...agg.entries()]
    .map(([channel, s]) => ({ channel, ...s, rate: smoothedRate(s.recovered, s.attempted) }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, limit);
}

/** Most confident learned rules (dashboard "Agent Learning" card). */
export function getTopLearnedRules(limit = 5): OutcomeStat[] {
  return [...memStats.entries()]
    .map(([key, s]) => {
      const parsed = parseKey(key);
      const rate = smoothedRate(s.recovered, s.attempted);
      return { key, ...parsed, attempted: s.attempted, recovered: s.recovered, rate };
    })
    .sort((a, b) =>
      Math.abs(b.rate - 0.5) * Math.sqrt(b.attempted) -
      Math.abs(a.rate - 0.5) * Math.sqrt(a.attempted))
    .slice(0, limit);
}

export function getMemorySize(): number {
  return memStats.size;
}

// Persona-driven seed generator (cold-start bootstrap)

type Rng = () => number;

/** mulberry32 — same PRNG as the batch simulator, fully reproducible seeds. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, weighted: Array<[T, number]>): [T, number] {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const entry of weighted) {
    roll -= entry[1];
    if (roll <= 0) return entry;
  }
  return weighted[weighted.length - 1];
}

/** Per-persona channel success probabilities — deliberately imperfect so the
 *  engine has real signal to discover (Telegram over-performs on chat-friendly
 *  personas, email under-performs on hard declines, discounts convert refusers). */
const CHANNEL_WIN_RATES: Record<string, Array<[string, number]>> = {
  instant_payer:     [["payment_link", 0.85], ["telegram", 0.80], ["email", 0.60], ["sms", 0.55]],
  salary_struggler:  [["sms", 0.78], ["telegram", 0.74], ["payment_link", 0.65], ["email", 0.50]],
  promise_breaker:   [["telegram", 0.58], ["email", 0.52], ["sms", 0.44], ["payment_link", 0.40]],
  refuser_converter: [["telegram", 0.62], ["payment_link", 0.45], ["email", 0.40], ["sms", 0.38]],
  hard_decline:      [["subscription_update_link", 0.70], ["payment_link", 0.45], ["telegram", 0.30], ["email", 0.15]],
  loyal_upgrader:    [["email", 0.72], ["telegram", 0.68], ["sms", 0.48]],
};

const PERSONA_SPECS: Array<{
  id: string; count: number; category: string; segment: string;
  minAttempts: number; maxAttempts: number; discountFromAttempt?: number;
}> = [
  { id: "instant_payer",     count: 52, category: "soft_decline_network", segment: "standard",      minAttempts: 1, maxAttempts: 1 },
  { id: "salary_struggler",  count: 48, category: "soft_decline_funds",   segment: "standard",      minAttempts: 2, maxAttempts: 3, discountFromAttempt: 3 },
  { id: "promise_breaker",   count: 36, category: "invoice_overdue",      segment: "promise_maker", minAttempts: 2, maxAttempts: 4, discountFromAttempt: 3 },
  { id: "refuser_converter", count: 32, category: "soft_decline_funds",   segment: "refuser",       minAttempts: 2, maxAttempts: 3, discountFromAttempt: 2 },
  { id: "hard_decline",      count: 30, category: "hard_decline_card",    segment: "card_issue",    minAttempts: 2, maxAttempts: 3 },
  { id: "boundary_setter",   count: 15, category: "soft_decline_funds",   segment: "opt_out",       minAttempts: 1, maxAttempts: 1 },
  { id: "never_recovers",    count: 12, category: "invoice_overdue",      segment: "chronic",       minAttempts: 3, maxAttempts: 3 },
  { id: "loyal_upgrader",    count: 25, category: "upgrade_offer",        segment: "good_standing", minAttempts: 1, maxAttempts: 1, discountFromAttempt: 1 },
];
// Totals exactly 250 users.

const SAMPLE_CONVERSATIONS: SeedSummary["sampleConversations"] = [
  { persona: "refuser_converter", channel: "telegram", messages: [
    { dir: "in", text: "arre bhai paisa nahi hai is mahine" },
    { dir: "out", text: "Koi baat nahi ji 🙏 Aapke liye ek option hai — 10% discount ke saath aaj settle kar sakte hain" },
    { dir: "in", text: "10% mein theek hai, link bhejo" },
    { dir: "out", text: "Yeh lijiye special discounted link 💚 — sirf aaj ke liye valid" },
  ]},
  { persona: "salary_struggler", channel: "sms", messages: [
    { dir: "out", text: "Namaste Priya ji, ₹2,499 pending hai. Salary aane ke baad pay karein — link yahan hai" },
    { dir: "in", text: "5 din baad milta hai salary" },
    { dir: "out", text: "Koi issue nahi — 1st tareekh ko remind kar denge 👍" },
  ]},
  { persona: "loyal_upgrader", channel: "email", messages: [
    { dir: "out", text: "🌟 Aap hamare loyal customer ho — Annual plan pe switch karo aur flat 10% off paao" },
    { dir: "in", text: "Sounds good, upgrading. Send the link." },
  ]},
  { persona: "boundary_setter", channel: "email", messages: [
    { dir: "in", text: "mujhe ye reminders band karo, DPDP ke under opt-out" },
    { dir: "out", text: "Samajh gaye ji — aapko aur koi message nahi aayega. Aapka data protection right respect kiya gaya ✅" },
  ]},
];

/**
 * Generate `totalUsers` synthetic historical outcomes from the persona mix.
 * Deterministic for a given seed (reproducible demos). Clears prior memory.
 */
export async function seedFromPersonas(
  totalUsers = Number(process.env.LEARNING_SEED_SIZE || 250),
  rngSeed = 20260823
): Promise<SeedSummary> {
  await clearOutcomeMemory();
  const rng = mulberry32(rngSeed);

  // Scale persona counts proportionally to hit the requested total.
  const specTotal = PERSONA_SPECS.reduce((s, p) => s + p.count, 0);
  const byPersona: Record<string, number> = {};
  const events: Parameters<typeof dbSaveLearningEvents>[0] = [];

  let allocated = 0;
  const scaled = PERSONA_SPECS.map((p, i) => {
    const n = i === PERSONA_SPECS.length - 1
      ? Math.max(0, totalUsers - allocated) // last persona absorbs rounding remainder
      : Math.round((p.count / specTotal) * totalUsers);
    allocated += n;
    byPersona[p.id] = n;
    return { ...p, n };
  });

  let outcomes = 0;
  let recoveredCount = 0;

  for (const spec of scaled) {
    for (let u = 0; u < spec.n; u++) {
      const maxAttempt = spec.minAttempts + Math.floor(rng() * (spec.maxAttempts - spec.minAttempts + 1));
      let convertedThisUser = false;

      for (let attempt = 1; attempt <= maxAttempt && !convertedThisUser; attempt++) {
        const fallbackChannel: Array<[string, number]> = [["email", 0.3]];
        const [channel, baseWin] = pick(rng, CHANNEL_WIN_RATES[spec.id] ?? fallbackChannel);
        // Discount ladder: flat 10% for loyal upgrade offers; 5% once a persona
        // crosses its configured attempt — mirrors the policy engine's rules.
        const discount = spec.id === "loyal_upgrader"
          ? 10
          : spec.discountFromAttempt && attempt >= spec.discountFromAttempt ? 5 : 0;

        // Boundary setters opt out at first contact (terminal). Never-recovers
        // always fail. Others roll against persona odds, with a small boost on
        // later discounted attempts (refusers soften when money is on the table).
        let win = false;
        if (spec.id !== "boundary_setter" && spec.id !== "never_recovers") {
          const attemptBoost = attempt > 1 ? (discount > 0 ? 0.08 : 0.04) : 0;
          win = rng() < Math.min(0.95, baseWin + attemptBoost);
        }

        events.push({
          category: spec.category,
          channel,
          attempt,
          recovered: win,
          amountInr: Math.round((500 + rng() * 45000) / 100) * 100,
          discountPercent: discount,
          customerSegment: spec.segment,
          source: "seed",
        });
        recordOutcome({
          category: spec.category, channel, attempt,
          recovered: win, discountPercent: discount,
          customerSegment: spec.segment, source: "seed",
        });
        outcomes++;
        if (win) { convertedThisUser = true; recoveredCount++; }
      }
    }
  }

  // Persist raw events durably (stats already mirrored via recordOutcome)
  await dbSaveLearningEvents(events);

  console.log(`[Learning] 🌱 Seeded ${totalUsers} synthetic users → ${outcomes} outcomes (${recoveredCount} recovered, ${Math.round((recoveredCount / Math.max(1, totalUsers)) * 100)}%) across ${memStats.size} stat keys`);
  return {
    totalUsers,
    totalOutcomes: outcomes,
    recovered: recoveredCount,
    byPersona,
    sampleConversations: SAMPLE_CONVERSATIONS,
  };
}

/** Wipe memory + persisted learning data (used before re-seeding). */
export async function clearOutcomeMemory(): Promise<void> {
  memStats.clear();
  hydrated = true;
  await dbClearOutcomeStats();
}
