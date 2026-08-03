// Marker-based cache for Insights' fact-similarity candidate set — the confirmed, non-superseded
// semantic_facts (user-level or scoped to one account) that a question's embedding gets compared
// against. Same pattern already proven for loadAccountMemory/loadComparisonSnapshots/
// loadMacroFacts: a cheap direct-SQL marker check decides HIT (serve cached data, zero MCP calls)
// vs MISS (real fetch, then cache).
//
// IMPORTANT deviation from a naive "SELECT id, description, embedding ... LIMIT N" single query:
// that is exactly the shape already empirically confirmed to fail. See
// app/app/api/insights/query/route.ts's own getRelevantFactDescriptions doc comment and
// docs/challenges.md #17: the CockroachDB Managed MCP Server rejects a *response* above a certain
// payload size, and a query returning a raw 1536-float `embedding` column fails for ANY row count
// above 1 (LIMIT 1 succeeded at ~19KB; LIMIT 2 through 50 all failed identically) — this is a hard
// per-call cap, not something a smaller LIMIT works around. A user with more than one confirmed
// fact would immediately reproduce that crash if this cache's miss path issued one bulk query for
// the whole candidate set.
//
// The fix used here: fetch id+description in one safe query (no embedding column, small), then
// fetch each candidate's embedding via its OWN single-row MCP call (LIMIT 1, confirmed safe),
// run in parallel. This is the "fetch each confirmed fact's embedding via its own single-row MCP
// call" alternative that getRelevantFactDescriptions' own doc comment already tested live and
// documented as working — it was rejected there only because paying that cost on *every question*
// (e.g. 6.7s wall-clock for 10 facts) was too slow for a live request. Paid once per cache MISS
// (i.e. only when the confirmed-fact set actually changes) instead of once per question, that same
// cost is a completely different, acceptable trade — which is the whole point of caching it.
import { sql } from "drizzle-orm"
import { dbReadonly } from "@/lib/db/client"
import { mcpSelectQuery } from "@/lib/mcp/client"
import { logError } from "@/lib/logger"

export type FactCandidate = {
  id: string
  description: string
  embedding: number[]
}

type FactCandidateCacheEntry = { marker: string | null; data: FactCandidate[] }
const factCandidateCache = new Map<string, FactCandidateCacheEntry>()

// Generous but bounded — confirmed facts are relatively rare (promotion requires
// MIN_OCCURRENCES_FOR_TREND separate observations), so this should almost never bind in practice;
// it exists as a safety net against a pathological account with an unusually large confirmed set,
// not as a normal-case limiter. Ordered by relevance_score so a capped set keeps the more relevant
// facts, not an arbitrary cutoff.
const MAX_CANDIDATE_FACTS = 50

function cacheKey(userId: string, accountId: string): string {
  return `${userId}:${accountId}`
}

// MAX(updated_at) across exactly the rows this cache serves (confirmed, not superseded, scoped to
// this user + account-or-user-level) — changes precisely when the candidate set this function
// returns would change: a fact newly confirmed, an existing confirmed fact's embedding/description
// updated, or a confirmed fact superseded. Direct SQL (dbReadonly), not MCP — same established
// exception as every other marker check in this codebase: a marker never returns fact content,
// only a timestamp, so there's nothing here that needs the Managed MCP Server's involvement.
async function getFactCandidatesMarker(userId: string, accountId: string): Promise<string | null> {
  const result = (await dbReadonly.execute(sql.raw(`
    SELECT MAX(updated_at) AS marker
    FROM semantic_facts
    WHERE user_id = '${userId}'
      AND (account_id IS NULL OR account_id = '${accountId}')
      AND confidence_status = 'confirmed'
      AND superseded_by IS NULL
  `))) as unknown as { rows: Record<string, unknown>[] }
  const marker = result.rows[0]?.marker
  return marker ? String(marker) : null
}

// pgvector's `vector` column has no native JSON representation — defensively handles either shape
// mcpSelectQuery might hand back (an already-parsed array, or the raw "[0.1,0.2,...]" string form)
// rather than assuming one, since no other code path in this app has previously selected a raw
// embedding column through this MCP layer to confirm which.
function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number)
  if (typeof raw === "string") {
    return raw.replace(/^\[|\]$/g, "").split(",").map(Number)
  }
  return []
}

export async function loadFactCandidates(userId: string, accountId: string): Promise<FactCandidate[]> {
  const key = cacheKey(userId, accountId)

  let marker: string | null = null
  try {
    marker = await getFactCandidatesMarker(userId, accountId)
  } catch (err) {
    // Marker check failing just means "can't verify freshness" — fall through to a real fetch
    // below rather than risk serving a stale (or wrong) cached candidate set.
    logError({ context: "loadFactCandidates.marker", error: err, userId, accountId })
  }

  const cached = factCandidateCache.get(key)
  if (cached && cached.marker === marker) {
    console.log(JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      context: "loadFactCandidates.cache",
      event: "HIT",
      userId,
      accountId,
      marker,
      candidateCount: cached.data.length,
    }))
    return cached.data
  }

  console.log(JSON.stringify({
    level: "info",
    timestamp: new Date().toISOString(),
    context: "loadFactCandidates.cache",
    event: "MISS",
    reason: !cached ? "no_cached_entry" : "marker_mismatch",
    userId,
    accountId,
    marker,
    cachedMarker: cached?.marker ?? null,
  }))

  // Step 1: id + description only — no embedding column, safe at any row count.
  const step1StartedAt = Date.now()
  const rows = await mcpSelectQuery<{ id: string; description: string }>(`
    SELECT id, description
    FROM semantic_facts
    WHERE user_id = '${userId}'
      AND (account_id IS NULL OR account_id = '${accountId}')
      AND confidence_status = 'confirmed'
      AND superseded_by IS NULL
    ORDER BY relevance_score DESC
    LIMIT ${MAX_CANDIDATE_FACTS}
  `)
  const step1Ms = Date.now() - step1StartedAt

  // Step 2: each candidate's embedding via its own single-row MCP call (LIMIT 1 — the one row
  // count already confirmed safe for a query returning this column), in parallel. See this file's
  // header comment for why this can't be one bulk query instead.
  //
  // Per-call start/end timestamps logged below are deliberate, not incidental: a prior near-
  // universal-timeout incident was hypothesized to be caused by these fetches running sequentially
  // instead of in parallel — confirmed FALSE by direct code read (this was already Promise.all, not
  // a for-loop). But this codebase's own header comment already documents 6.7s wall-clock for 10
  // facts on this exact parallel code, which alone exceeds the live-request timeout budget
  // (FACT_QUERY_TIMEOUT_MS = 6500ms) even without invoking session-wide latency variance. That's
  // only possible if concurrent Promise.all dispatch from this process isn't translating into
  // concurrent processing somewhere downstream (the shared MCP client's single transport/session in
  // app/lib/mcp/client.ts, or session-scoped queuing on the Managed MCP Server itself) — a
  // fundamentally different problem than a sequential loop, and one this file can't fix by changing
  // its own JS orchestration further, since it's already correct. These timestamps make that
  // distinction directly observable in logs next time: call start times clustered together (true
  // concurrency, the bottleneck is elsewhere) vs. call N's start trailing close behind call N-1's
  // end (effective serialization despite Promise.all, pointing at the shared client/transport).
  const step2StartedAt = Date.now()
  const withEmbeddings = await Promise.all(
    rows.map(async (row) => {
      const callStartedAt = Date.now()
      const embeddingRows = await mcpSelectQuery<{ embedding: unknown }>(`
        SELECT embedding FROM semantic_facts WHERE id = '${row.id}' LIMIT 1
      `)
      console.log(JSON.stringify({
        level: "info",
        timestamp: new Date().toISOString(),
        context: "loadFactCandidates.embeddingFetch",
        factId: row.id,
        startedAtMsAfterBatchStart: callStartedAt - step2StartedAt,
        durationMs: Date.now() - callStartedAt,
      }))
      return {
        id: row.id,
        description: row.description,
        embedding: parseEmbedding(embeddingRows[0]?.embedding),
      }
    }),
  )
  const step2Ms = Date.now() - step2StartedAt

  console.log(JSON.stringify({
    level: "info",
    timestamp: new Date().toISOString(),
    context: "loadFactCandidates.miss",
    userId,
    accountId,
    candidateCount: rows.length,
    step1IdDescriptionMs: step1Ms,
    step2AllEmbeddingsMs: step2Ms,
    totalMs: step1Ms + step2Ms,
  }))

  const data = withEmbeddings.filter((c) => c.embedding.length > 0)
  factCandidateCache.set(key, { marker, data })
  return data
}
