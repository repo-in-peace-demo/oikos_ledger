// Data-change freshness check for query_cache — the same class of staleness problem already
// solved for semantic_facts caching (see getFactCandidatesMarker in
// app/lib/insights/factCandidates.ts), applied here to query_cache as a whole. query_cache
// previously only expired on a fixed 24h TTL, with no invalidation tied to actual writes: a
// transaction deleted/added, or a fact newly confirmed/changed, between a cache write and a later
// read would silently keep serving the pre-change answer until the TTL lapsed.
//
// Chose a marker over ad-hoc invalidation calls scattered across every write path (ingestion,
// amendments, manual/admin deletes, fact confirmation) for the same reason it was chosen for
// semantic_facts elsewhere: a scattered approach only works if every current and future write
// path remembers to call it — a marker is enforced at the read side instead, so it can't be
// forgotten by a new write path.
//
// The marker is a SINGLE combined value covering BOTH data sources this cache's answers depend
// on, computed in one round trip:
//   - transactions: `transactions` has no updated_at (explicitly append-only per schema.ts), and
//     confirmed by reading the amendment flow directly: amendments write only to
//     transaction_amendments (an audit log) and the global merchants registry (for future
//     ingestion) — a transaction's own row is never mutated in place. So the only real write
//     patterns are insert (new statement upload) and delete (manual/admin action) — COUNT(*)
//     alone is sensitive to both; MAX(created_at) is included as a free extra signal against the
//     narrow edge case of a delete-then-insert netting to the same count.
//   - semantic_facts: MAX(updated_at) across exactly the rows a cached response could have used
//     as memory context (confirmed, not superseded, scoped to this user + account-or-user-level —
//     same scoping as getFactCandidatesMarker) — changes precisely when a new fact confirms, an
//     existing confirmed fact updates, or one gets superseded. This was the actual gap that let
//     two phrasings of the same question ("last 30 days" vs "last thirty days") disagree on
//     memory usage: the marker only ever tracked transactions, so a response cached before a fact
//     confirmed stayed "fresh" indefinitely even though the memory state had since moved — the
//     OTHER phrasing (a fresh cache miss) picked up the newly-confirmed fact immediately, and the
//     two diverged.
//
// A mismatch on EITHER half means stale — the combined marker only matches when both are
// unchanged since the entry was written.
import { dbReadonly } from "@/lib/db/client"
import { sql } from "drizzle-orm"
import { logError } from "@/lib/logger"

const QUERY_CACHE_MARKER_TIMEOUT_MS = 300

async function getQueryCacheDataMarker(userId: string, accountId: string): Promise<string> {
  const result = (await dbReadonly.execute(sql.raw(`
    SELECT
      (SELECT COUNT(*) FROM transactions
        WHERE user_id = '${userId}' AND account_id = '${accountId}') AS txn_count,
      (SELECT MAX(created_at) FROM transactions
        WHERE user_id = '${userId}' AND account_id = '${accountId}') AS txn_latest,
      (SELECT MAX(updated_at) FROM semantic_facts
        WHERE user_id = '${userId}'
          AND (account_id IS NULL OR account_id = '${accountId}')
          AND confidence_status = 'confirmed'
          AND superseded_by IS NULL) AS facts_marker
  `))) as unknown as {
    rows: { txn_count: string; txn_latest: string | null; facts_marker: string | null }[]
  }
  const row = result.rows[0]
  return `${row.txn_count}:${row.txn_latest ?? ""}|${row.facts_marker ?? ""}`
}

// Same hard-timeout + degrade pattern used throughout the insights query route: a failure or
// timeout here is treated as "unknown", which the caller must treat as "cannot verify — do not
// serve this cache entry", not as a pass.
export async function getQueryCacheDataMarkerOrUnknown(
  userId: string,
  accountId: string,
): Promise<string | "unknown"> {
  const work = getQueryCacheDataMarker(userId, accountId)
  work.catch(() => {})

  let timedOut = false
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      timedOut = true
      resolve("timeout")
    }, QUERY_CACHE_MARKER_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([work, timeout])
    if (timedOut) {
      logError({
        context: "getQueryCacheDataMarkerOrUnknown",
        error: new Error(`Marker check exceeded ${QUERY_CACHE_MARKER_TIMEOUT_MS}ms budget`),
        userId,
        accountId,
        note: "treating as unknown — cache reads will be treated as a miss",
      })
      return "unknown"
    }
    return result as string
  } catch (err) {
    logError({
      context: "getQueryCacheDataMarkerOrUnknown",
      error: err,
      userId,
      accountId,
      note: "treating as unknown — cache reads will be treated as a miss",
    })
    return "unknown"
  }
}

// A cache entry is only servable if its stored marker exactly matches the current one. An
// "unknown" current marker (timeout/failure) never passes — an unverifiable freshness check must
// never be treated as a pass. A cache entry written before this fix existed has no stored marker
// at all (undefined), which also never matches a real current marker string — meaning every
// pre-existing cache entry is treated as stale and recomputed the first time it's read after this
// ships, with no backfill/migration needed.
export function isCacheEntryFresh(
  cachedMarker: unknown,
  currentMarker: string | "unknown",
): boolean {
  if (currentMarker === "unknown") return false
  return cachedMarker === currentMarker
}
