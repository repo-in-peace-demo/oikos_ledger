import { auth } from "@/auth"
import { db, dbReadonly } from "@/lib/db/client"
import { sql } from "drizzle-orm"
import OpenAI from "openai"
import { logError } from "@/lib/logger"
import { getQueryCacheDataMarkerOrUnknown, isCacheEntryFresh } from "@/lib/queryCacheFreshness"
import { loadFactCandidates } from "@/lib/insights/factCandidates"
import { todayDateString } from "@/lib/today"

export const dynamic = "force-dynamic"

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
})

// Semantic similarity search on semantic_facts — grounds the agent's response with confirmed
// patterns Oikos Recall has learned about this user, in addition to the pre-built query_cache
// similarity search above (a separate table, separate purpose).
//
// This threshold was originally set to 0.85 to match query_cache's Tier-2 convention, but that
// convention doesn't transfer here: query_cache matches question-vs-question (near-paraphrases of
// a previous prompt), while this matches question-vs-declarative-fact ("has my balance been
// changing lately?" vs. "Combined balance has stayed roughly flat around ₹749,764..."). Empirically
// (text-embedding-3-small, checked directly against a live confirmed fact), on-topic question/fact
// pairs score ~0.46-0.52 cosine similarity, while clearly unrelated questions score ~0.20-0.25 — a
// 0.85 threshold made the search fire on nothing. 0.35 sits between the two clusters, with margin
// on both sides. Based on a single fact and a handful of phrasings — revisit once more confirmed
// facts and real queries exist to widen the sample.
const FACT_SIMILARITY_THRESHOLD = 0.35
const FACT_SIMILARITY_LIMIT = 3

// --- Timeout budget sizing policy (applies to every budget below) -------------------------
// Every one of these has previously been sized against "typical" or "one sample seen so far"
// latency and then failed in production against real variance — most recently: a cache-HIT
// request timed out at 1231ms against a 1200ms budget, stuck entirely in embedding generation
// (proving OpenAI's embedding API alone can exceed that budget, with no MCP/CockroachDB
// involvement at all), and the category-lookup query separately timed out against its 300ms
// budget in production. Going forward, each budget below is sized against the worst latency
// actually observed for that specific call shape, with real multiplicative margin over it — not
// "just above the one number seen so far" — and the evidence for each number is stated inline
// rather than left as a bare constant.

// getRelevantFactDescriptions' candidate set is cached again (see factCandidates.ts and the
// "UPDATE" note in getRelevantFactDescriptions' own doc comment) — a cache HIT completes with no
// MCP round trip at all, just embedding generation + an in-memory scoring pass. This single budget
// still has to cover the MISS case, though (a live id+description query plus one single-row
// embedding fetch per candidate, in parallel), which is the same "full embedding + MCP round trip"
// shape the value below was originally sized for. Evidence at the time: MCP round trip alone
// measured at 718-6246ms in the connection-warming investigation, embedding calls up to 2423ms
// directly measured, a request observed timing out at 1231ms on embedding generation alone. 6500ms
// covers embedding's worst case plus a substantial share of the documented MCP worst case, but does
// NOT reach full 2x margin over the combined worst case (~9000ms+) — that would mean a real user
// could wait 9+ seconds before a graceful degrade, judged an unacceptable UX tradeoff even under an
// "err toward reliability" instruction. Flagging this explicitly as a judgment call, same as before.
const FACT_QUERY_TIMEOUT_MS = 6500

// Page-load prefetch (see the `prefetch` branch below) calls this same function purely to warm
// the MCP connection/candidate cache before the user asks a real question — nobody is waiting on
// it directly, so cutting it off at FACT_QUERY_TIMEOUT_MS optimizes for the wrong thing: a live
// request needs to fail fast because a person is staring at a spinner; the prefetch's only job is
// finishing before that person's first real question, and failing fast buys it nothing. Confirmed
// live: an embedding call alone took 3742ms — already past half of FACT_QUERY_TIMEOUT_MS on its
// own — and the whole prefetch timed out at 6502ms with the cache never populated, so the user's
// first real question still hit the same slow, cold path the prefetch exists to prevent. 15000ms
// gives real margin over that observed 3742ms embedding time plus the documented MCP round-trip
// worst case (up to 6246ms) — well past the combined ~9000ms+ worst case this file's own timeout
// comment says a live request can't afford to wait for, which is exactly the budget a background
// warm-up call CAN afford.
const PREFETCH_FACT_QUERY_TIMEOUT_MS = 15000

const BLOCKED_KEYWORDS = [
  "drop", "delete", "update", "insert", "truncate",
  "alter", "create", "grant", "revoke", "exec",
  "execute", "pg_", "information_schema",
]

const INTENTS = {
  monthly_trend: {
    label: "Monthly trend",
    description: "Time-series aggregation across your statement period",
    sql: (userId: string, accountId: string, dateFilter = "") => `
      SELECT
        TO_CHAR(transaction_date, 'YYYY-MM') AS month,
        SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END) AS debits,
        SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END) AS credits,
        SUM(CASE WHEN transaction_type = 'debit' THEN -amount ELSE amount END) AS net
      FROM transactions
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        ${dateFilter}
      GROUP BY TO_CHAR(transaction_date, 'YYYY-MM')
      ORDER BY month ASC
    `,
    chart_type: "line",
  },
  biggest_expenses: {
    label: "Biggest expenses",
    description: "SUM + GROUP BY category with RANK() window function",
    sql: (userId: string, accountId: string, dateFilter = "") => `
      SELECT
        category,
        SUM(amount) AS total,
        COUNT(*) AS transaction_count,
        RANK() OVER (ORDER BY SUM(amount) DESC) AS rank
      FROM transactions
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND transaction_type = 'debit'
        ${dateFilter}
      GROUP BY category
      ORDER BY total DESC
      LIMIT 10
    `,
    chart_type: "bar",
  },
  credits_vs_debits: {
    label: "Credits vs Debits",
    description: "Conditional aggregation by transaction type",
    sql: (userId: string, accountId: string, dateFilter = "") => `
      SELECT
        TO_CHAR(transaction_date, 'YYYY-MM') AS month,
        SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END) AS debits,
        SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END) AS credits
      FROM transactions
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        ${dateFilter}
      GROUP BY TO_CHAR(transaction_date, 'YYYY-MM')
      ORDER BY month ASC
    `,
    chart_type: "comparison_bar",
  },
  top_merchants: {
    label: "Top merchants",
    description: "SUM + GROUP BY merchant with DENSE_RANK() window function",
    sql: (userId: string, accountId: string, dateFilter = "") => `
      SELECT
        normalized_merchant,
        SUM(amount) AS total,
        COUNT(*) AS transaction_count,
        DENSE_RANK() OVER (ORDER BY SUM(amount) DESC) AS rank
      FROM transactions
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND transaction_type = 'debit'
        ${dateFilter}
      GROUP BY normalized_merchant
      ORDER BY total DESC
      LIMIT 10
    `,
    chart_type: "horizontal_bar",
  },
  spending_by_category: {
    label: "Spending by category",
    description: "Category breakdown with pgvector semantic grouping",
    sql: (userId: string, accountId: string, dateFilter = "") => `
      SELECT
        category,
        subcategory,
        SUM(amount) AS total,
        COUNT(*) AS transaction_count,
        ROUND(
          SUM(amount) * 100.0 /
          SUM(SUM(amount)) OVER (),
          2
        ) AS percentage
      FROM transactions
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND transaction_type = 'debit'
        ${dateFilter}
      GROUP BY category, subcategory
      ORDER BY total DESC
    `,
    chart_type: "pie",
  },
}

type HistoryEntry = { role: string; content: string }

function normalizeForCompare(text: string): string {
  return text.toLowerCase().trim().replace(/[?!.,]/g, "").replace(/\s+/g, " ")
}

function dedupeConsecutive(history: HistoryEntry[]): HistoryEntry[] {
  const deduped: HistoryEntry[] = []
  for (const entry of history) {
    const prev = deduped[deduped.length - 1]
    const isRepeat = prev
      && prev.role === entry.role
      && normalizeForCompare(prev.content) === normalizeForCompare(entry.content)
    if (!isRepeat) deduped.push(entry)
  }
  return deduped
}

// The literal final user message is often a fragment on its own ("savings for the last seven
// days" after a clarifying question doesn't mention "balance" at all) — the topic was established
// in an earlier turn. Folds in the preceding user turns so the semantic_facts similarity search
// (below) sees the same conversational context runAgentLoop already gets via conversation_history,
// rather than judging the current turn in isolation. Deliberately user-turns-only (assistant
// clarifying questions/summaries would dilute the embedding without adding topic signal).
function buildContextualQueryText(question: string, history: HistoryEntry[]): string {
  const recentUserTurns = history
    .filter((h) => h.role === "user")
    .slice(-2)
    .map((h) => h.content)
  return [...recentUserTurns, question].join(" ")
}

// The categories table is a small, stable global taxonomy (not per-user data, rarely changes).
// Previously a blocking DB read with its own 300ms timeout, which was directly observed exceeding
// that budget in production ("Category lookup exceeded 300ms budget... degraded to off").
// Raising the timeout again would just repeat the pattern this whole fix is trying to move past —
// the actual mistake was blocking the classifier's hot path on a live DB round trip at all, for
// data that barely ever changes. Fixed instead by never blocking on it: a static snapshot (below)
// serves every request immediately with zero latency and zero DB dependency, while a background,
// fire-and-forget refresh (at most once per warm instance) keeps the live cache current for
// whichever request happens to arrive after it resolves. Worst case if the live table has
// genuinely changed since this snapshot was taken: a newly-added category isn't recognized by the
// bypass until the background refresh completes — the keyword classifier still runs regardless,
// so this only ever affects whether the category-bypass fires, never a hard failure.
//
// Snapshot taken directly from the live categories table, 2026-07 (45 rows) — update this list if
// the category taxonomy changes meaningfully; the background refresh does not persist beyond a
// given warm instance's lifetime.
const STATIC_CATEGORY_NAMES_FALLBACK = [
  "activities", "books", "clothing", "coffee", "courses", "credit card payment",
  "dining out", "doctor", "emi", "education", "electronics", "entertainment", "events",
  "fees", "finance", "flights", "food", "food delivery", "fuel", "groceries", "gym",
  "health", "hobbies", "home", "hotels", "housing", "insurance", "internet", "investment",
  "maintenance", "movies", "other", "parking", "personal care", "pharmacy",
  "public transport", "rent", "ride share", "shopping", "streaming", "subscriptions",
  "transport", "travel", "uncategorized", "utilities",
]

let categoryNamesCache: string[] | null = null
let categoryNamesRefreshStarted = false

async function refreshCategoryNamesCache(): Promise<void> {
  try {
    const result = (await dbReadonly.execute(
      sql.raw(`SELECT name FROM categories`),
    )) as unknown as { rows: { name: string }[] }
    categoryNamesCache = result.rows.map((row) => row.name.toLowerCase())
  } catch (err) {
    logError({
      context: "refreshCategoryNamesCache",
      error: err,
      note: "keeping static fallback list for this instance; will retry on the next cold instance",
    })
  }
}

async function getCategoryNames(): Promise<string[]> {
  if (categoryNamesCache) return categoryNamesCache

  // Fire-and-forget, at most once per warm instance — never awaited, so this can never add
  // latency to the caller no matter how slow (or how it fails) the underlying query is.
  if (!categoryNamesRefreshStarted) {
    categoryNamesRefreshStarted = true
    refreshCategoryNamesCache()
  }

  return STATIC_CATEGORY_NAMES_FALLBACK
}

async function hashQuery(text: string): Promise<string> {
  const normalized = text
    .toLowerCase()
    .trim()
    .replace(/[?!.,]/g, "")
    .replace(/\s+/g, " ")
  const encoder = new TextEncoder()
  const data = encoder.encode(normalized)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)
}

async function generateEmbedding(text: string): Promise<number[]> {
  const client = openai
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
    user: "oikos-ledger",
  })
  return response.data[0].embedding
}

// Confirmed semantic_facts whose embedding is similar to the question, for grounding the agent's
// response — read-only (the candidate fetch behind this, in factCandidates.ts, only ever calls
// select_query), scoped to this user and either user-level facts (account_id IS NULL) or facts
// for this specific account, so a fact from a different account never leaks into this account's
// context.
//
// Similarity is computed in application code (cosineSimilarity, further below) against a cached
// candidate set — see the "UPDATE" note further down for the current design. The paragraphs
// immediately below explain why a PRIOR version moved scoring into SQL instead — that history is
// kept because the response-size constraint it describes still applies and still shapes the
// current design, even though scoring itself has since moved back out of SQL. That prior version
// was itself a deliberate reversal of an even earlier version of this function, which fetched
// every confirmed fact's raw `embedding` column via MCP (LIMIT 50) and scored candidates in JS.
// That design hit a DIFFERENT MCP cap than the one below: "max result size exceeded" (a response *payload* size
// limit) — confirmed empirically (temporary diagnostic script, same read-only approach as prior
// investigations, deleted after use) by re-running the exact candidate query against the live MCP
// connection with LIMIT 1, 2, 3, ... 50. LIMIT 1 succeeded (~19,269-char response — a single
// 1536-float embedding column is already most of that). LIMIT 2 through 50 *all* failed with the
// same error. There is no usable LIMIT above 1 for a query that returns a raw embedding column —
// this isn't a "pick a smaller number" problem, the row shape itself has to change.
//
// The fix: never return a raw embedding over MCP at all. `1 - (embedding <=> '[...]'::vector) AS
// similarity` computes the score inside CockroachDB, so the response only ever carries
// description+similarity per row — empirically confirmed at ~1.7KB for this user's full confirmed-
// fact set (10 rows) with this exact query shape, orders of magnitude under the cap. This also
// solves the *other*, separately-diagnosed MCP limit (request query-TEXT capped at 16384
// characters, see the git history for the investigation that found a full-precision 1536-dim
// literal is ~29,000 characters on its own) — the query embedding is rounded to 4 decimal places
// before being inlined (empirically measured at ~11,800 characters as a full query with that
// rounding, ~28% margin below the 16384 cap; also confirmed live). Rounding only the *query's own*
// embedding (never the stored ones) to 4 decimals introduces per-component error on the order of
// 0.00005 — negligible next to the gap between "no match" (~0.20-0.25) and "match" (~0.46-0.52)
// scores documented below; it does not shift which facts clear FACT_SIMILARITY_THRESHOLD.
//
// UPDATE: candidate-set caching restored, scoped correctly this time. The paragraph above
// describes why per-question SQL-side scoring replaced the original cached-raw-embeddings design
// (a response-size crash fetching many raw embeddings in one bulk query). That fix conflated two
// different things: "what facts exist to search over" (the confirmed set — same for any question,
// until the underlying data changes, genuinely cacheable) and "which of them match this specific
// question" (depends on the question's own embedding, never cacheable). Only the second one
// actually needs a live call every time.
//
// app/lib/insights/factCandidates.ts now caches the first (marker-based, same pattern as
// loadAccountMemory/loadComparisonSnapshots/loadMacroFacts) — id/description/embedding for this
// user+account's confirmed facts. On a cache HIT this function does zero MCP calls; similarity
// against both the isolated and contextual embeddings is computed in application code
// (cosineSimilarity below) against the cached candidates. On a MISS, the candidate set is
// rebuilt via one safe id+description query plus one single-row embedding fetch per candidate in
// parallel — see that file's own header comment for why a bulk embedding fetch still isn't safe
// and why paying the parallel-single-row cost only on a cache miss (not per question) changes the
// trade-off from before. The per-question work is now just: generate embeddings, load candidates
// (cached), score in JS — no MCP round trip on a hit.
//
// Takes both the isolated current-turn question and the contextual query text (see
// buildContextualQueryText) — not a precomputed embedding, since the query_cache Tier-2 embedding
// is of the literal current-turn question only and is deliberately not reused here.
//
// Scoring uses MIN(isolated similarity, contextual similarity), not just the contextual score —
// this fixes a confirmed false positive: folding the prior turn "how has my balance been lately"
// into an unrelated follow-up like "plot my food expenses for last month" pushed the *contextual*
// score to ~0.43 (clears 0.35), even though the follow-up alone scores 0.24 (correctly below
// threshold) and shares no actual topic with the balance fact — the prior turn's topic bled into
// the combined embedding, manufacturing a match the current question doesn't support on its own.
// Requiring the isolated score to *also* clear the threshold blocks that: a real continuation like
// "savings for the last seven days" already scores 0.42 alone (above threshold on its own, and higher
// still combined with context), so it isn't affected by this — the two cases are well separated by
// this check, confirmed empirically, not assumed. Deliberately reuses the existing
// FACT_SIMILARITY_THRESHOLD for both scores rather than introducing a second tunable number.
//
// Both embeddings are generated concurrently (Promise.all), not sequentially, to avoid roughly
// doubling this step's wall-clock latency now that there's a second OpenAI call — and skipped
// entirely when there's no prior history (isolated text === contextual text), so a first-turn
// question still only ever pays for one embedding call, exactly as before this fix.
//
// Hard-timeout + degrade, same pattern as /api/macro's "MCP memory lookup failed, degrading to
// indicators-only": if this doesn't complete within budget, or either call fails outright, proceed
// with no facts — never a hard failure, and never adds unbounded latency to a pipeline shared with
// the (latency-sensitive) voice advisor. Timeout and hard-error are logged distinctly (with
// elapsed time, and — for a hard error — which of the two calls threw and the actual error) so a
// stuck MCP connection doesn't read the same as an OpenAI auth failure.
// Same top-K used previously to bound the SQL-side ORDER BY similarity DESC LIMIT — preserved as
// the same intersection width now that ranking happens in JS (see the "top CANDIDATE_FETCH_LIMIT"
// intersection logic in getRelevantFactDescriptions below; this constant's role is unchanged, only
// where the ranking is computed changed).
const CANDIDATE_FETCH_LIMIT = 20

// Standard cosine similarity, computed in application code against the cached candidate set (see
// app/lib/insights/factCandidates.ts) instead of via pgvector's `<=>` operator in SQL — this is
// the one piece of "which facts match this question" that can never be cached (it depends on the
// question's own embedding), so it has to happen somewhere; doing it here in JS is what lets the
// candidate set itself be cached without ever sending a per-question bulk-embedding query to MCP.
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function getRelevantFactDescriptions(
  userId: string,
  accountId: string,
  isolatedQuestionText: string,
  contextualQueryText: string,
  timeoutMs: number = FACT_QUERY_TIMEOUT_MS,
): Promise<string[]> {
  const startedAt = Date.now()

  let step: "embedding" | "load_candidates" = "embedding"
  // Populated as each step finishes, so the split is known even if the *other* step is the one
  // that eventually times out or throws — e.g. a timeout stuck in "load_candidates" still reports
  // how long the embedding call took before it got there.
  let embeddingMs: number | null = null
  let candidatesMs: number | null = null

  const work = (async () => {
    const embeddingStartedAt = Date.now()
    const hasContext = isolatedQuestionText !== contextualQueryText
    const [contextualEmbedding, isolatedEmbedding] = await Promise.all([
      generateEmbedding(contextualQueryText),
      // No prior history means the two texts are identical — skip the redundant second call
      // rather than pay for (and wait on) an embedding of text already being embedded above.
      hasContext ? generateEmbedding(isolatedQuestionText) : Promise.resolve(null),
    ])
    embeddingMs = Date.now() - embeddingStartedAt

    step = "load_candidates"
    const candidatesStartedAt = Date.now()
    // Cached (see factCandidates.ts) — a HIT costs one direct-SQL marker check and no MCP call at
    // all; only a MISS pays for the real fetch. Either way this is a single load, not one per
    // embedding — the two embeddings are scored against the same candidate set in JS below.
    const candidates = await loadFactCandidates(userId, accountId)
    candidatesMs = Date.now() - candidatesStartedAt

    if (candidates.length === 0) return []

    const contextualRows = candidates
      .map((c) => ({ id: c.id, description: c.description, similarity: cosineSimilarity(c.embedding, contextualEmbedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATE_FETCH_LIMIT)

    // similarity is MIN(contextual, isolated) — see this function's doc comment for why. When
    // there's no history, isolatedEmbedding is null and contextualRows IS the isolated ranking
    // (identical query text), so every candidate's score is already correct as-is.
    if (isolatedEmbedding === null) {
      return contextualRows.map((r) => ({ description: r.description, similarity: r.similarity }))
    }

    const isolatedRows = candidates
      .map((c) => ({ id: c.id, similarity: cosineSimilarity(c.embedding, isolatedEmbedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATE_FETCH_LIMIT)

    // Only facts that independently rank in *both* embeddings' top CANDIDATE_FETCH_LIMIT qualify
    // for a MIN score — a fact absent from one side's top-K is itself informative (it doesn't
    // genuinely share that embedding's topic), consistent with the original intent of requiring
    // both signals to agree rather than blending them into one number.
    const isolatedById = new Map(isolatedRows.map((r) => [r.id, r.similarity]))
    const scored: { description: string; similarity: number }[] = []
    for (const c of contextualRows) {
      const isolatedSimilarity = isolatedById.get(c.id)
      if (isolatedSimilarity === undefined) continue
      scored.push({ description: c.description, similarity: Math.min(c.similarity, isolatedSimilarity) })
    }
    return scored
  })()

  // Logs whether a match cleared FACT_SIMILARITY_THRESHOLD, and its score — or that nothing did.
  //
  // Deliberately called from the outer scope, after Promise.race settles, NOT from inside `work`
  // itself. An earlier version logged from inside `work`, unconditionally, as soon as scoring
  // finished — which fires regardless of whether `work` won the race below. If `work` resolves
  // slightly after `timedOut` already became true, that earlier version would log a genuine
  // "MATCH" for a result that was simultaneously being discarded by the `if (timedOut) return []`
  // branch — producing exactly the confirmed bug: server logs showing a real match, while the
  // metadata sent to the client (built from the discarded `[]`) carried used_memory: false. Calling
  // this only on the branch that actually reaches the caller keeps the log truthful to what the
  // response actually contained.
  function logSimilarityOutcome(
    scoredAll: { description: string; similarity: number }[],
    outcome: "used" | "arrived after timeout — NOT used, response already sent",
  ) {
    const bestMatch = scoredAll.length > 0
      ? scoredAll.reduce((best, c) => (c.similarity > best.similarity ? c : best))
      : null
    if (bestMatch && bestMatch.similarity > FACT_SIMILARITY_THRESHOLD) {
      console.log(
        `Semantic facts similarity search: MATCH (${outcome}) — best score `
        + `${bestMatch.similarity.toFixed(4)} cleared threshold ${FACT_SIMILARITY_THRESHOLD} `
        + `(${scoredAll.length} candidate(s) checked). Top match: "${bestMatch.description.slice(0, 100)}"`,
      )
    } else if (bestMatch) {
      console.log(
        `Semantic facts similarity search: NO MATCH (${outcome}) — best score `
        + `${bestMatch.similarity.toFixed(4)} did not clear threshold ${FACT_SIMILARITY_THRESHOLD} `
        + `(${scoredAll.length} candidate(s) checked).`,
      )
    } else {
      console.log(
        `Semantic facts similarity search: NO MATCH (${outcome}) — no confirmed candidate facts `
        + `found for this user/account.`,
      )
    }
  }

  let timedOut = false
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      timedOut = true
      resolve("timeout")
    }, timeoutMs)
  })

  // If the timeout branch wins the race below, `work` is still running — this still logs its
  // eventual outcome (clearly marked as arrived-too-late-to-use) once it settles, for diagnosing
  // exactly this kind of near-miss, but never affects what's already been returned to the caller.
  work.then(
    (scoredAll) => {
      if (timedOut) logSimilarityOutcome(scoredAll, "arrived after timeout — NOT used, response already sent")
    },
    () => {},
  )

  try {
    const result = await Promise.race([work, timeout])
    if (timedOut) {
      console.error(
        `Semantic facts similarity search TIMED OUT after ${Date.now() - startedAt}ms `
        + `(budget ${timeoutMs}ms) — still in "${step}" when the budget ran out. `
        + `embedding: ${embeddingMs ?? "did not finish"}ms, `
        + `load_candidates: ${candidatesMs ?? "did not finish"}ms `
        + `— degrading to no memory context`,
      )
      return []
    }
    const scoredAll = result as { description: string; similarity: number }[]
    logSimilarityOutcome(scoredAll, "used")
    console.log(
      `Semantic facts similarity search completed in ${Date.now() - startedAt}ms `
      + `(embedding: ${embeddingMs}ms, load_candidates: ${candidatesMs}ms, budget ${timeoutMs}ms)`,
    )
    return scoredAll
      .filter((c) => c.similarity > FACT_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, FACT_SIMILARITY_LIMIT)
      .map((row) => row.description)
  } catch (err) {
    logError({
      context: `getRelevantFactDescriptions.${step}`,
      error: err,
      userId,
      accountId,
      isolatedQuestionText,
      contextualQueryText,
      elapsedMs: Date.now() - startedAt,
      embeddingMs,
      candidatesMs,
      note: "degrading to no memory context",
    })
    return []
  }
}

async function getExactCacheHit(
  userId: string,
  accountId: string,
  queryHash: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = (await dbReadonly.execute(sql.raw(`
      SELECT result
      FROM query_cache
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND query_hash = '${queryHash}'
        AND expires_at > NOW()
      LIMIT 1
    `))) as unknown as { rows: Record<string, unknown>[] }

    if (result.rows.length === 0) {
      return null
    }

    const cached = result.rows[0].result as Record<string, unknown>
    // TTL alone doesn't catch data changes within the 24h window — a transaction deleted or
    // added, or a semantic fact newly confirmed/changed, after this entry was written would
    // otherwise keep being served verbatim. Compares against the marker stored at write time
    // (see writeCacheEntry); a mismatch (including an older entry that predates this fix and has
    // no stored marker at all) means stale — fall through to a fresh computation rather than
    // serve it.
    const currentMarker = await getQueryCacheDataMarkerOrUnknown(userId, accountId)
    if (!isCacheEntryFresh(cached._data_marker, currentMarker)) {
      return null
    }
    return cached
  } catch (err) {
    logError({ context: "getExactCacheHit", error: err, userId, accountId, queryHash })
    return null
  }
}

async function getSimilarCacheHits(
  userId: string,
  accountId: string,
  embedding: number[],
  queryHash: string,
): Promise<{ query_text: string; query_hash: string }[]> {
  try {
    const result = (await dbReadonly.execute(sql.raw(`
      SELECT query_text, query_hash,
        1 - (query_embedding <=> '[${embedding.join(",")}]'::vector)
          AS similarity
      FROM query_cache
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND query_hash != '${queryHash}'
        AND expires_at > NOW()
        AND 1 - (query_embedding <=> '[${embedding.join(",")}]'::vector) > 0.85
      ORDER BY query_embedding <=> '[${embedding.join(",")}]'::vector
      LIMIT 3
    `))) as unknown as { rows: Record<string, unknown>[] }

    return result.rows.map(r => ({
      query_text: r.query_text as string,
      query_hash: r.query_hash as string,
    }))
  } catch (err) {
    logError({ context: "getSimilarCacheHits", error: err, userId, accountId, queryHash })
    return []
  }
}

// Voice's own version of Tier 2. The text-mode Tier 2 above (getSimilarCacheHits) only ever
// offers a clickable "did you mean one of these?" menu — that confirmation-step UX doesn't exist
// in a voice call, which is why Tier 2 was gated `!is_voice` entirely rather than caching helping
// voice at all. Serving a match directly, with no human confirmation step, is a stronger claim
// than offering it as a suggestion, so this uses a stricter threshold than the 0.85 above:
// production semantic-caching guidance generally starts in the 0.90-0.95 range for exactly this
// direct-serve case. Single best match only (LIMIT 1) — there's nothing to do with a second-best
// candidate when there's no menu to show it in. Applies the same freshness-marker check Tier 1
// (getExactCacheHit) already does before serving — a similar-but-stale entry shouldn't be served
// any more than an exact-but-stale one should.
const VOICE_TIER2_SIMILARITY_THRESHOLD = 0.92

async function getVoiceSimilarCacheHit(
  userId: string,
  accountId: string,
  embedding: number[],
  queryHash: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = (await dbReadonly.execute(sql.raw(`
      SELECT result,
        1 - (query_embedding <=> '[${embedding.join(",")}]'::vector)
          AS similarity
      FROM query_cache
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND query_hash != '${queryHash}'
        AND expires_at > NOW()
        AND 1 - (query_embedding <=> '[${embedding.join(",")}]'::vector) > ${VOICE_TIER2_SIMILARITY_THRESHOLD}
      ORDER BY query_embedding <=> '[${embedding.join(",")}]'::vector
      LIMIT 1
    `))) as unknown as { rows: Record<string, unknown>[] }

    if (result.rows.length === 0) {
      return null
    }

    const cached = result.rows[0].result as Record<string, unknown>
    const currentMarker = await getQueryCacheDataMarkerOrUnknown(userId, accountId)
    if (!isCacheEntryFresh(cached._data_marker, currentMarker)) {
      return null
    }
    return cached
  } catch (err) {
    logError({ context: "getVoiceSimilarCacheHit", error: err, userId, accountId, queryHash })
    return null
  }
}

async function getCacheByHash(
  userId: string,
  accountId: string,
  queryHash: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = (await dbReadonly.execute(sql.raw(`
      SELECT result
      FROM query_cache
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND query_hash = '${queryHash}'
        AND expires_at > NOW()
      LIMIT 1
    `))) as unknown as { rows: Record<string, unknown>[] }

    if (result.rows.length > 0) {
      return result.rows[0].result as Record<string, unknown>
    }
    return null
  } catch (err) {
    logError({ context: "getCacheByHash", error: err, userId, accountId, queryHash })
    return null
  }
}

async function writeCacheEntry(
  userId: string,
  accountId: string,
  queryHash: string,
  queryText: string,
  embedding: number[],
  responseData: Record<string, unknown>,
): Promise<void> {
  try {
    // "unknown" (timeout/failure) is stored as null, not a placeholder string — null can never
    // equal a real marker value on a later read, so an entry written under an unverifiable
    // baseline is permanently treated as stale rather than accidentally trusted later.
    const dataMarker = await getQueryCacheDataMarkerOrUnknown(userId, accountId)
    const payload = {
      ...responseData,
      _data_marker: dataMarker === "unknown" ? null : dataMarker,
    }
    await db.execute(sql.raw(`
      INSERT INTO query_cache (
        user_id, account_id, query_hash, query_text,
        query_embedding, result, expires_at
      )
      VALUES (
        '${userId}',
        '${accountId}',
        '${queryHash}',
        '${queryText.replace(/'/g, "''")}',
        '[${embedding.join(",")}]'::vector,
        '${JSON.stringify(payload).replace(/'/g, "''")}',
        NOW() + INTERVAL '24 hours'
      )
      ON CONFLICT (user_id, account_id, query_hash)
      DO UPDATE SET
        result = EXCLUDED.result,
        query_embedding = EXCLUDED.query_embedding,
        expires_at = NOW() + INTERVAL '24 hours'
    `))
  } catch (err) {
    logError({ context: "writeCacheEntry", error: err, userId, accountId, queryHash, queryText })
  }
}

function validateSQL(query: string): { valid: boolean; reason?: string } {
  const lower = query.toLowerCase()
  for (const keyword of BLOCKED_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { valid: false, reason: `Query contains blocked keyword: ${keyword}` }
    }
  }
  if (!lower.trim().startsWith("select")) {
    return { valid: false, reason: "Only SELECT queries are allowed" }
  }
  return { valid: true }
}

const AGENT_SYSTEM_PROMPT = (
  userId: string,
  accountId: string,
  currency: string,
  dateContext: string,
  relevantFacts: string[],
) => {
  const today = new Date().toISOString().split("T")[0]
  const currentYear = today.slice(0, 4)
  // Computed from the parsed Y/M components directly, not via Date mutation (setMonth on a
  // Date built from `today` is timezone-dependent and can land on the wrong side of a month
  // boundary) — used only to give the "last month" rule below a concrete, correct label to anchor
  // its worked example to, generalizing across any request date including year boundaries
  // (Date.UTC rolls a negative month index back into the prior year correctly).
  const [todayYear, todayMonthNum] = today.split("-").map(Number)
  const lastMonthLabel = new Date(Date.UTC(todayYear, todayMonthNum - 2, 1))
    .toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  // Grounding context only — never a forced reference. If nothing cleared the similarity
  // threshold (the common case until distillation has produced confirmed facts), this is empty
  // and the prompt reads exactly as it did before this context existed.
  const memoryContext = relevantFacts.length > 0
    ? `\nPatterns Oikos Recall has confirmed about this user — reference naturally if relevant to the question, don't force it in. When you do reference one, phrase it as a pattern you've noticed over time (e.g. "I've noticed that...", "Based on what I've seen before...") rather than stating it as a flat fact just read from today's data:\n${relevantFacts.map((f) => `- ${f}`).join("\n")}\n`
    : ""
  return `You are a personal finance assistant for an app called Oikos Ledger. You have access to the user's transaction data via the run_sql tool.

Today's date is ${today}. The current year is ${currentYear}.
When the user refers to a month by name only (e.g. "March",
"last month"), ALWAYS use ${currentYear} unless a different
year is explicitly stated by the user.

${dateContext ? `Active date filter: ${dateContext}` : ""}
${memoryContext}
Database table: transactions
Columns:
  - transaction_date (date)
  - normalized_merchant (text)
  - raw_description (text)
  - amount (numeric) — always positive
  - transaction_type (text) — 'debit' or 'credit'
  - category (text)
  - subcategory (text, nullable)
  - closing_balance (numeric, nullable)
  - currency (text)

SQL Rules (always enforced):
  - Only SELECT queries
  - Always include:
    WHERE user_id = '${userId}' AND account_id = '${accountId}'
  - Never use DROP, DELETE, UPDATE, INSERT, TRUNCATE, ALTER
  - Add LIMIT 100 unless aggregating
  - Use TO_CHAR(transaction_date, 'YYYY-MM') for month grouping
  - "Last N months" means from the start of the month N months ago,
    not N×30 days ago. Always use:
    DATE_TRUNC('month', CURRENT_DATE) - INTERVAL 'N months'
    NOT CURRENT_DATE - INTERVAL 'N months'
  - NEVER pass a string literal to DATE_TRUNC. Always use CURRENT_DATE
    or a column reference, never a quoted date string.
  - CORRECT: DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months'
  - WRONG: DATE_TRUNC('month', '2026-06-01') - INTERVAL '3 months'
  - ALWAYS add an upper bound of AND transaction_date <= CURRENT_DATE
    to prevent fetching future-dated transactions
  - Example: "last 3 months" →
    transaction_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months'
    AND transaction_date <= CURRENT_DATE
  - "Last month" (singular, no number) is NOT the same pattern as "last N
    months" above. It means the ONE complete calendar month immediately
    before the current one — a closed, already-ended month, never a rolling
    window up to today. It needs an EXCLUSIVE upper bound at the start of
    the current month, not "<= CURRENT_DATE" (that pattern is only for
    "last N months", which deliberately includes the current partial month):
    transaction_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
    AND transaction_date < DATE_TRUNC('month', CURRENT_DATE)
  - CORRECT — "last month" as of today (${today}):
    transaction_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
    AND transaction_date < DATE_TRUNC('month', CURRENT_DATE)
    This resolves to all of ${lastMonthLabel}, and only ${lastMonthLabel} —
    never any part of the current month, and never any other month.
  - WRONG: any interval offset other than exactly '1 month' for "last
    month" (e.g. '- INTERVAL 4 months' or '5 months') — "last month" is
    always exactly one month back, with no other number involved anywhere
    in the query.
  - WRONG: transaction_date <= CURRENT_DATE as the upper bound for "last
    month" — that silently pulls in the current month's transactions too,
    which "last month" (an already-ended, complete month) must never
    include.
  - "Last N days" is an inclusive range that includes today — today counts as
    one of the N days. The correct lower bound is
    CURRENT_DATE - INTERVAL '(N-1) days', NOT CURRENT_DATE - INTERVAL 'N days'
    (that spans N+1 calendar dates, an off-by-one).
  - CORRECT — "last 7 days" as of today (${today}):
    transaction_date >= CURRENT_DATE - INTERVAL '6 days'
    AND transaction_date <= CURRENT_DATE
    This spans exactly 7 calendar dates: ${today} and the 6 days before it.
  - WRONG — transaction_date >= CURRENT_DATE - INTERVAL '7 days' as the lower
    bound for "last 7 days": this spans 8 calendar dates, one too many.
  - The same (N-1) adjustment applies to any "last N days" phrasing —
    e.g. "last 30 days" → lower bound CURRENT_DATE - INTERVAL '29 days'.
  - DO NOT include 'currency' in SELECT unless explicitly asked
  - Use ILIKE '%value%' for merchant/category text matching
  - Do NOT expand category words into sub-arrays
  - If joining unaggregated columns with aggregates, include
    all unaggregated columns in GROUP BY
  - CRITICAL: Always alias time columns as EXACTLY 'day', 'week',
  or 'month' with no exceptions:
  TO_CHAR(transaction_date, 'YYYY-MM-DD') AS day
  TO_CHAR(transaction_date, 'YYYY-WW') AS week  
  TO_CHAR(transaction_date, 'YYYY-MM') AS month
  Never use 'transaction_day', 'transaction_date', 'order_date'
  or any other alias for time columns.
- Always alias value columns as exactly 'total' or 'amount':
  SUM(amount) AS total
  Never use 'total_amount', 'sum_amount', or other variants.
- "payment method" refers to how a transaction was made (UPI,
  NEFT, IMPS, cash etc.) — this is NOT a column in the database.
  If the user asks about payment method, explain that this
  information is not available in the transaction data, and
  offer to break down by merchant or category instead.
- Questions about "balance" (e.g. "what's my balance", "has my
  balance been changing", "is my balance stable") are NOT the
  same as questions about spending or cash flow. Balance
  questions must query the closing_balance column directly —
  it is the actual bank-verified running balance, already
  computed by the ingestion pipeline. NEVER approximate a
  balance by summing credits and debits from zero
  (e.g. SUM(CASE WHEN transaction_type = 'credit' THEN amount
  ELSE -amount END)) — that is net cash flow over the query
  window, not the real balance, and will not match the bank's
  actual figures.
  Example — "has my balance been changing lately?":
    SELECT TO_CHAR(transaction_date, 'YYYY-MM-DD') AS day, closing_balance
    FROM transactions
    WHERE user_id = '${userId}' AND account_id = '${accountId}'
      AND closing_balance IS NOT NULL
    ORDER BY transaction_date ASC
  Example — "what's my current balance?": same query, ORDER BY
  transaction_date DESC LIMIT 1, chart_type "none".
- The following questions should always be answered with run_sql:
  "credits vs debits", "credits versus debits", "income vs expenses" → 
  query debits and credits grouped by month

Behaviour:
  - Use run_sql when the user asks about their financial data
  - If the question is a follow-up, use conversation history
    to carry forward all relevant filters (merchant, category,
    date range) unless the user explicitly changes them —
    this INCLUDES which column the prior turn queried, not
    just filters. If the previous turn was about "balance" and
    queried closing_balance, a follow-up that only adds or
    changes a date range (e.g. "last month", "and the month
    before that") is STILL about balance — the new query must
    also select closing_balance, never fall back to summing
    debits/credits just because the follow-up itself doesn't
    repeat the word "balance".
    Example: prior turn "has my balance been changing lately?"
    used closing_balance. User now says "last month" alone →
    SELECT TO_CHAR(transaction_date, 'YYYY-MM-DD') AS day, closing_balance
    FROM transactions
    WHERE user_id = '${userId}' AND account_id = '${accountId}'
      AND transaction_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
      AND transaction_date < DATE_TRUNC('month', CURRENT_DATE)
      AND closing_balance IS NOT NULL
    ORDER BY transaction_date ASC
    — NOT a debit/credit/net query.
  - NEVER use the word "balance" to describe a debit/credit/net
    total. Net cash flow (credits minus debits) for a period is
    NOT the same thing as an account balance, which only ever
    comes from the closing_balance column. If the results don't
    include closing_balance, do not use the word "balance"
    anywhere in the response — describe it as spending, income,
    or net cash flow instead.
  - NEVER describe a chart, a data trend, or a specific number
    without first calling run_sql for THIS question. Even if a
    similar-sounding chart or figure was mentioned earlier in
    the conversation, you do not have its exact values in memory
    — re-query rather than describe from memory or assumption.
  - If the question is ambiguous and context doesn't resolve
    it, respond directly with a short clarifying question
    (do NOT call run_sql)
  - If the question is clearly unrelated to personal finance,
    respond directly: "I can only answer questions about your transactions and spending."
  - Keep all direct responses to 1-2 sentences
  - Always use ${currency} for currency amounts
  - Lead with the answer, never repeat the question back`
}

// Deterministic, code-level safety net — not a substitute for the prompt-level fixes above and
// the routing exclusion that keeps balance questions off the pre-built intent path entirely, but
// those are still model behavior, which was exactly what failed live before this was added. A
// response describing "balance" must be backed by an actual closing_balance value from the
// executed query — never inferred, described, or narrated from debit/credit/net totals. If the
// SQL never selected closing_balance but the model's own summary uses balance language anyway,
// the summary is replaced with an explicitly-labeled net-cash-flow framing instead of being sent
// as-is, and the mismatch is logged so a future occurrence is immediately diagnosable rather than
// silently corrected with no trace.
const BALANCE_WORD_REGEX = /\bbalances?\b/i
const CLOSING_BALANCE_COLUMN_REGEX = /closing_balance/i

function enforceBalanceLanguageGuard(
  summaryText: string,
  sqlText: string,
  context: { userId: string; accountId: string; question: string; source: string },
): string {
  if (!BALANCE_WORD_REGEX.test(summaryText) || CLOSING_BALANCE_COLUMN_REGEX.test(sqlText)) {
    return summaryText
  }
  logError({
    context: "balanceLanguageGuard.violation",
    error: new Error(
      "Response used 'balance' language but the executed SQL never selected closing_balance — "
      + "likely narrating a debit/credit/net total as if it were an account balance",
    ),
    ...context,
    sql: sqlText,
    summaryText,
  })
  return "This reflects your net cash flow (credits minus debits) for the period, not your actual account balance — ask specifically about your balance to see the real closing_balance figure."
}

type AgentResult =
  | { type: "sql_result"; sql: string; rows: Record<string, unknown>[]; summary: string; chartType: string }
  | { type: "direct_response"; response: string }

async function runAgentLoop(
  question: string,
  userId: string,
  accountId: string,
  history: HistoryEntry[],
  dateContext: string,
  currency: string,
  relevantFacts: string[],
): Promise<AgentResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: AGENT_SYSTEM_PROMPT(userId, accountId, currency, dateContext, relevantFacts),
    },
    ...history.map(h => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    })),
    { role: "user", content: question },
  ]

  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "run_sql",
        description: "Execute a SELECT query against the user's transactions",
        parameters: {
          type: "object" as const,
          properties: {
            sql: {
              type: "string",
              description: "The PostgreSQL SELECT query to execute",
            },
            chart_type: {
              type: "string",
              enum: ["line", "bar", "horizontal_bar", "comparison_bar", "pie", "table", "none"],
              description: `Pick the best visualization for the query result:
              - line: ALWAYS use when query groups by day/week/month over time — any time series, trends, "by month", "by day", "by week", "over time", "last N months"
              - bar: category or merchant ranked by total amount (vertical bars) — use when comparing named groups, NOT time periods
              - horizontal_bar: top merchants ranked by spend (horizontal) — use when there are many items or long labels
              - comparison_bar: exactly two numeric values per time period (debits AND credits by month)
              - pie: category breakdown showing proportions/percentages of a whole
              - table: multi-dimension results, raw transaction lists, or anything with 3+ columns
              - none: single scalar answer (one number, e.g. "total spent in March")

              CRITICAL: If the query has a time column (day/week/month/date), ALWAYS use line, bar, or comparison_bar — never table.`,
            },
          },
          required: ["sql", "chart_type"],
        },
      },
    },
  ]

  // First LLM call — may or may not call the tool
  let firstResponse = ""
  let toolCallId = ""
  let toolCallArgs = ""
  let toolCallName = ""

  const firstStream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    stream: true,
    user: "oikos-ledger",
    messages,
    tools,
    tool_choice: "auto",
  })

  for await (const chunk of firstStream) {
    const delta = chunk.choices[0]?.delta
    if (delta?.content) {
      firstResponse += delta.content
    }
    if (delta?.tool_calls?.[0]) {
      const tc = delta.tool_calls[0]
      if (tc.id) toolCallId = tc.id
      if (tc.function?.name) toolCallName = tc.function.name
      if (tc.function?.arguments) toolCallArgs += tc.function.arguments
    }
  }

  // No tool call — direct response (clarification or off-topic)
  if (!toolCallId || toolCallName !== "run_sql") {
    console.log("Agent direct response:", firstResponse.trim())
    return { type: "direct_response", response: firstResponse.trim() }
  }

  // Parse and validate SQL
  let parsedSQL = ""
  let inferredAgentChart = ""
  try {
    const parsed = JSON.parse(toolCallArgs) as { sql: string; chart_type?: string }
    parsedSQL = parsed.sql?.trim() ?? ""
    inferredAgentChart = parsed.chart_type?.trim().toLowerCase() ?? ""
    console.log("tool args parsed:", JSON.stringify({ parsedSQL: parsedSQL.slice(0, 80), chart_type: inferredAgentChart }))
    console.log("agent SQL:", parsedSQL, "Agent structural chart:", inferredAgentChart)
  } catch (err) {
    // toolCallArgs is the raw, unparsed string the model returned as its tool_call arguments —
    // logging it verbatim is what makes this diagnosable: was it truncated mid-stream, malformed
    // JSON, missing a required field, etc. Without it, this failure mode is invisible server-side
    // even though the user sees a generic "I had trouble generating the query" message.
    logError({
      context: "runAgentLoop.parseToolCall",
      error: err,
      userId,
      accountId,
      question,
      toolCallArgs,
    })
    return {
      type: "direct_response",
      response: "I had trouble generating the query. Could you rephrase?",
    }
  }

  const validation = validateSQL(parsedSQL)
  if (!validation.valid) {
    return {
      type: "direct_response",
      response: "I can only run SELECT queries on your transaction data.",
    }
  }

  if (!parsedSQL.toLowerCase().includes("limit")) {
    parsedSQL = `${parsedSQL.replace(/;+$/, "")} LIMIT 100`
  }

  // Execute SQL
  const results = (await dbReadonly.execute(
    sql.raw(parsedSQL),
  )) as unknown as { rows: Record<string, unknown>[] }
  const rows = results.rows ?? []

  // Second LLM call — synthesize result
  const toolResultMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...messages,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: "function" as const,
          function: { name: "run_sql", arguments: toolCallArgs },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: toolCallId,
      content: JSON.stringify({ rows: rows.slice(0, 20) }),
    },
  ]

  const totalDebits = rows.reduce((sum, r) => sum + Number(r.debits ?? 0), 0)
  const totalCredits = rows.reduce((sum, r) => sum + Number(r.credits ?? 0), 0)
  const inferredChartType = inferredAgentChart || "table"

  const synthesisMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...toolResultMessages,
    {
      role: "user",
      content: `Summarize the results in 1-2 sentences.
The data is being rendered as a "${inferredChartType}" in the UI.
${totalDebits > 0 || totalCredits > 0 ? `Pre-computed totals (net cash flow, NOT a balance) — debits: ${totalDebits.toFixed(2)}, credits: ${totalCredits.toFixed(2)}` : ""}
${!parsedSQL.toLowerCase().includes("closing_balance") ? `This query did NOT select closing_balance — never use the word "balance" anywhere in this response, describe it as spending, income, or net cash flow instead.` : ""}
Lead with the answer. Use ${currency} for amounts.`,
    },
  ]

  let summary = ""
  const synthesisStream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    stream: true,
    user: "oikos-ledger",
    messages: synthesisMessages,
  })

  for await (const chunk of synthesisStream) {
    summary += chunk.choices[0]?.delta?.content ?? ""
  }

  const guardedSummary = enforceBalanceLanguageGuard(summary.trim(), parsedSQL, {
    userId, accountId, question, source: "runAgentLoop",
  })

  return {
    type: "sql_result",
    sql: parsedSQL,
    rows,
    summary: guardedSummary,
    chartType: inferredChartType,
  }
}

export async function POST(request: Request) {
  console.log("POST /api/insights/query called at", new Date().toISOString())
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json()
  const {
    question,
    intent,
    account_id,
    conversation_history,
    last_chart_type,
    last_results,
    date_from,
    date_to,
    is_voice,
    prefetch,
  } = body

  if (!account_id) {
    return Response.json({ error: "account_id required" }, { status: 400 })
  }

  const userId = session.user.id

  // Fire-and-forget MCP connection warm-up, triggered from the Macro page and Insights panel on
  // mount — see their prefetch effects for the full rationale. Short-circuits before any of the
  // heavier logic below (query_cache tiers, agent loop) — this only ever needs to run
  // getRelevantFactDescriptions.
  //
  // Now that getRelevantFactDescriptions' candidate set is cached again (see factCandidates.ts),
  // this call does double duty: it still warms the MCP connection itself (the documented primary
  // benefit below), and — since this literal call populates loadFactCandidates' cache for this
  // user+account as a side effect of running — it also means the user's real first question can
  // land on a candidate-set cache HIT instead of a MISS, provided the underlying data hasn't
  // changed in between. Kept as a real API route (not a separate /api/insights/prefetch endpoint)
  // mainly for consistency with how it was already wired in from the Macro/Insights mount effects.
  //
  // Honest scope: a follow-up latency investigation found the multi-second spikes this warms
  // against are intermittent and connection-session-wide (~1 in 8 sessions in testing), not tied
  // to a specific query shape or a one-time connection warm-up cost — root cause not conclusively
  // isolated between query-plan caching, connection-layer warm-up, and shared infrastructure
  // contention (see the latency investigation for the raw data). This means prefetching reduces
  // the odds of a slow session landing on the user's real first question, by moving that cost
  // earlier — it does NOT guarantee elimination, since a slow session could still occur later in
  // the same session, unrelated to whether this already ran. Treat as a mitigation, not a fix.
  if (prefetch) {
    // Timing is logged explicitly here (not inferred from getRelevantFactDescriptions's own
    // internal logging) because that function's log lines don't know or say *why* they were
    // called — this makes it possible to tell, from server logs alone, whether a prefetch
    // actually finished before a user's first real request needed the cache it was meant to warm,
    // rather than inferring it from the absence of an expected speedup.
    const prefetchStartedAt = Date.now()
    console.log(
      `Prefetch warm-up started for user ${userId}, account ${account_id} at `
      + `${new Date(prefetchStartedAt).toISOString()}`,
    )
    try {
      await getRelevantFactDescriptions(
        userId, account_id, "warm cache", "warm cache", PREFETCH_FACT_QUERY_TIMEOUT_MS,
      )
      console.log(
        `Prefetch warm-up completed in ${Date.now() - prefetchStartedAt}ms for user ${userId}, `
        + `account ${account_id}`,
      )
    } catch (err) {
      // Best-effort only — the caller is fire-and-forget and isn't watching the result, so a
      // failure here should never look like anything to it either way.
      logError({
        context: "POST.prefetch",
        error: err,
        userId,
        accountId: account_id,
        elapsedMs: Date.now() - prefetchStartedAt,
      })
    }
    return Response.json({ ok: true })
  }

  const dedupedHistory = dedupeConsecutive(conversation_history ?? [])

  // date_to defaults to today (the app server's own clock, via todayDateString() — not SQL's
  // CURRENT_DATE, see that function's doc comment for why trusting two independently-evaluated
  // clocks for the same boundary is itself a source of off-by-one exclusions) rather than being
  // left unbounded when absent. The pre-built intents below (and monthly_trend's own
  // granularity-detection query) are plain SQL templates, not LLM-generated — without this
  // default, a pre-built intent run with no explicit date filter would include future-dated
  // seed/demo data (e.g. seeded ahead through Sep 15 to cover an uncertain judging window) as if
  // it had already happened. An explicit date_to from the UI's own date picker still wins — this
  // only fills the gap when nothing was explicitly requested.
  const dateFilter = [
    date_from ? `AND transaction_date >= '${date_from}'` : "",
    date_to ? `AND transaction_date <= '${date_to}'` : `AND transaction_date <= '${todayDateString()}'`,
  ].join(" ")

  const dateContext = date_from || date_to
    ? `\nDate filter active: ${date_from ? `from ${date_from}` : ""} ${date_to ? `to ${date_to}` : ""}. Always apply this filter to all queries.\n`
    : ""

  console.log("date_from:", date_from)
  console.log("date_to:", date_to)
  console.log("dateFilter:", dateFilter)

  // Display command — re-plot without re-querying
  if (question && last_results && last_results.length > 0) {
    const q = question.toLowerCase()
    const hasDisplayPhrase = (
      q.includes("re-plot") || q.includes("replot") ||
      (q.includes("show") && q.includes("as")) ||
      q.includes("switch to") ||
      q.includes("change to") ||
      (q.includes("use") && (q.includes("pie chart") || q.includes("bar chart") || q.includes("line chart")))
    )
    const hasChartKeyword = (
      q.includes("pie") || q.includes("donut") ||
      q.includes("bar") || q.includes("line") || q.includes("table")
    )

    if (hasDisplayPhrase && hasChartKeyword) {
      let newChartType = last_chart_type ?? "table"
      if (q.includes("pie") || q.includes("donut")) newChartType = "pie"
      else if (q.includes("bar") && q.includes("horizontal")) newChartType = "horizontal_bar"
      else if (q.includes("bar")) newChartType = "bar"
      else if (q.includes("line")) newChartType = "line"
      else if (q.includes("table")) newChartType = "table"

      return Response.json({
        type: "complete",
        question,
        intent: "display_command",
        intent_label: "Display update",
        intent_description: "Chart type changed",
        is_custom: false,
        sql: "",
        results: last_results ?? [],
        response: "Here's the data re-plotted as requested.",
        chart_type: newChartType,
        row_count: (last_results ?? []).length,
        cached: false,
      })
    }
  }

  // Natural language → pre-built intent mapping
  // Catches conversational variants that don't go through quick buttons
  const categoryNames = await getCategoryNames()
  const resolvedIntent = intent ?? (() => {
    const q = (question ?? "").toLowerCase()
    if (!q) return null
    // Category-specific questions must always fall through to the custom agent-loop path — no
    // pre-built intent filters to a single named category (spending_by_category groups ALL
    // categories, it doesn't filter to one). This check runs first and wins unconditionally,
    // before any keyword check below gets a chance to fire: a question like "food expenses
    // excluding any credits or refunds" would otherwise match the credits_vs_debits keyword check
    // (plain substring matching has no concept of negation) and lose its category filter entirely.
    if (categoryNames.some((name) => q.includes(name))) return null
    // Balance questions must NEVER be routed to a pre-built intent: none of INTENTS' SQL selects
    // closing_balance (they're all debit/credit/net aggregations over `transactions`), and none
    // of them do any natural-language date parsing — they only ever respect the UI's explicit
    // date_from/date_to params, never a phrase like "last month" in the question text itself.
    // Only the custom agent loop (AGENT_SYSTEM_PROMPT) has both the closing_balance-awareness and
    // the NL date-parsing a balance follow-up needs. Confirmed live: a bare follow-up ("Last
    // month") gets reformulated by the realtime voice model — which is explicitly instructed to
    // fold in prior context before calling query_database — into phrasing that can independently
    // satisfy the monthly_trend keyword check below (e.g. containing both "month" and "trend"),
    // silently losing the balance framing AND the date filter in one misroute. Checked against
    // conversation history too, not just the current question — a bare follow-up may not repeat
    // the word "balance" at all, even after reformulation.
    const recentHistoryText = (conversation_history ?? [])
      .slice(-4)
      .map((h: HistoryEntry) => h.content)
      .join(" ")
      .toLowerCase()
    if (q.includes("balance") || recentHistoryText.includes("balance")) return null
    if (q.includes("credit") && (q.includes("debit") || q.includes("expense")))
      return "credits_vs_debits"
    if ((q.includes("monthly") || q.includes("month")) &&
        (q.includes("trend") || q.includes("over time") || q.includes("chart")))
      return "monthly_trend"
    if (q.includes("biggest") || q.includes("largest") || q.includes("top expense"))
      return "biggest_expenses"
    if (q.includes("top merchant") || q.includes("top merchants") ||
      q.includes("most spent") || q.includes("where did i spend") ||
      ((q.includes("top") || q.includes("most")) && q.includes("merchant")))
      return "top_merchants"
    if (q.includes("spending by category") || q.includes("category breakdown") ||
        q.includes("breakdown by category"))
      return "spending_by_category"
    return null
  })()

  // Two-tier cache lookup
  const cacheText = intent
    ? `intent:${intent}:${date_from ?? ""}:${date_to ?? ""}`
    : question ?? ""

  const queryHash = await hashQuery(cacheText)

  // Tier 1: exact hash match — no embedding needed
  const exactHit = await getExactCacheHit(userId, account_id, queryHash)
  if (exactHit) {
    return Response.json({ ...exactHit, cached: true, type: "complete" })
  }

  // Generate embedding once — used for both Tier 2 and cache write
  const embedding = await generateEmbedding(cacheText)

  // Tier 2: similarity search — voice and text diverge here. Voice has no menu UX to show a
  // "did you mean one of these?" suggestion in, so it gets its own direct-serve version (see
  // getVoiceSimilarCacheHit) instead of running the text-mode query only to discard the result.
  if (is_voice) {
    const voiceSimilarHit = await getVoiceSimilarCacheHit(userId, account_id, embedding, queryHash)
    if (voiceSimilarHit) {
      return Response.json({ ...voiceSimilarHit, cached: true, type: "complete" })
    }
  } else {
    const similarHits = await getSimilarCacheHits(userId, account_id, embedding, queryHash)
    if (similarHits.length > 0) {
      console.log("is_voice:", is_voice, "similar hits:", similarHits.length)
      return Response.json({
        type: "suggestions",
        question: question || intent,
        suggestions: similarHits,
        response: "I found similar questions you've asked before. Would you like to use one of these?",
        cached: false,
      })
    }
  }

  // Pre-built intent fast path — bypasses agent entirely
  const isPrebuilt = resolvedIntent && INTENTS[resolvedIntent as keyof typeof INTENTS]

  if (isPrebuilt) {
    const intentConfig = INTENTS[resolvedIntent as keyof typeof INTENTS]
    let querySQL = intentConfig.sql(userId, account_id, dateFilter)
    const chartType = intentConfig.chart_type
    let intentLabel = intentConfig.label
    let intentDescription = intentConfig.description
    const isCustom = false
    const finalIntent = resolvedIntent

    // Monthly trend: pick daily / weekly / monthly based on data span
    if (finalIntent === "monthly_trend") {
      console.log("Final querySQL:", querySQL)
      console.log("dateFilter:", dateFilter)
      console.log("account_id:", account_id)
      const rangeResult = (await dbReadonly.execute(sql.raw(`
        SELECT
          MIN(transaction_date) AS min_date,
          MAX(transaction_date) AS max_date,
          COUNT(DISTINCT TO_CHAR(transaction_date, 'YYYY-MM')) AS month_count
        FROM transactions
        WHERE user_id = '${userId}'
          AND account_id = '${account_id}'
          ${dateFilter}
      `))) as unknown as { rows: Record<string, unknown>[] }

      const range = rangeResult.rows[0]
      const monthCount = Number(range?.month_count ?? 0)

      if (monthCount >= 12) {
        querySQL = `
          SELECT
            TO_CHAR(transaction_date, 'YYYY-MM') AS month,
            SUM(CASE WHEN transaction_type = 'debit'
              THEN amount ELSE 0 END) AS debits,
            SUM(CASE WHEN transaction_type = 'credit'
              THEN amount ELSE 0 END) AS credits,
            SUM(CASE WHEN transaction_type = 'debit'
              THEN -amount ELSE amount END) AS net
          FROM transactions
          WHERE user_id = '${userId}'
            AND account_id = '${account_id}'
            ${dateFilter}
          GROUP BY TO_CHAR(transaction_date, 'YYYY-MM')
          ORDER BY month ASC
        `
        intentLabel = "Monthly trend"
        intentDescription = "Monthly time-series aggregation"
      } else if (monthCount >= 3) {
        querySQL = `
          SELECT
            TO_CHAR(DATE_TRUNC('week', transaction_date), 'YYYY-MM-DD') AS week,
            SUM(CASE WHEN transaction_type = 'debit'
              THEN amount ELSE 0 END) AS debits,
            SUM(CASE WHEN transaction_type = 'credit'
              THEN amount ELSE 0 END) AS credits,
            SUM(CASE WHEN transaction_type = 'debit'
              THEN -amount ELSE amount END) AS net
          FROM transactions
          WHERE user_id = '${userId}'
            AND account_id = '${account_id}'
            ${dateFilter}
          GROUP BY DATE_TRUNC('week', transaction_date)
          ORDER BY week ASC
        `
        intentLabel = "Weekly trend"
        intentDescription = "Weekly time-series aggregation"
      } else {
        querySQL = `
          SELECT
            TO_CHAR(transaction_date, 'YYYY-MM-DD') AS day,
            SUM(CASE WHEN transaction_type = 'debit'
              THEN amount ELSE 0 END) AS debits,
            SUM(CASE WHEN transaction_type = 'credit'
              THEN amount ELSE 0 END) AS credits,
            SUM(CASE WHEN transaction_type = 'debit'
              THEN -amount ELSE amount END) AS net
          FROM transactions
          WHERE user_id = '${userId}'
            AND account_id = '${account_id}'
            ${dateFilter}
          GROUP BY TO_CHAR(transaction_date, 'YYYY-MM-DD')
          ORDER BY day ASC
        `
        intentLabel = "Daily trend"
        intentDescription = "Daily time-series aggregation"
      }
    }

    try {
      const results = (await dbReadonly.execute(
        sql.raw(querySQL),
      )) as unknown as { rows: Record<string, unknown>[] }
      const rows = results.rows ?? []

      const totalDebits = rows.reduce((sum, r) => sum + Number(r.debits ?? 0), 0)
      const totalCredits = rows.reduce((sum, r) => sum + Number(r.credits ?? 0), 0)

      const currencyResult = (await dbReadonly.execute(sql.raw(`
        SELECT DISTINCT currency FROM transactions
        WHERE user_id = '${userId}' AND account_id = '${account_id}'
        LIMIT 1
      `))) as unknown as { rows: Record<string, unknown>[] }
      const currency = currencyResult.rows[0]?.currency as string ?? "INR"

      const historyContext = (conversation_history ?? []).length > 0
        ? `Previous conversation:\n${(conversation_history ?? [])
            .map((h: HistoryEntry) => `${h.role}: ${h.content}`)
            .join("\n")}\n\n`
        : ""

      let fullResponseText = ""
      const encoder = new TextEncoder()

      const responseStream = new ReadableStream({
        async start(controller) {
          try {
            const metadata = {
              type: "metadata",
              intent: finalIntent,
              intent_label: intentLabel,
              intent_description: intentDescription,
              is_custom: isCustom,
              sql: querySQL.trim(),
              results: rows,
              chart_type: chartType,
              row_count: rows.length,
              cached: false,
              // Pre-built intent fast path never runs the agent loop, so it never checks
              // semantic_facts — always false here, unlike the custom-query path below.
              used_memory: false,
            }
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(metadata)}\n\n`)
            )

            // Neither of these was previously stated to this synthesis call at all — confirmed
            // live as the mechanism behind two separate bugs: (1) with historyContext carrying an
            // earlier turn's "balance" framing and no instruction distinguishing that from a
            // debit/credit total, the model narrated net cash flow as if it were a balance; (2)
            // with no grounding for what chart_type this specific response is actually rendering,
            // the model could describe a different chart than the one produced here (e.g. one
            // mentioned earlier in history). Both are stated explicitly now rather than left
            // implicit.
            const hasClosingBalance = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], "closing_balance")
            const synthesisStream = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              temperature: 0.3,
              stream: true,
              user: "oikos-ledger",
              messages: [
                {
                  role: "system",
                  content: `${historyContext}You are a personal finance assistant.
Rules:
- Maximum 1-2 sentences
- Never repeat the question back
- Lead with the answer directly
- Always use ${currency} currency symbol for amounts
- Use standard number formatting
- Round amounts to nearest hundred unless exact matters
- Never say "the data shows" or "based on the results"
- The data for THIS response is being rendered as a "${chartType}" chart in the UI — describe only
  this chart, never a different chart type or figure mentioned earlier in the conversation above.
- ${hasClosingBalance
    ? `These results include the actual closing_balance column — you may describe this as the account "balance".`
    : `These results do NOT include closing_balance — they are debit/credit/net totals, which is net cash flow for the period, NOT an account balance. Never use the word "balance" anywhere in this response, even if an earlier turn in the conversation above was about balance — describe this as spending, income, or net cash flow instead.`}`,
                },
                {
                  role: "user",
                  content: `Question: ${question || intentLabel}
${totalDebits > 0 || totalCredits > 0
  ? `Pre-computed totals (net cash flow, NOT a balance):
  Total debits: ${totalDebits.toFixed(2)}
  Total credits: ${totalCredits.toFixed(2)}`
  : ""}
Results (sample): ${JSON.stringify(rows.slice(0, 10))}
Summarize these results accurately.`,
                },
              ],
            })

            // Buffered, not streamed chunk-by-chunk to the client — a chunk already sent can't be
            // un-sent, and the balance-language guard below needs the complete text to check
            // against the actual SQL before anything reaches the UI. The added latency (waiting
            // for the full 1-2 sentence summary instead of watching it appear word-by-word) is the
            // deliberate trade for a hard guarantee here, not a hopeful one.
            for await (const chunk of synthesisStream) {
              fullResponseText += chunk.choices[0]?.delta?.content ?? ""
            }

            const guardedResponseText = enforceBalanceLanguageGuard(fullResponseText.trim(), querySQL, {
              userId, accountId: account_id, question: question || intentLabel, source: "prebuiltIntent",
            })

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "text", text: guardedResponseText })}\n\n`)
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()

            const responsePayload = {
              question: question || intentLabel,
              intent: finalIntent,
              intent_label: intentLabel,
              intent_description: intentDescription,
              is_custom: isCustom,
              sql: querySQL.trim(),
              results: rows,
              response: guardedResponseText,
              chart_type: chartType,
              row_count: rows.length,
              cached: false,
              used_memory: false,
            }
            await writeCacheEntry(
              userId, account_id, queryHash,
              cacheText, embedding, responsePayload,
            )
          } catch (err) {
            // Reaches the client via the SSE error event below (setError in InsightsPanel), but
            // that alone isn't durable — nothing survives server-side without this.
            logError({
              context: "POST.prebuiltIntent.streamSynthesis",
              error: err,
              userId,
              accountId: account_id,
              question,
              intent: finalIntent,
              querySQL,
            })
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`
              )
            )
            controller.close()
          }
        },
      })

      return new Response(responseStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      })
    } catch (error) {
      logError({
        context: "POST.prebuiltIntent.execute",
        error,
        userId,
        accountId: account_id,
        question,
        intent: finalIntent,
        querySQL,
      })
      return Response.json(
        { error: "Query execution failed", detail: String(error) },
        { status: 500 },
      )
    }
  }

  // Custom query — run agent loop
  const currencyResult = (await dbReadonly.execute(sql.raw(`
    SELECT DISTINCT currency FROM transactions
    WHERE user_id = '${userId}' AND account_id = '${account_id}'
    LIMIT 1
  `))) as unknown as { rows: Record<string, unknown>[] }
  const currency = currencyResult.rows[0]?.currency as string ?? "INR"

  // Builds contextual query text (recent user turns + current question) rather than reusing the
  // `embedding` already computed above for query_cache — that embedding is of the literal current
  // question only, which loses the topic when the current turn is a bare follow-up (e.g. "savings
  // for the last seven days" after "how has my balance been lately"). Passes the isolated question
  // alongside it so the MIN-score check (see getRelevantFactDescriptions's doc comment) can tell a
  // genuine continuation apart from an unrelated topic change that merely follows it in time.
  // Hard-timeout + degrade internally; never throws, never adds unbounded latency to a pipeline
  // the voice advisor also depends on.
  const isolatedQuestionText = question ?? cacheText
  const relevantFacts = await getRelevantFactDescriptions(
    userId, account_id, isolatedQuestionText,
    buildContextualQueryText(isolatedQuestionText, dedupedHistory),
  )

  let agentResult: AgentResult
  try {
    agentResult = await runAgentLoop(
      question,
      userId,
      account_id,
      dedupedHistory,
      dateContext,
      currency,
      relevantFacts,
    )
  } catch (error) {
    logError({
      context: "POST.runAgentLoop",
      error,
      userId,
      accountId: account_id,
      question,
    })
    return Response.json(
      { error: "Query failed", detail: String(error) },
      { status: 500 },
    )
  }

  // Direct response — clarification or off-topic
  if (agentResult.type === "direct_response") {
    return Response.json({
      type: "complete",
      question,
      intent: "finance_custom",
      intent_label: "Response",
      intent_description: "",
      is_custom: true,
      sql: "",
      results: [],
      response: agentResult.response,
      chart_type: "none",
      row_count: 0,
      cached: false,
      used_memory: relevantFacts.length > 0,
    })
  }

  // SQL result — stream back with metadata
  const { sql: querySQL, rows, summary, chartType } = agentResult
  const intentLabel = "Custom query"
  const intentDescription = "Natural language → SQL"
  const isCustom = true
  const customQueryIntent = "finance_custom"

  const encoder = new TextEncoder()
  let fullResponseText = ""

  const responseStream = new ReadableStream({
    async start(controller) {
      try {
        const metadata = {
          type: "metadata",
          intent: customQueryIntent,
          intent_label: intentLabel,
          intent_description: intentDescription,
          is_custom: isCustom,
          sql: querySQL,
          results: rows,
          chart_type: chartType,
          row_count: rows.length,
          cached: false,
          used_memory: relevantFacts.length > 0,
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(metadata)}\n\n`)
        )

        // Stream the already-computed summary word by word
        const words = summary.split(" ")
        for (const word of words) {
          const text = word + " "
          fullResponseText += text
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "text", text })}\n\n`
            )
          )
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()

        const responsePayload = {
          question,
          intent: customQueryIntent,
          intent_label: intentLabel,
          intent_description: intentDescription,
          is_custom: isCustom,
          sql: querySQL,
          results: rows,
          response: summary,
          chart_type: chartType,
          row_count: rows.length,
          cached: false,
          used_memory: relevantFacts.length > 0,
        }
        await writeCacheEntry(
          userId, account_id, queryHash,
          cacheText, embedding, responsePayload,
        )
      } catch (err) {
        // Reaches the client via the SSE error event below (setError in InsightsPanel), but
        // that alone isn't durable — nothing survives server-side without this.
        logError({
          context: "POST.customQuery.streamSynthesis",
          error: err,
          userId,
          accountId: account_id,
          question,
          querySQL,
        })
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`
          )
        )
        controller.close()
      }
    },
  })

  return new Response(responseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
}
