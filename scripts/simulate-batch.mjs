#!/usr/bin/env node
/**
 * Task 8.3: `npm run simulate:batch` — drives the running backend's
 * batch simulator. Runs Batch A (Agent On) and/or Batch B (Control)
 * with a shared seed for reproducible A/B attribution.
 *
 * Usage: node scripts/simulate-batch.mjs [--seed 424242] [--size 45] [--both]
 *
 * Auth: logs in as the default admin (ADMIN_EMAIL/ADMIN_PASSWORD, or the
 * .env defaults) and sends the session cookie — the API is auth-gated.
 */
import "dotenv/config";
import { parseArgs } from "node:util";

const API = process.env.RAZORVASOOLI_API || "http://127.0.0.1:5000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@razorvasooli.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "424242" },
    size: { type: "string", default: "45" },
    both: { type: "boolean", default: false },
  },
});

let cookie = "";

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Login failed (HTTP ${res.status}): ${data.error || "check ADMIN_EMAIL/ADMIN_PASSWORD"}`);
  }
  const setCookie = res.headers.get("set-cookie") || "";
  cookie = setCookie.split(";")[0];
  console.log(`✅ Authenticated as ${ADMIN_EMAIL}`);
}

async function api(path, init = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
  });
}

async function waitForServer(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${API}/api/ready`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function runBatch(agentOn) {
  const res = await api("/api/simulator/run-batch", {
    method: "POST",
    body: JSON.stringify({ seed: Number(values.seed), size: Number(values.size), agentOn }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
  const b = data.batch;
  console.log(
    `✅ ${b.label}: ${b.size} txns · recovered ₹${b.summary.totalRecoveredInr.toLocaleString("en-IN")} · rate ${(b.summary.recoveryRate * 100).toFixed(1)}%`
  );
}

const up = await waitForServer();
if (!up) {
  console.error(`❌ Backend not reachable at ${API}. Start it first: npm run server`);
  process.exit(1);
}

try {
  await login();
  await runBatch(true); // Batch A — Agent On
  if (values.both) await runBatch(false); // Batch B — Control

  const rep = await (await api("/api/simulator/ab-report")).json();
  if (rep.hasComparison && rep.attribution) {
    const a = rep.attribution;
    console.log("\n── A/B Attribution ─────────────────────────────");
    console.log(`Recovery rate : Agent ${(rep.agentBatch.recoveryRate * 100).toFixed(1)}% vs Control ${(rep.controlBatch.recoveryRate * 100).toFixed(1)}%`);
    console.log(`Rate lift     : +${(a.recoveryRateLift * 100).toFixed(1)}% (+${(a.recoveryRateLiftPct ?? 0).toFixed(0)}% relative)`);
    console.log(`Net rupee delta: ₹${a.netRupeeDelta.toLocaleString("en-IN")}`);
    console.log(`ROI per ₹ spent: ₹${a.roiPerRupeeSpent.toFixed(2)}`);
  }

  const audit = await (await api("/api/audit/verify")).json();
  console.log(
    `\n🔐 Audit chain ${audit.valid ? "INTACT" : "BROKEN"} — ${audit.entriesChecked} blocks verified`
  );
} catch (err) {
  console.error("❌ Simulation failed:", err.message);
  process.exit(1);
}
