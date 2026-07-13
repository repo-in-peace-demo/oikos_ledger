# Oikos Ledger — Technical Challenges and Known Limitations

## 1. Bank Narration Normalisation

Indian bank narrations are among the most varied text formats in financial technology. Unlike Western banking systems where merchant names are standardised at the point-of-sale terminal, Indian bank narrations encode payment method, merchant identity, gateway provider, VPA, IFSC codes, and reference numbers into a single concatenated string with no consistent delimiter or schema.

### Same merchant, different formats

```
UPI-SWIGGY-SWIGGY@HDFCBANK-HDFC0000001-612535829269-UPI SEND MONEY
K4UXS7UOARZ2DOWVCI/PAYUSWIGGYIN
60521705841704606721/PAYTMSWIGGYCOM
```

All three are Swiggy food delivery transactions requiring completely different parsing strategies.

### Specific challenges

**No standard delimiter** — gateways concatenate prefix + merchant + suffix with no separator: `PAYTMSWIGGYCOM` = `PAYTM` + `SWIGGY` + `COM`. Indistinguishable without a merchant whitelist.

**Domain suffixes as word endings** — `COM` in `BESCOM` (Bangalore Electricity Supply Company) vs `COM` as domain suffix in `SWIGGYCOM`. Hardcoded BESCOM exception required.

**Numeric prefixes in UPI strings** — merchant IDs embedded before name: `15779 APOLLO PHARMAC`. Stripped via regex but may incorrectly strip legitimate numeric merchant names.

**Truncated merchant names** — HDFC truncates: `APOLLO PHARMAC` instead of `APOLLO PHARMACY`. Conservative LLM prompt prevents expansion but leaves truncated names in the registry.

**Category inconsistency across banks** — same merchant category labelled differently by different parsers (e.g. "Health" vs "Medical"). Requires parser-level normalisation to a canonical category set — planned for Iteration 6.

**LLM inconsistency** — same narration can produce different category assignments across calls. Mitigated by `temperature=0` and merchant registry caching; stale registry entries can persist incorrect values.

### Mitigation strategy

Two-stage normalisation: deterministic rules handle ~70% of transactions, LLM handles the rest. Merchant registry caches correct normalisations. User amendments correct mistakes and feed back into the registry. The amendment UI exists precisely because normalisation is imperfect.

---

## 2. Agentic NL→SQL — Year Hallucination

When users specify a month without a year (e.g. "March"), `gpt-4o-mini` defaults to 2023 instead of the current year. This causes queries to return zero results for months that have data in 2026.

**Fix:** Today's date and current year injected into `AGENT_SYSTEM_PROMPT` at request time. Agent instructed to always use the current year unless a different year is explicitly stated.

**Residual risk:** Cached query results from before this fix have stale `chart_type` or date filters baked in. Cache entries are invalidated after 24 hours; clearing `query_cache` manually resolves immediately.

---

## 3. Voice Interface — Multiple Failure Modes

The real-time voice interface introduced several unexpected failure
modes during live testing.

### Dead Silence and Broken Endings

When a user finished speaking, the microphone stream would
occasionally hang open in silence instead of closing cleanly.
If the local audio buffer was configured too small, chunks of
live audio were dropped entirely, resulting in sudden cut-offs
and broken responses. Getting the buffer size and stream teardown
sequence right required significant iteration.

**Fix:** ScriptProcessor buffer raised from 512 to 4096 samples.
Audio drain implemented on interrupt. `CLOSE_WHEN_DONE` shutdown
protocol added to ensure the stream closes cleanly after the
final audio chunk is played.

### Barge-In and Voice Overlap

Handling interruptions was messy. If the user spoke over the AI
while it was delivering a response, the model continued generating
audio instead of switching to listen mode. This caused both voices
to overlap simultaneously because the event loop could not purge
the old playback buffers fast enough before new audio arrived.

**Current approach:**
- `interrupt_response: true` in `turn_detection` — server
  auto-cancels on VAD start
- `conversation.item.truncate` sent with `audio_end_ms` = samples
  actually played
- GainNode mute (gain = 0) on `speech_started` — silences buffered
  chunks immediately
- `mutedItemId` ref — skips delta scheduling for the truncated
  item's in-flight chunks
- `response.created` restores gain for the new response

**Residual overlap:** Small audio window between mute and the last
in-flight chunk being scheduled can still result in brief
bleed-through. Acceptable for hackathon demo; production fix would
require more granular AudioBufferSourceNode cancellation.

### Handshake Failures and SQL Hallucinations

Mid-build schema updates to the OpenAI Realtime API session
configuration broke the WebSocket handshake entirely, requiring
a full session teardown and reconnect flow to be rebuilt.
Separately, the model occasionally hallucinated raw database
values or generated broken SQL strings directly into the voice
channel before strict validation filters and system prompt
guardrails were put in place.

### Duplicate Turn Bubbles

Out-of-order audio delta events caused the same assistant turn
to render as two separate bubbles in the chat UI. Fixed by
keying turns on a stable `item_id` rather than insertion order,
and guarding `addTurn` with a `hasData || hasSql` check to
suppress empty bubbles from events that fired before content
arrived.

---

## 4. Voice Interface — Chart Type Communication

The Realtime model (`gpt-realtime-2`) has no visibility into the Next.js UI. It cannot know whether the `InsightsChart` component rendered a line chart or a table. When users say "show me a chart instead of a table", the model retries the same query with rephrased instructions, believing it controls the rendering.

**Fix:** `chart_type` added as a structured parameter to the `run_sql` tool schema in `runAgentLoop`. The agent specifies the chart type as part of the tool call; the UI renders accordingly. The Realtime model is told in its system prompt that chart rendering is handled by the app automatically.

**Residual issue:** Multi-series queries (time + dimension + value, e.g. daily spending by merchant) cannot be rendered as a chart — they require pivoting to wide format which is not yet implemented. These fall back to table. Agent system prompt explains this to the model.

---

## 5. Aurora Connection During Development

Aurora Serverless v2 with minimum ACU=0 pauses after 5 minutes of inactivity. Cold start adds 5–30 seconds to the first request after a pause.

**Fix before demo:** Set minimum ACU to 0.5:
```bash
aws rds modify-db-cluster --db-cluster-identifier oikos-ledger \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=4
```

---

## 6. Aurora SSL Certificate

`rejectUnauthorized: false` used in Next.js and Lambda connections due to CA cert path resolution issues across execution contexts (local dev vs Vercel build vs Lambda container).

**Production fix:** Bundle `global-bundle.pem` in the Lambda Docker image and configure an absolute path. For Next.js on Vercel, embed the cert in the repo and reference via `path.join(process.cwd(), 'certs/global-bundle.pem')` with `NODE_EXTRA_CA_CERTS` fallback.

---

## 7. HDFC CSV Comma in Narration

HDFC exports narrations without quoting even when they contain commas. Standard `csv.DictReader` splits on every comma, causing a column shift for affected rows.

**Fix:** `HDFCParser` overrides `parse_csv()` to detect column overflow and rejoin split narration fields. Assumes the last 5 columns are always: Value Date · Debit · Credit · Ref · Balance.

---

## 8. No RDS Proxy

Lambda and Next.js connect directly to Aurora without connection pooling. At hackathon scale this is acceptable. Under production load, Aurora's connection limit (~90 at 0.5 ACU) could be exhausted.

**Production fix:** Add RDS Proxy (~$0.015/vCPU-hour). See ADR 002.

---

## 9. Merchant Registry Stale Entries

If an early LLM call returns an incorrect category, that value is cached and served on all subsequent uploads until manually cleared or overwritten.

**Partial mitigation:** Deterministic categorisation always overrides LLM category when it returns a non-Other result. User amendments that correct `normalized_merchant` update the registry.

---

## 10. Parser Coverage and Limitations

Parsers were implemented for HDFC, ICICI, Axis, and SBI. HDFC, Axis, and SBI were tested against real bank statement data. HDFC has the most comprehensive coverage across multiple months. Axis and SBI were tested against a limited number of months, so edge cases in their narration formats may not yet be fully handled. ICICI was not tested against real statement data — column formats were assumed from public documentation and may differ from actual exports.

**Required before production support:** Additional real statement samples for Axis and SBI to cover more narration patterns, and end-to-end testing for ICICI with fixture files analogous to `tests/test_parser.py` for HDFC.

---

## 11. OpenAI Proxy Token Limits

The dataexpert.io proxy (`OPENAI_BASE_URL`) has monthly token limits. When exhausted, the API returns a 401 with `"Monthly token limit exceeded"`.

**Workaround:** Comment out `OPENAI_BASE_URL` in `.env.local`. Client falls back to `api.openai.com` using `OPENAI_REALTIME_API_KEY` (standard `sk-proj-` key).

---

## 12. Query Cache Stale Chart Types

Cache entries written before the `chart_type` agent parameter was implemented store `chart_type: "table"` for all custom queries. These are served from cache with the wrong chart type until they expire (24h TTL) or until the cache is cleared.

**Fix:** `DELETE FROM query_cache WHERE user_id = '...' AND account_id = '...'` to force fresh queries.

---

## 13. AWS Bedrock Normalizer Abandoned Mid-Build

The ingestion pipeline was originally designed to use AWS Bedrock
with Claude Haiku as the LLM normalizer, keeping all inference
within the AWS ecosystem alongside Lambda and Aurora.

In practice, accessing Anthropic models on Bedrock requires a
first-time model access approval that is not instant. While waiting,
cross-region inference profiles were attempted along with various
model parameter combinations — none worked reliably within the
hackathon timeline.

The pipeline was reverted to OpenAI for normalization.
`BedrockNormalizerClient` in `ingestion/pipeline/bedrock_normalizer.py`
exists and is selectable via `NORMALIZER_PROVIDER=bedrock` in config,
but was never used in production.

**Lesson:** Request Bedrock model access before starting a build that
depends on it. Approval can take 24–48 hours.

---

## 14. Aurora Default Creation Flow Blocked Password Setup

Aurora Serverless v2 has a specific provisioning sequence when
enabling both IAM authentication and password-based access.
The default cluster creation flow in the AWS console silently
skipped the master password configuration step when IAM
authentication was selected first.

The result was a cluster that was reachable and showed as
`Available` but rejected all password-based connection attempts
with an authentication error — indistinguishable from a
network or security group misconfiguration at first glance.

**Fix:** Create the cluster with password authentication enabled
first, verify connectivity, then enable IAM authentication as a
separate step. Do not rely on the default console wizard when
both authentication modes are required.

---

## 15. CockroachDB Managed MCP Server — Intermittent Multi-Second Latency

Occasional multi-second latency spikes were observed against the CockroachDB Managed MCP Server, affecting roughly 1 in 8 connection sessions in testing. The root cause was not conclusively isolated from client-side measurement alone.

Two mechanisms were proposed and tested directly: query-plan caching (cost paid once per distinct SQL shape) and connection-layer warm-up (cost paid once per connection, any shape). A controlled test — running a candidate-fact query, then a structurally different query against a different table, then repeating the original query, all on one persistent warm connection, across 8 fresh-connection trials — ruled out both in their clean form. The effect was session-wide and binary: either all three calls in a trial were slow (~2.9–3.2s) or all three were fast (~0.7–0.9s), never a "slow first call, fast afterward" pattern that would implicate query shape or one-time connection cost specifically. This points to intermittent, whole-session latency variance (shared infrastructure contention, routing, or something else not visible from outside the service) rather than either proposed mechanism — but this remains unconfirmed, not just unconfirmed-and-assumed.

**Mitigation:** A background prefetch fires on page load (Macro page and Insights panel) that exercises the MCP connection ahead of the user's first real question — originally this also warmed a reusable fact-similarity cache, but that cache was removed by the response-size-limit fix (see #17 below); the prefetch's remaining value is the connection warm-up itself. This reduces the odds of a slow session landing on that first question by moving the cost earlier — it does not guarantee elimination, since a slow session could still occur later in the same session regardless of whether the prefetch already ran.

---

## 16. HDFC Value Date vs. Posting Date Crossing a Month Boundary

Bank statement exports may include transactions whose value date falls in a different month than the statement period they're delivered in. Observed case: an HDFC interest credit with a June value date posted into the July statement file.

This is not currently handled — treated as a bank-specific export quirk rather than a pipeline bug, since the transaction is correctly parsed and recorded, just under the statement period it was actually delivered in rather than the period its value date implies.

---

## 17. CockroachDB Managed MCP Server — Response-Size Limit (separate from the request-size cap)

Beyond the request query-text cap already noted in #15's investigation (the `select_query` tool caps query text at 16384 characters), the Managed MCP Server separately rejects *responses* above a certain payload size, failing with `MCP error: max result size exceeded`. This surfaced in the fact-similarity candidate-fetch query (`SELECT description, embedding FROM semantic_facts ...`), which returned every confirmed fact's raw 1536-dimension `embedding` column.

Determined empirically, not assumed: a temporary diagnostic script re-ran the exact candidate query against the live MCP connection with `LIMIT 1, 2, 3, ... 50`. `LIMIT 1` succeeded (a single embedding-bearing row, ~19,269-character response). `LIMIT 2` through `LIMIT 50` all failed identically. There is no safe row count above 1 for a query that returns a raw embedding column — this ruled out simply picking a smaller limit; the row shape itself had to change.

**Fix:** Cosine similarity is now computed inside CockroachDB via the `<=>` operator (`1 - (embedding <=> '[...]'::vector) AS similarity`), returning only `id`, `description`, and the computed `similarity` score — never the raw vector. Verified live at ~1.7KB for a full candidate set (10 rows), orders of magnitude under the cap. This also required rounding the query's own embedding to 4 decimal places before inlining it into the query text (~11,800 characters with that rounding vs. ~29,000 at full precision), to stay under the separate request-text cap.

**Trade-off:** this removed a caching optimization. The candidate-fact fetch used to be cached (keyed by a distillation-freshness marker) and reused across a user's questions within a session, so most turns paid nothing beyond embedding generation. Since the query embedding is now baked into the query itself rather than fetched once and reused, every fact-similarity check does a live MCP round trip. Judged the better trade against the alternative (fetching each confirmed fact's embedding via its own single-row MCP call, run in parallel) — that alternative was also tested live and works, but already took 6.7s wall-clock for just 10 facts (close to the request timeout budget) and gets riskier, not safer, as a user's confirmed-fact count grows.

---

## 18. trend:balance_snapshot — Structural vs. Genuine Balance Changes

A balance snapshot's percentage-change narration ("balance increased 12%...") is only meaningful when the same set of accounts contributed to the combined balance across consecutive snapshots. Adding or removing an account from the comparison changes the combined figure for a structural reason, not because spending or income changed — narrating that as a balance trend would be misleading (e.g. a second account added mid-session could read as "balance jumped 85%").

**Fix:** Each `macro_explanation` episodic event now carries the sorted `account_ids` that contributed to that snapshot's `combined_balance`. The distillation job compares consecutive snapshots' account-id sets before computing a percentage change: if the set differs, the trend resets with a distinct description ("Started tracking a new account — balance trend will resume from here...") and `occurrence_count=1`, instead of computing a misleading jump. A snapshot with an unknown account-id set (recorded before this field existed) is treated as unchanged — the same conservative default the code had before this field existed — rather than risk masking a genuine trend off incomplete historical data.
