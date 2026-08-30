#!/usr/bin/env node
/**
 * Task 8.3: `npm run demo:seed` — cold-start demo bootstrap.
 * Verifies the backend is up (in-memory stores are fresh on every boot),
 * seeds a representative Batch A (Agent On) + Batch B (Control) run so the
 * dashboard opens with live metrics and an A/B attribution report.
 *
 * Usage: npm run demo:seed [-- --seed 424242 --size 45]
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

async function waitForServer(retries = 15) {
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
  console.log(`✅ Seeded ${data.batch.label} (seed ${data.batch.seed}, ${data.batch.size} txns)`);
}

console.log("🌱 RazorVasooli.Ai demo seed");
if (!(await waitForServer())) {
  console.error(`❌ Backend not reachable at ${API}. Start it first: npm run server`);
  process.exit(1);
}
console.log("✅ Backend healthy — in-memory stores fresh (cold start)");

try {
  await login();
  await runBatch(true); // Batch A — Agent On
  await runBatch(false); // Batch B — Control baseline

  const audit = await (await api("/api/audit/verify")).json();
  console.log(`🔐 Audit chain ${audit.valid ? "INTACT" : "BROKEN"} — ${audit.entriesChecked} blocks verified`);
  console.log("\n🎉 Demo ready → open the dashboard (npm run dev) and check the Command Center & A/B Recovery Lab.");
} catch (err) {
  console.error("❌ Demo seed failed:", err.message);
  process.exit(1);
}
