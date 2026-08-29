# RazorVasooli.Ai — AI Revenue Recovery Agent for Razorpay

RazorVasooli.Ai is an AI-powered revenue recovery agent natively integrated with
Razorpay. It detects revenue at risk across **payment failures, cart
abandonments, subscription lapses, and overdue invoices**, diagnoses root
causes, reasons about bounded interventions behind a rules-based veto
guardrail, executes real Razorpay API calls (with transparent mock fallback),
adheres strictly to Indian regulatory compliance (**DPDP, RBI quiet hours &
AFA thresholds**), maintains a **tamper-evident SHA-256 hash-chained audit
ledger**, and proves measured recovery across **A/B batches**.

## Architecture

The implementation consolidates the planned microservice topology
(ingestion → diagnosis → policy → orchestrator → channels → audit) into a
single Express server (`server/`) with an in-process risk event bus, keeping
every stage cleanly separated by module:

```
Razorpay Webhooks / Checkout Beacon / Overdue Poller
        │  HMAC verify + dual dedup (server/ingestion.ts)
        ▼
In-process Risk Event Bus
        ├─▶ Diagnosis Engine   (taxonomy + recoverability score)
        ├─▶ Policy Engine      (allowed actions + LLM agent + veto guardrail)
        │        └─▶ LLM Gateway (Gemini / Groq / deterministic fallback)
        └─▶ Orchestrator       (bounded state machine + compliance hard stops)
                 ├─▶ Channel Adapters (payment links · email · SMS)
                 └─▶ Reply Intake     (Hinglish intent parser)
All stages ──▶ Audit Service (single-writer SHA-256 hash chain)
```

| Module | Responsibility |
| --- | --- |
| `server/ingestion.ts` | HMAC-verified webhook ingress, dual dedup, checkout beacon, overdue poller, event bus |
| `server/diagnosis.ts` | Razorpay error taxonomy, recoverability scoring, payday-aware timing |
| `server/policy.ts` | Allowed action set, deterministic baseline, LLM agent choice + veto guardrail (`agent` / `agent_vetoed` / `rule`) |
| `server/orchestrator.ts` | Bounded state machine, quiet-hours requeue, DPDP opt-out stops, RBI AFA checks, promise sweeper |
| `server/channels.ts` | Razorpay payment links, email/SMS adapters (mock-aware) |
| `server/voice.ts` | Voice script generation + Hinglish reply parsing |
| `server/audit.ts` | Append-only SHA-256 hash-chained ledger + chain verification |
| `server/simulator.ts` | Seeded PRNG batch generator, A/B attribution benchmark |

## Quick Start

```bash
npm install

# Terminal 1 — backend API on http://127.0.0.1:5000
npm run server

# Terminal 2 — dashboard on http://127.0.0.1:5173 (proxies /api)
npm run dev
```

Or run both together: `npm run dev:all`

### Demo automation

```bash
# Seed a fresh cold-start demo: Batch A (Agent On) + Batch B (Control)
npm run demo:seed

# Run additional reproducible batches against a running backend
npm run simulate:batch -- --seed 424242 --size 45 --both
```

Both scripts require the backend to be running (`npm run server`).

## Dashboard Views

- **Command Center** — live ₹ recovered / at-risk KPIs, kill-switch toggle
  (Agentic Recovery vs Control Baseline), live A/B attribution ticker,
  "Verify Batch Integrity" cryptographic proof button.
- **AI Vasooli Agent** — live agent conversation view.
- **Failed Invoices** — invoice-level recovery status.
- **Case Directory** — filterable case states with escalation queue
  (Mark Resolved / Offer 5% Discount Link / Write Off) and audit timelines.
- **Webhook Stream** — synthetic webhook generator and raw event feed.
- **A/B Recovery Lab** — seeded batch simulator, side-by-side attribution
  report (rate lift, net rupee delta, ROI per ₹ spent), batch history,
  batch integrity proof.
- **Audit Ledger** — block-by-block hash chain explorer with one-click
  verification.

## Hardening (Phase H1)

- **Containerized:** `docker compose up -d --build` runs the full stack
  (app + Postgres + Redis + Mailpit). The app container serves both the API
  and the built dashboard SPA on port 5000 (`NODE_ENV=production`). Dev mode
  is unchanged: `docker compose up -d postgres redis mailpit` + `npm run dev:all`.
- **Durable risk events:** webhook events are enqueued via BullMQ/Redis
  (`REDIS_URL`) with exponential-backoff retries, so a crash after receipt no
  longer loses them. Without Redis, direct in-process publishing is used.
- **DPDP opt-outs persisted** to Postgres and hydrated at boot — customers who
  opted out are never re-contacted after a restart.
- **Kill-switch durability:** the Agentic/Control mode is server state now
  (`GET/PUT /api/system/mode`), persisted to Postgres and appended to the hash
  chain as `system.mode_changed`. The dashboard reads/writes it live.
- **Observability:** pino structured logs with request IDs; Prometheus metrics
  at `GET /metrics`; readiness probe at `GET /api/ready`.
- **Tests:** `npm test` (Vitest) covers the audit hash chain, policy veto
  guardrail, orchestrator state machine/compliance stops, and diagnosis taxonomy.

## Configuration

Copy `.env.example` to `.env`:

- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — real Razorpay test keys. When
  absent, built-in mock adapters simulate realistic Razorpay responses.
- `LLM_API_KEY` — Google Gemini or Groq key. Without it the policy engine
  operates at full functionality using deterministic fallback rules.
- Webhook secret for `POST /api/webhooks/razorpay` HMAC verification.

## Compliance Disclosures

- **DPDP Act:** customers in the opt-out registry are never contacted;
  mid-sequence opt-outs halt immediately (`SKIPPED_COMPLIANCE`).
- **RBI quiet hours (21:00–09:00 IST):** outreach scheduled in quiet hours is
  requeued for 09:05 IST next morning and logged as `deferred_quiet_hours`.
- **RBI e-mandate AFA:** additional factor of authentication enforced above
  the configurable threshold (default ₹15,000).
- **Attempt caps:** maximum 3 contact attempts per case.

## Verification

Every pipeline event lands in the append-only audit ledger where
`Hₙ = SHA256(Hₙ₋₁ ∥ timestamp ∥ event_type ∥ payload)`. Verify integrity any
time via `GET /api/audit/verify`, or from the dashboard's
**Verify Batch Integrity** buttons.

```bash
npm run build   # type-check + production build
npm run lint    # oxlint
```
