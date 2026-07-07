# Oikos Ledger — Architecture

## Overview

Oikos Ledger has two primary runtimes connected by a shared CockroachDB Cloud database:

- **Python (AWS Lambda)** — CSV ingestion, two-stage normalisation, embedding generation, balance verification
- **Next.js (Vercel)** — UI, authentication, Route Handlers, agentic NL→SQL, voice interface, real-time dashboard queries

Both runtimes talk to the same CockroachDB Cloud cluster. Python owns all ingestion writes; Next.js owns all reads and insights writes.

---

## System Diagram

```
Browser
  │
  ├── Next.js (Vercel)
  │     ├── App Router pages (RSC + Client Components)
  │     ├── Route Handlers (API layer)
  │     ├── Drizzle ORM ──────────────────────────────────────┐
  │     ├── OpenAI Realtime API (voice WebSocket)             │
  │     └── OpenAI API (agentic NL→SQL, embeddings, TTS)      │
  │                                                            ▼
  │                                                   CockroachDB Cloud
  │                                                   (Mumbai / ap-south-1)
  │                                                   vector · spatial
  │                                                            ▲
  └── CSV upload ──► S3 bucket                                 │
                       │                                       │
                       ▼                                       │
                   Lambda (Python 3.12)                        │
                     ├── parser (bank-specific)                │
                     ├── normaliser (deterministic + LLM)      │
                     ├── embedder (OpenAI)                     │
                     ├── balance verifier                      │
                     └── SQLModel ─────────────────────────────┘
```

---

## Components

### Frontend — Next.js / Vercel

- App Router with route groups: `(auth)` for unauthenticated pages, `(dashboard)` for protected pages
- Drizzle ORM connects to CockroachDB Cloud via a Postgres-wire-compatible connection string (`DATABASE_URL`)
- shadcn/ui component library with Tailwind CSS
- Route Handlers at `app/api/` serve all data to the frontend

**Key pages:**
- `/` — Dashboard with transaction list, filter bar, amendment modal, upload flow
- `/insights` — Chat interface for natural language financial queries (text + voice)
- `/recommendations` — On-demand AI spending recommendations vs RBI benchmarks
- `/analytics` — Multi-tab deterministic analytics: top merchants, payment methods over time, subcategories, debit vs credit

**Constants layer** — `app/lib/constants/`:
- `banks.ts` — 4 supported Indian banks (HDFC, Axis, ICICI, SBI) with display names and domains
- `currencies.ts` — INR only; structured for multi-currency extension

**Bank logos** — `BankLogo` component fetches from Google Favicon API (`https://www.google.com/s2/favicons?domain={domain}&sz=64`). Falls back to `public/fallback-bank-icon.svg`.

---

### Authentication — NextAuth v5 (Auth.js)

- **Provider:** Google OAuth only
- **Session strategy:** JWT (stateless). No `sessions` table. Session is a signed JWT in a cookie.
- **User provisioning:** `signIn` callback creates a `users` row on first sign-in (`country_code = "IN"`, `currency = "INR"`).
- **Session enrichment:** `jwt` callback stores `user.id` (UUID) in the JWT; `session` callback surfaces `session.user.id` for Route Handlers.
- **Middleware:** `middleware.ts` uses an edge-safe auth config (`auth.config.ts`, no `pg` imports) to protect routes.

**File layout:**
```
app/auth.config.ts          — edge-safe config (used by middleware)
app/auth.ts                 — full config (Google provider + DB callbacks)
app/middleware.ts           — protects /(dashboard)/* routes
app/app/api/auth/[...nextauth]/route.ts
```

---

### Insights Pipeline — Next.js Route Handler

**File:** `app/app/api/insights/query/route.ts`

**Flow:**

```
POST /api/insights/query
  │
  ├─ Pre-built intent? → execute intent SQL directly → stream SSE
  │    (monthly_trend, biggest_expenses, credits_vs_debits,
  │     top_merchants, spending_by_category)
  │
  ├─ Exact cache hit (SHA-256)? → return cached JSON
  │
  ├─ Similar cache hit (pgvector cosine > 0.85)? → return suggestions
  │
  └─ Agent loop (runAgentLoop)
       │
       ├─ GPT-4o-mini + run_sql tool + conversation history
       │    run_sql parameters: { sql: string, chart_type: enum }
       │
       ├─ Tool call → validateSQL → execute → synthesize → stream SSE
       │
       └─ No tool call → direct response (clarification / off-topic)
```

**Cache layer:**
- `query_cache` table with `UNIQUE (user_id, account_id, query_hash)`
- Tier 1: SHA-256 hash exact match (no embedding needed)
- Tier 2: pgvector cosine similarity on `query_embedding` (threshold 0.85, returns up to 3 suggestions)
- Cache TTL: 24 hours, refreshed on conflict

**Chart types** (returned by agent as structured `chart_type` parameter):
- `line` — time series (day/week/month + single value)
- `bar` — category ranked by total (vertical)
- `horizontal_bar` — top merchants or long labels (horizontal)
- `comparison_bar` — debits vs credits per time period
- `multi_bar` — grouped bars with dynamic series (e.g. payment methods over time)
- `pie` — category breakdown with percentages
- `table` — multi-dimension or text-heavy results
- `none` — single scalar answer

**Streaming:** SSE with `data: {"type":"metadata",...}` → `data: {"type":"text",...}` chunks → `data: [DONE]`

---

### Voice Interface — OpenAI Realtime API

**Model:** `gpt-realtime-2` via WebSocket (`wss://api.openai.com/v1/realtime`)  
**Session:** Ephemeral key from `POST /api/insights/session`

**Tools in session:**
- `query_database` — triggers `handleQuery` → `POST /api/insights/query` with `is_voice: true`
- `end_conversation` — farewell flow → timed disconnect

**Audio pipeline:**
- Mic → AudioWorklet (PCM resampled to 16kHz) → WebSocket
- WebSocket audio deltas → AudioContext scheduler (24kHz output)
- GainNode mute on barge-in; `conversation.item.truncate` to sync server state
- `currentAssistantItemId` ref tracks active item; `mutedItemId` ref skips in-flight chunks after truncation

**VAD config:**
```typescript
turn_detection: {
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 800,
  interrupt_response: true,
  create_response: true,
}
```

**Voice vs text differences:**
- `is_voice: true` → data cards (SQL + chart) shown in UI; text bubble suppressed
- Suggestions and off-topic canned messages suppressed in voice
- Model speaks summary via audio; UI shows chart/table card only

---

### Ingestion Pipeline — AWS Lambda

**Flow:**
```
S3 upload → Lambda → Parse CSV → Balance Verify →
Normalise (Deterministic + LLM) → Embed → Write CockroachDB
```

**Stage 1: CSV Parsing**
- Bank-specific parsers: HDFC, Axis, SBI, ICICI
- HDFC parser handles narrations with embedded commas (unquoted HDFC CSV export)
- Each row assigned `row_number` for intra-day ordering

**Stage 2: Balance Verification**
- Runs after parsing, before normalisation
- Verifies each row: `previous_closing ± amount = current_closing` (tolerance ±₹0.01)
- Results stored in `uploads`: `opening_balance`, `closing_balance`, `balance_verified`, `balance_discrepancy`
- Verification failure does not reject the upload — flagged in UI

**Stage 3: Normalisation (Two-Stage)**

*Deterministic path (first):*
- Payment gateway detection (RAZP, PAYU, CCAV, PAYTM, etc.)
- Bill payment override (`IB BILLPAY DR`)
- UPI parsing — merchant, VPA, app, bank extraction
- Keyword-based categorisation (scoring, longest match wins)

*LLM path (only when `needs_llm=True`):*
- Merchant registry lookup (ILIKE partial match)
- Registry hit → return cached values
- Registry miss → `gpt-4o-mini` (temperature=0) → upsert result

**Stage 4: Embedding**
- OpenAI `text-embedding-3-small`, 1536 dimensions, batch of 100

**Stage 5: Database Write**
- `INSERT ... ON CONFLICT DO NOTHING` for idempotency
- Two unique constraints: `reference_number` and `(date, amount, merchant)`

**Lambda config:**
- Runtime: Python 3.12 container image
- Memory: 512 MB · Timeout: 300s
- ECR: `oikos-ledger-ingestion` (ap-south-1)

---

### Database — CockroachDB Cloud

**Cluster:** `oikos-ledger` (CockroachDB Cloud, Basic tier, Mumbai / ap-south-1)  
**Native support:** Distributed Vector Indexing (VECTOR columns), spatial types (GEOMETRY/GEOGRAPHY, PostGIS-compatible subset — see ADR 014), pg_trgm-equivalent trigram search

**Connection strategy:**

| Context | Connection string |
|---|---|
| Scripts / local dev | `DATABASE_URL_DIRECT` |
| Lambda | `DATABASE_URL` |
| Next.js Route Handlers | `DATABASE_URL` |

CockroachDB Cloud handles connection pooling itself — no separate proxy or pooler tier required (see ADR 014).

**SSL:** `sslmode=require` (CockroachDB Cloud enforces TLS) — bundle CockroachDB Cloud's CA certificate in the Lambda Docker image for production.

---

### LLM Providers

| Purpose | Provider | Model |
|---|---|---|
| Agentic NL→SQL (text) | OpenAI (via proxy or direct) | `gpt-4o-mini` |
| Voice conversation | OpenAI Realtime API | `gpt-realtime-2` |
| Embeddings (insights cache) | OpenAI | `text-embedding-3-small` |
| Transaction normalisation (Lambda) | OpenAI | `gpt-4o-mini` |
| Transaction embeddings (Lambda) | OpenAI | `text-embedding-3-small` |

**Proxy:** `OPENAI_BASE_URL` — when set, uses dataexpert.io proxy with `OPENAI_API_KEY`. When empty, uses `api.openai.com` with `OPENAI_REALTIME_API_KEY` (standard `sk-proj-` key).

---

## Key Design Decisions

| Decision | ADR |
|---|---|
| Aurora PostgreSQL over Aurora DSQL and DynamoDB | ADR 001 |
| AWS Lambda over FastAPI for ingestion | ADR 002 |
| Drizzle ORM over raw pg client | ADR 003 |
| SQLModel + Drizzle instead of a single ORM | ADR 004 |
| Deterministic bank-specific parsers over LLM-based format detection | ADR 005 |
| Full pipeline idempotency at the database level | ADR 006 |
| Two-stage normalisation — deterministic first, LLM second | ADR 007 |
| setInterval over SWR for upload status polling | ADR 009 |
| Deterministic-first normalisation strategy | ADR 010 |
| row_number for intra-day transaction ordering | ADR 011 |
| Agentic NL→SQL with run_sql tool over classify→generateSQL two-step | ADR 012 |
| OpenAI Realtime API for voice interface | ADR 013 |
| Aurora PostgreSQL → CockroachDB migration for agentic memory | ADR 014 |
