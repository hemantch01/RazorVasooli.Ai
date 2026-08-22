/**
 * RazorVasooli.Ai — System Settings (kill-switch durability, Phase H1)
 *
 * Server-side runtime settings that must survive restarts and be shared
 * across dashboard tabs/clients. Postgres-backed when DATABASE_URL is set;
 * in-memory fallback otherwise (same degradation pattern as core/db.ts).
 *
 * The agentic kill-switch lives here now — previously it was localStorage-only
 * in OverviewView.tsx, so a restart (or another browser) silently flipped mode.
 */

import { dbEnabled, dbGetSetting, dbSetSetting } from "./db.js";

export type AgentMode = "agentic" | "control";

const MODE_KEY = "agent_mode";
let memoryMode: AgentMode = "agentic";
let hydrated = false;

/** Load persisted settings into memory at boot. */
export async function hydrateSettings(): Promise<void> {
  if (!dbEnabled() || hydrated) return;
  try {
    const value = await dbGetSetting(MODE_KEY);
    if (value === "agentic" || value === "control") {
      memoryMode = value;
      console.log(`[Settings] ♻️ Restored agent mode from DB: ${value}`);
    }
    hydrated = true;
  } catch (err) {
    console.warn("[Settings] hydrate failed:", (err as Error).message);
  }
}

export async function getAgentMode(): Promise<AgentMode> {
  if (dbEnabled()) {
    try {
      const value = await dbGetSetting(MODE_KEY);
      if (value === "agentic" || value === "control") {
        memoryMode = value;
        return value;
      }
    } catch {
      /* fall through to memory */
    }
  }
  return memoryMode;
}

/** Persist a new mode. Returns the effective mode. */
export async function setAgentMode(mode: AgentMode): Promise<AgentMode> {
  memoryMode = mode;
  if (dbEnabled()) {
    try {
      await dbSetSetting(MODE_KEY, mode);
    } catch (err) {
      console.warn("[Settings] persist failed:", (err as Error).message);
    }
  }
  return mode;
}
