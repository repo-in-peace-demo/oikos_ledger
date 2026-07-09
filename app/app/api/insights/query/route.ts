import { auth } from "@/auth"
import { db, dbReadonly } from "@/lib/db/client"
import { sql } from "drizzle-orm"
import OpenAI from "openai"
import { mcpSelectQuery } from "@/lib/mcp/client"

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

// Facts freshness marker check — a direct-SQL (not MCP) read of MAX(updated_at) across this
// user+account's confirmed, non-superseded facts. Cheap indexed aggregate, not the expensive
// operation, so it gets its own short budget. A failure or timeout here is treated as "unknown"
// (never blocks) — it just forces the slower cache-miss path below rather than risking a stale hit.
const FACT_MARKER_TIMEOUT_MS = 300

// Two budgets, not one, because the two outcomes below have very different real cost:
//   - Cache HIT (marker unchanged since last fetch): only the embedding call runs, no MCP at all.
//     Measured 479-887ms for the embedding call alone across 5 live end-to-end runs (one outlier
//     at 2423ms on a cold first call) — 900ms left only ~13ms of margin over the 887ms sample, too
//     tight given that's real observed variance, not a hypothetical; 1200ms leaves real headroom.
//   - Cache MISS (first request for this user+account, or facts changed since): still needs the
//     full embedding + MCP round trip. Measured MCP round trip alone at 718-6246ms (the high end
//     specifically the first select_query call after a connection is opened — a real, recurring
//     cost on a serverless platform where instances cycle) — 3500ms leaves margin over the
//     steady-state end of that range, though the most extreme cold-start case can still exceed it.
// Voice is latency-sensitive (challenges.md); a miss taking multiple seconds is exactly why caching
// this was worth doing — most turns should now land on the fast (1200ms) path, not the slow one.
const FACT_HIT_TIMEOUT_MS = 1200
const FACT_MISS_TIMEOUT_MS = 3500

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

// The categories table is a small, stable global taxonomy (not per-user data, rarely changes) —
// cached indefinitely for the life of a warm instance rather than behind a freshness marker like
// semantic_facts. Names are cached lowercased since every call site only ever compares against a
// lowercased question. A failed lookup degrades to an empty list (no category-aware bypass, not a
// hard failure) — the pre-existing keyword classifier below still runs either way.
let categoryNamesCache: string[] | null = null

async function getCategoryNames(): Promise<string[]> {
  if (categoryNamesCache) return categoryNamesCache
  try {
    const result = (await dbReadonly.execute(
      sql.raw(`SELECT name FROM categories`),
    )) as unknown as { rows: { name: string }[] }
    categoryNamesCache = result.rows.map((row) => row.name.toLowerCase())
    return categoryNamesCache
  } catch (err) {
    console.error(
      "Failed to load category names for intent classification — category-aware "
      + "pre-built-intent bypass degraded to off, keyword classifier still runs:",
      err,
    )
    return []
  }
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

// The MCP select_query tool returns a VECTOR column as its pgvector text form ("[0.1,-0.2,...]"),
// not a JSON array — parse defensively in case a future MCP server version returns it pre-parsed.
function parseVectorColumn(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number)
  if (typeof raw === "string") {
    return raw.replace(/^\[|\]$/g, "").split(",").map(Number)
  }
  throw new Error(`Unexpected embedding column format: ${typeof raw}`)
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

type FactCandidate = { description: string; embedding: number[] }
type FactCacheEntry = { marker: string | null; candidates: FactCandidate[] }

// Caches the candidate-fact fetch (not the final relevantFacts — those depend on each request's
// own question embedding, which always changes) keyed by "userId:accountId". Module-scope, so it
// survives only within one warm serverless instance's lifetime (Vercel/Lambda model) — reset on a
// cold start, and not shared across concurrent instances. This is a fast-path optimization, not a
// persistence layer: correctness never depends on an entry surviving, since a miss always falls
// through to a real MCP fetch below.
const factCandidatesCache = new Map<string, FactCacheEntry>()

function factCacheKey(userId: string, accountId: string): string {
  return `${userId}:${accountId}`
}

// The cheap freshness signal that drives cache invalidation: MAX(updated_at) across this
// user+account's confirmed, non-superseded facts. Whenever distillation writes a new confirmed
// fact (or promotes one from tentative), this value changes, which is exactly the "version" we
// need — no separate marker table required. Superseded rows are excluded so an old row being
// marked superseded_by doesn't matter once it's no longer a candidate anyway.
//
// Deliberately direct SQL (dbReadonly), not MCP — this is the one exception to "reads for this
// feature go through MCP." The facts' actual content still only ever comes back via MCP below;
// this marker never returns description/embedding data, only a timestamp.
async function getFactsFreshnessMarker(userId: string, accountId: string): Promise<string | null> {
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

// Wraps the marker check in its own short timeout. A failure or timeout here is deliberately
// collapsed to a single "unknown" outcome (not distinguished like the embedding/MCP path below) —
// either way the only consequence is forcing the slower-but-always-correct cache-miss path, so
// there's nothing further to act on by telling them apart.
async function getFactsFreshnessMarkerOrUnknown(
  userId: string,
  accountId: string,
): Promise<string | null | "unknown"> {
  const work = getFactsFreshnessMarker(userId, accountId)
  work.catch(() => {})

  let timedOut = false
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      timedOut = true
      resolve("timeout")
    }, FACT_MARKER_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([work, timeout])
    if (timedOut) {
      console.error(
        `Facts freshness marker check exceeded ${FACT_MARKER_TIMEOUT_MS}ms — `
        + `treating as unknown (forces a fresh MCP fetch)`,
      )
      return "unknown"
    }
    return result as string | null
  } catch (err) {
    console.error(
      "Facts freshness marker check failed — treating as unknown (forces a fresh MCP fetch):",
      err,
    )
    return "unknown"
  }
}

// Confirmed semantic_facts whose embedding is similar to the question, for grounding the agent's
// response — read-only (mcpSelectQuery only ever calls select_query), scoped to this user and
// either user-level facts (account_id IS NULL) or facts for this specific account, so a fact from
// a different account never leaks into this account's context.
//
// Similarity is computed in application code (cosineSimilarity), not in SQL via pgvector's <=>
// operator — the MCP select_query tool caps query text at 16384 characters, and a 1536-dimension
// embedding literal is ~29,000 characters on its own; inlining it into the query text (as an
// earlier version of this function did, once in WHERE and once in ORDER BY — ~59,000 characters
// total) failed on every single call with "query exceeds maximum length", not a timeout. The
// candidate query carries no vector at all — only the filtered facts' `embedding` column comes
// back as query *results*, which aren't subject to the same query-text cap. LIMIT 50 bounds the
// candidate set at a level no real user's confirmed-fact count should approach.
//
// The candidate fetch itself is cached (see factCandidatesCache) behind the freshness marker
// above, so MCP is only actually hit on a genuine cache miss — expected to be roughly once per
// distillation run per active user+account, not once per turn. This is why there are two timeout
// budgets below rather than one: a hit only pays for the embedding call, a miss still pays for the
// full embedding + MCP round trip.
//
// Takes contextual query text (see buildContextualQueryText), not a precomputed embedding — the
// query_cache Tier-2 embedding is deliberately not reused here. That embedding is of the literal
// current-turn question only (correct for its own purpose — matching this exact question against
// past exact questions), but a bare follow-up like "savings for the last seven days" carries no
// topical signal on its own when the topic was established in an earlier turn. This does mean a
// second embeddings call rather than reusing one — unavoidable, since the question embedding
// always changes per turn even when the candidate facts don't.
//
// Hard-timeout + degrade, same pattern as /api/macro's "MCP memory lookup failed, degrading to
// indicators-only": if this doesn't complete within budget, or either call fails outright, proceed
// with no facts — never a hard failure, and never adds unbounded latency to a pipeline shared with
// the (latency-sensitive) voice advisor. Timeout and hard-error are logged distinctly (with
// elapsed time, and — for a hard error — which of the two calls threw and the actual error) so a
// stuck MCP connection doesn't read the same as an OpenAI auth failure.
async function getRelevantFactDescriptions(
  userId: string,
  accountId: string,
  contextualQueryText: string,
): Promise<string[]> {
  const startedAt = Date.now()
  const cacheKey = factCacheKey(userId, accountId)

  const marker = await getFactsFreshnessMarkerOrUnknown(userId, accountId)
  const markerMs = Date.now() - startedAt

  const cached = factCandidatesCache.get(cacheKey)
  const isHit = marker !== "unknown" && cached !== undefined && cached.marker === marker
  const timeoutBudget = isHit ? FACT_HIT_TIMEOUT_MS : FACT_MISS_TIMEOUT_MS

  let step: "embedding" | "mcp_query" = "embedding"
  // Populated as each step finishes, so the split is known even if the *other* step is the one
  // that eventually times out or throws — e.g. a timeout stuck in "mcp_query" still reports how
  // long the embedding call took before it got there. mcpMs stays null entirely on a cache hit,
  // since that step is skipped, not merely fast.
  let embeddingMs: number | null = null
  let mcpMs: number | null = null

  const work = (async () => {
    const embeddingStartedAt = Date.now()
    const questionEmbedding = await generateEmbedding(contextualQueryText)
    embeddingMs = Date.now() - embeddingStartedAt

    let candidates: FactCandidate[]
    if (isHit && cached) {
      candidates = cached.candidates
    } else {
      step = "mcp_query"
      const mcpStartedAt = Date.now()
      const rows = await mcpSelectQuery<{ description: string; embedding: unknown }>(`
        SELECT description, embedding
        FROM semantic_facts
        WHERE user_id = '${userId}'
          AND (account_id IS NULL OR account_id = '${accountId}')
          AND confidence_status = 'confirmed'
          AND superseded_by IS NULL
        LIMIT 50
      `)
      mcpMs = Date.now() - mcpStartedAt
      candidates = rows.map((row) => ({
        description: row.description,
        embedding: parseVectorColumn(row.embedding),
      }))
      // Only cache against a known marker — caching against "unknown" would let a later request
      // treat an unverifiable version as if it were confirmed current.
      if (marker !== "unknown") {
        factCandidatesCache.set(cacheKey, { marker, candidates })
      }
    }

    // Returns ALL scored candidates, unfiltered — filtering/sorting/slicing happens in the outer
    // scope below, only once we know this result actually won the race against the timeout (see
    // the bug this fixes, in logSimilarityOutcome's comment).
    return candidates.map((c) => ({
      description: c.description,
      similarity: cosineSimilarity(questionEmbedding, c.embedding),
    }))
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
    }, timeoutBudget)
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
        + `(budget ${timeoutBudget}ms, ${isHit ? "cache hit" : "cache miss"} path) — `
        + `still in "${step}" when the budget ran out. marker check: ${markerMs}ms, `
        + `embedding: ${embeddingMs ?? "did not finish"}ms, `
        + `mcp_query: ${mcpMs ?? (isHit ? "skipped (cache hit)" : "did not finish")}ms `
        + `— degrading to no memory context`,
      )
      return []
    }
    const scoredAll = result as { description: string; similarity: number }[]
    logSimilarityOutcome(scoredAll, "used")
    console.log(
      `Semantic facts similarity search completed in ${Date.now() - startedAt}ms `
      + `(${isHit ? "cache hit" : "cache miss"}; marker check: ${markerMs}ms, `
      + `embedding: ${embeddingMs}ms, mcp_query: ${mcpMs ?? "skipped (cache hit)"}ms, `
      + `budget ${timeoutBudget}ms)`,
    )
    return scoredAll
      .filter((c) => c.similarity > FACT_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, FACT_SIMILARITY_LIMIT)
      .map((row) => row.description)
  } catch (err) {
    console.error(
      `Semantic facts similarity search FAILED during "${step}" after ${Date.now() - startedAt}ms `
      + `(${isHit ? "cache hit" : "cache miss"} path; marker check: ${markerMs}ms, `
      + `embedding: ${embeddingMs ?? "did not finish"}ms, `
      + `mcp_query: ${mcpMs ?? (isHit ? "skipped (cache hit)" : "did not finish")}ms) `
      + `— degrading to no memory context. Error:`,
      err,
    )
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

    if (result.rows.length > 0) {
      return result.rows[0].result as Record<string, unknown>
    }
    return null
  } catch {
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
  } catch {
    return []
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
  } catch {
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
        '${JSON.stringify(responseData).replace(/'/g, "''")}',
        NOW() + INTERVAL '24 hours'
      )
      ON CONFLICT (user_id, account_id, query_hash)
      DO UPDATE SET
        result = EXCLUDED.result,
        query_embedding = EXCLUDED.query_embedding,
        expires_at = NOW() + INTERVAL '24 hours'
    `))
  } catch (err) {
    console.error("Cache write failed:", err)
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
    date range) unless the user explicitly changes them
  - If the question is ambiguous and context doesn't resolve
    it, respond directly with a short clarifying question
    (do NOT call run_sql)
  - If the question is clearly unrelated to personal finance,
    respond directly: "I can only answer questions about your transactions and spending."
  - Keep all direct responses to 1-2 sentences
  - Always use ${currency} for currency amounts
  - Lead with the answer, never repeat the question back`
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
  } catch {
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
${totalDebits > 0 || totalCredits > 0 ? `Pre-computed totals — debits: ${totalDebits.toFixed(2)}, credits: ${totalCredits.toFixed(2)}` : ""}
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

  return {
    type: "sql_result",
    sql: parsedSQL,
    rows,
    summary: summary.trim(),
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
  } = body

  if (!account_id) {
    return Response.json({ error: "account_id required" }, { status: 400 })
  }

  const userId = session.user.id

  const dedupedHistory = dedupeConsecutive(conversation_history ?? [])

  const dateFilter = [
    date_from ? `AND transaction_date >= '${date_from}'` : "",
    date_to ? `AND transaction_date <= '${date_to}'` : "",
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

  // Tier 2: similarity search
  const similarHits = await getSimilarCacheHits(userId, account_id, embedding, queryHash)
  if (!is_voice && similarHits.length > 0) {
    console.log("is_voice:", is_voice, "similar hits:", similarHits.length)
    return Response.json({
      type: "suggestions",
      question: question || intent,
      suggestions: similarHits,
      response: "I found similar questions you've asked before. Would you like to use one of these?",
      cached: false,
    })
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
- Never say "the data shows" or "based on the results"`,
                },
                {
                  role: "user",
                  content: `Question: ${question || intentLabel}
${totalDebits > 0 || totalCredits > 0
  ? `Pre-computed totals:
  Total debits: ${totalDebits.toFixed(2)}
  Total credits: ${totalCredits.toFixed(2)}`
  : ""}
Results (sample): ${JSON.stringify(rows.slice(0, 10))}
Summarize these results accurately.`,
                },
              ],
            })

            for await (const chunk of synthesisStream) {
              const text = chunk.choices[0]?.delta?.content ?? ""
              if (text) {
                fullResponseText += text
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "text", text })}\n\n`
                  )
                )
              }
            }

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
              response: fullResponseText,
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
      console.error("Query execution failed. SQL was:\n", querySQL, "\nError:", error)
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
  // for the last seven days" after "how has my balance been lately"). Hard-timeout + degrade
  // internally; never throws, never adds unbounded latency to a pipeline the voice advisor also
  // depends on.
  const relevantFacts = await getRelevantFactDescriptions(
    userId, account_id, buildContextualQueryText(question ?? cacheText, dedupedHistory),
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
    console.error("Agent loop failed:", error)
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
