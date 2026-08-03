# Oikos Recall

> *When did you last ask your bank statement a plain English question and have it remember what it told you last time?

Oikos Recall is a conversational personal finance app that turns Indian bank statements into charts, trends, and AI-powered spending insights, just by asking, and remembers what it has told you over time. Built for the CockroachDB × AWS Hackathon (Submission Period June 30 – Aug 18, 2026), extending Oikos Ledger, a personal finance app originally built for the AWS + Vercel Hackathon 2026 (Track 1 B2C).

**Live demo:** https://oikos-recall.vercel.app

---

## Project Lineage

This project extends [Oikos Ledger](https://github.com/sl2902/oikos_ledger), a personal finance app originally built for the **AWS + Vercel Hackathon 2026** (Track 1 B2C), submitted June 29, 2026.

Everything built between **June 30 and August 18, 2026** — the CockroachDB × AWS Hackathon Submission Period — is new:
- The CockroachDB-backed agentic memory layer
- The Macro page
- Two-account comparison (Compare page — currently hard-capped at exactly two accounts, both in the UI and structurally in the `semantic_facts` schema; not N-way)
- Memory-grounded upgrades to the Insights agent (voice and text) — fact retrieval via CockroachDB vector similarity, tiered response caching
- A shared voice architecture across all four voice-enabled pages (Insights, Macro, Compare, Recommendations) — consolidated four independent implementations into one hook, removing roughly 2,000 lines of duplicated code

The pre-existing Oikos Ledger codebase — auth, core data model, UI shell — is unchanged and predates this period.

---

## What it does

- **Multi-bank ingestion** — upload CSV statements from HDFC, ICICI, and Axis Bank. The pipeline parses each bank's unique format, normalises merchant names, categorises transactions, and validates opening and closing balances row by row.
- **Conversational insights** — ask questions in plain English or by voice. The app translates natural language to SQL, queries CockroachDB, and renders charts. Repeated queries are served from a vector-similarity cache — no LLM call needed.
- **Spending recommendations** — a rolling 3-month baseline per discretionary category projects end-of-month spend. Overspending cards show which merchants are driving it and what to do before month end. This is entirely self-referential (your own history against itself) — it does not benchmark against RBI or any external data.
- **Multi-dimensional analytics** — spend by merchant, payment method, subcategory, and debit vs credit trend across selectable date ranges.
- **Macro economic context** — RBI, World Bank, and MoSPI indicators (repo rate, inflation, food inflation, GDP growth, GDP per capita) combined with your own balance into a personalised purchasing-power erosion narrative, an investment scenario slider, and a growing memory of your balance trend.
- **Two-account comparison** — category spend deltas, shared/unique categories, and a confidence-scored memory of which of two accounts has consistently run higher in a category over time.
- **Voice advisor** — OpenAI Realtime API enables spoken queries with personalised, data-driven responses and built-in guardrails, across Insights, Macro, Compare, and Recommendations.

---

## Macro

The Macro page (`/macro`) puts the user's own balance in the context of the wider economy:

- **Indicators** — RBI Repo Rate, Inflation (CPI), Food Inflation, GDP Growth, and GDP per Capita, sourced from the World Bank API plus manually-curated RBI/MoSPI seed data (MoSPI preferred over World Bank for inflation/GDP growth where available, since it publishes more recent figures).
- **Erosion synthesis** — a server-composed "what this means for you" narrative combining the live inflation rate with the user's actual balance (e.g. real purchasing-power loss per year), plus a GDP-vs-erosion comparison sentence and any relevant confirmed memory facts.
- **Investment scenario slider** — an interactive what-if: adjust a hypothetical amount and assumed annual return to see the net benefit against inflation. Purely a client-side calculation on already-fetched numbers — not recorded as a fact about the user, since it's a hypothetical, not an observation.
- **Memory panel** — confirmed/tentative balance-trend facts, built up by the agentic memory layer across repeated visits.
- **Two charts** — a nominal-vs-real (inflation-adjusted) balance trend, and a separate purchasing-power-gap chart isolating just the erosion amount on its own scale (a combined chart would let a structural change, like adding a new account, dominate the axis and hide the actual erosion).
- **Voice narration** via the shared realtime voice hook.

## Compare

The Compare page (`/compare`) puts two of the user's bank accounts side by side — currently hard-capped at exactly two accounts, both in the UI and structurally in the underlying `semantic_facts` schema (not N-way):

- **Category spend deltas** between the two accounts.
- **Shared vs. unique spending categories.**
- **Memory panel** — a confidence-scored, growing record of which account has consistently run higher in a shared category across repeated comparisons over time.
- **Color-coded columns** — one color per account, fixed by selection order.
- **Voice narration** via the shared realtime voice hook.

---

## Architecture

![Oikos Recall Architecture](https://github.com/sl2902/oikos_recall/blob/main/assets/oikos_recall_architecture_diagram.png)

**Tech stack:**
- Frontend: Next.js 15 App Router, TypeScript, Tailwind CSS, shadcn/ui — deployed on Vercel
- Ingestion: Python 3.12 Lambda, invoked directly by the Next.js upload API route after storing the file in S3
- Database: CockroachDB Cloud (Basic tier, Mumbai / ap-south-1) — native Distributed Vector Indexing (VECTOR columns) and PostGIS-compatible spatial types, no separate pgvector/PostGIS extension install required (see ADR 014)
- AI: OpenAI GPT-4o-mini (NL→SQL, recommendations), text-embedding-3-small (semantic cache), Realtime API (voice)
- Auth: NextAuth v5, Google OAuth

---

## Data model

![Oikos Recall Data Model](https://github.com/sl2902/oikos_recall/blob/main/assets/oikos_recall_er.png)

---

## The Memory Lifecycle

The agentic memory layer is built around a three-stage design:

1. **Ingestion** — episodic events such as insight cards, macro explanations, and comparison runs are captured as immutable records in CockroachDB.
2. **Distillation** — a hybrid trigger keeps memory useful without unbounded growth: cheap running metrics (occurrence ratios, means, threshold-confirmation) are updated inline at write time, while a scheduled Lambda job handles heavier trend extraction, percentile calculations, and decay.
3. **Synthesis** — the agent queries the semantic table, which returns distilled context weighted by relevance and recency, so infrequently-relevant facts fade without being deleted outright.

---

## For judges

The app is live at **https://oikos-recall.vercel.app**.

### Guest access
Click **Try as Guest** on the login page. No Google account required. The guest account is pre-seeded with 3 months of realistic HDFC Bank transactions (April–June 2026) covering food, groceries, pharmacy, utilities, shopping, and dividend income.

### Testing the upload
1. Sign in as guest (or with your own Google account)
2. Download a sample statement: [`demo_hdfc_statement.csv`](https://raw.githubusercontent.com/sl2902/oikos_recall/refs/heads/main/ingestion/tests/fixtures/demo/demo_hdfc_statement_full.csv?token=GHSAT0AAAAAAD5KQNSGVRDX6Q62VFBXDE5K2TREBFQ)
3. Download a sample Axis bank statement: [`demo_axis_statement.csv`](https://raw.githubusercontent.com/sl2902/oikos_recall/refs/heads/main/ingestion/tests/fixtures/demo/demo_axis_statement_full.csv?token=GHSAT0AAAAAAD5KQNSG5FPIXE7LTWLEY7BK2TRECDA)
4. On the Transactions page, click **Upload Statement** in the top right corner
5. Select HDFC Bank and upload the CSV
6. Wait ~30–60 seconds for Lambda to process

### Resetting guest data
If you want to start fresh as a guest:
1. Go to Transactions page
2. Click the upload history icon (🕐) next to the bank account
3. Delete the existing upload
4. Re-upload the demo CSV

### Exploring features
- **Transactions** — filter by month, category, payment method, merchant search, custom date range
- **Insights** — type or speak a question (e.g. *"Plot my food expenses for the last 3 months"*)
- **Recommendations** — spending vs 3-month baseline with projected overspend
- **Analytics** — merchant breakdown, payment method trends, subcategory drilldown, debit vs credit
- **Macro** — economic indicators, a personalised erosion narrative, an investment scenario slider, and a balance-trend memory panel (voice-enabled)
- **Compare** — pick two of your accounts to see category spend deltas, shared/unique categories, and a growing memory of which account runs higher where (voice-enabled)

> Note: Demo statements have been uploaded until September 15 to ensure app show live current-month data during the judging period.

---

## Hackathon Requirements

| Requirement | What was used |
|---|---|
| CockroachDB tool #1 | Managed MCP Server (agent memory read/write) |
| CockroachDB tool #2 | Distributed Vector Indexing (semantic recall over past insights) |
| AWS service | Lambda, Python 3.12 (scheduled batch distillation job) |

**Note on vector similarity:** this isn't one mechanism — it's three, doing different jobs, and they shouldn't be collapsed into a single claim:

- **`query_cache`'s Tier 2 similarity cache** (`getSimilarCacheHits`, and the voice-specific direct-serve path in `getVoiceSimilarCacheHit`) genuinely computes cosine similarity server-side inside CockroachDB via the `<=>` operator (`1 - (query_embedding <=> ...)`), with the database doing the ranking natively. This answers "is this whole question basically the same as one already answered" — text mode surfaces a match above 0.85 as a clickable suggestion; voice serves a match above a stricter [0.92](https://www.spheron.network/blog/semantic-cache-llm-inference-gpu-cloud/) directly, with no suggestion step, since voice has no menu UX to confirm through.
- **Insights' fact-grounding** (`getRelevantFactDescriptions`, which decides which confirmed memory facts ground a response) computes cosine similarity in **application code** against a cached candidate set, not via CockroachDB's `<=>` operator. This is a deliberate, safe design choice, not a regression: the confirmed-fact set for a user+account is cacheable (it only changes when distillation writes), but which facts match a specific question never is — caching the embeddings once per cache miss and scoring them in JavaScript on every question avoids sending a bulk-embedding query to the Managed MCP Server on every single question, which is exactly the shape that caused the response-size failure below.
- **Macro and Compare** pass their confirmed facts directly to the LLM with no similarity search step at all — their candidate sets are structurally tiny by construction (Macro: one allow-listed fact type, one user, capped at 5 rows; Compare: scoped to exactly the two accounts being compared), so a ranking step over them wouldn't change what gets returned.

This wasn't the original design for the fact-grounding case: an earlier version fetched every confirmed fact's raw embedding vector via MCP in one bulk query and scored it in JavaScript, which hit the Managed MCP Server's response-size cap once a user had more than one confirmed fact (see `docs/challenges.md` #17). The fix at the time moved scoring into CockroachDB via `<=>` to avoid ever returning a raw embedding column. Since then, candidate-set caching was reintroduced with a safer shape (each confirmed fact's embedding fetched via its own single-row MCP call, cached, and paid for only on a cache miss rather than per question) — which is what put scoring back into application code specifically for this path. `query_cache`'s Tier 2 was never affected by any of this and has computed similarity in CockroachDB via `<=>` throughout — it's the one part of the original claim that's fully accurate as stated.

**Note on MCP Server access control:** CockroachDB's Managed MCP Server scopes access at the whole-cluster Cloud RBAC level (the Cluster Operator role, in this project's case) for autonomous API-key connections — there is no platform-level mechanism to restrict a given connection to read-only, or to specific tables or operations. The read/write separation between this project's interactive path (read-only in practice) and its distillation path (read/write) is enforced in application code, not by the platform: the interactive path simply never issues write-shaped MCP tool calls (`insert_rows`, `create_table`, `create_database`). This is a deliberate, understood design choice given what the platform actually offers today, not an oversight.

---

## Developer setup

### Prerequisites
- Node.js 20+
- Python 3.11+
- `uv` (Python package manager)
- AWS CLI configured for `ap-south-1`
- PostgreSQL client (psql)

### Clone and install

```bash
git clone https://github.com/<your-repo>/oikos_recall.git
cd oikos_recall

# Frontend
cd app
npm install

# Ingestion pipeline
cd ../ingestion
uv sync
```

### Environment variables

#### Frontend (`app/.env.local`)
```env
# Database — CockroachDB Cloud (Postgres-wire-compatible; see ADR 014)
DATABASE_URL=cockroachdb://user:password@your-cluster.cockroachlabs.cloud:26257/oikos?sslmode=verify-full
DATABASE_URL_DIRECT=cockroachdb://user:password@your-cluster.cockroachlabs.cloud:26257/oikos?sslmode=verify-full
DATABASE_URL_READONLY=cockroachdb://readonly_user:password@your-cluster.cockroachlabs.cloud:26257/oikos?sslmode=verify-full

# CockroachDB Managed MCP Server (agentic memory reads/writes)
COCKROACHDB_MCP_API_KEY=your-mcp-api-key
COCKROACHDB_MCP_CLUSTER_ID=your-cluster-uuid

# Auth
NEXTAUTH_URL=http://localhost:3000
AUTH_SECRET=your-secret-here
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# OpenAI
OPENAI_API_KEY=sk-proj-...
OPENAI_REALTIME_API_KEY=sk-proj-...
# OPENAI_BASE_URL=              # set to use a proxy; omit to call api.openai.com directly

# AWS
AWS_REGION=ap-south-1
AWS_S3_BUCKET=your-s3-bucket
AWS_LAMBDA_FUNCTION_NAME=oikos-recall-ingestion

# Feature flags
NEXT_PUBLIC_VOICE_ENABLED=true
```

Note: guest login (`demo@oikosrecall.app`) needs no special environment variable — it resolves its user id via a normal DB lookup by email, same as any other user. See step 2 of AWS setup below for creating the demo user row.

#### Ingestion (`ingestion/.env`)
```env
DATABASE_URL=cockroachdb://user:password@your-cluster.cockroachlabs.cloud:26257/oikos?sslmode=require
AWS_S3_BUCKET=your-s3-bucket
AWS_LAMBDA_FUNCTION_NAME=oikos-recall-ingestion
OPENAI_API_KEY=sk-proj-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

### AWS setup

#### 1. CockroachDB Cloud cluster

Create a cluster (Basic tier is sufficient — it autoscales on demand, no manual min/max capacity knob or cold-start pause behaviour to work around, unlike Aurora Serverless v2). Distributed Vector Indexing (VECTOR columns) and PostGIS-compatible spatial types are native to the engine — no extension install step is needed (see ADR 014). See `docs/deployment.md` for the full current environment/variable reference.

#### 2. Run database migrations

```bash
cd app
npx drizzle-kit push
```

Then create the demo guest user (no manual UUID wiring needed — guest login resolves `demo@oikosrecall.app` via a normal DB lookup by email, same path every other user goes through):

```sql
INSERT INTO users (email, first_name, last_name, country_code, currency)
VALUES ('demo@oikosrecall.app', 'Demo', 'User', 'IN', 'INR');

INSERT INTO bank_accounts (user_id, bank_name, account_type, currency)
VALUES ((SELECT id FROM users WHERE email = 'demo@oikosrecall.app'), 'HDFC Bank', 'savings', 'INR');
```

#### 3. S3 bucket
```bash
aws s3 mb s3://your-bucket-name --region ap-south-1
aws s3api put-bucket-cors --bucket your-bucket-name --cors-configuration file://infra/s3-cors.json
```

#### 4. Lambda deployment

First time only — creates the Lambda execution role:
```bash
chmod +x scripts/setup_lambda_role.sh
./scripts/setup_lambda_role.sh
```

Then, from the repo root (see `docs/deployment.md` for what this script does step by step):
```bash
chmod +x scripts/deploy_lambda.sh
./scripts/deploy_lambda.sh
```

Set these environment variables on the Lambda function:
```
DATABASE_URL
OPENAI_API_KEY
OPENAI_BASE_URL=https://api.openai.com/v1
AWS_S3_BUCKET
```

#### 5. Google OAuth
1. Go to https://console.cloud.google.com → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add authorised redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://your-vercel-domain.vercel.app/api/auth/callback/google`

### Running locally

```bash
cd app
npm run dev
```

The app runs at `http://localhost:3000`. Ingestion runs in Lambda — uploads trigger the Lambda function via S3, so you need the full AWS stack even for local development.

### Deploying to Vercel

```bash
cd app
vercel --prod
```

Set all environment variables from `app/.env.local` in Vercel dashboard → Settings → Environment Variables. Note that Vercel does not support variable interpolation — always paste actual values, never `$VARIABLE_NAME` references.

---

## Known limitations

See [`docs/challenges.md`](./docs/challenges.md) for a full list of known issues, workarounds, and planned fixes.

---

## License

MIT