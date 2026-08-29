#!/usr/bin/env node
/**
 * Task 8.3: `npm run demo:seed` — cold-start demo bootstrap.
 * Verifies the backend is up (in-memory stores are fresh on every boot),
 * seeds a representative Batch A (Agent On) + Batch B (Control) run so the
 * dashboard opens with live metrics and an A/B attribution report.
 *
 * Usage: npm run demo:seed [-- --seed 424242 --size 45]
 */
import { parseArgs } from "node:util";

const API = process.env.RAZORVASOOLI_API || "http://127.0.0.1:5000";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "424242" },
    size: { type: "string", default: "45" },
  },
});

async function waitForServer(retries = 15) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function runBatch(agentOn) {
  const res = await fetch(`${API}/api/simulator/run-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  await runBatch(true); // Batch A — Agent On
  await runBatch(false); // Batch B — Control baseline

  const audit = await (await fetch(`${API}/api/audit/verify`)).json();
  console.log(`🔐 Audit chain ${audit.valid ? "INTACT" : "BROKEN"} — ${audit.entriesChecked} blocks verified`);
  console.log("\n🎉 Demo ready → open the dashboard (npm run dev) and check the Command Center & A/B Recovery Lab.");
} catch (err) {
  console.error("❌ Demo seed failed:", err.message);
  process.exit(1);
}
