// Data-change freshness check for query_cache — the same class of staleness problem already
// solved for semantic_facts (see FACT_MARKER_TIMEOUT_MS in the insights query route), applied
// here to transaction data. query_cache previously only expired on a fixed 24h TTL, with no
// invalidation tied to actual writes: a transaction deleted or added between a cache write and a
// later read would silently keep serving the pre-change answer until the TTL lapsed.
//
// Chose a marker over ad-hoc invalidation calls scattered across every write path (ingestion,
// amendments, manual/admin deletes) for the same reason it was chosen for semantic_facts: a
// scattered approach only works if every current and future write path remembers to call it —
// a marker is enforced at the read side instead, so it can't be forgotten by a new write path.
//
// `transactions` has no updated_at (explicitly append-only per schema.ts), and confirmed by
// reading the amendment flow directly: amendments write only to transaction_amendments (an audit
// log) and the global merchants registry (for future ingestion) — a transaction's own row is
// never mutated in place. So the only real write patterns are insert (new statement upload) and
// delete (manual/admin action) — COUNT(*) alone is sensitive to both; MAX(created_at) is included
// as a free extra signal against the narrow edge case of a delete-then-insert netting to the same
// count.
import { dbReadonly } from "@/lib/db/client"
import { sql } from "drizzle-orm"
import { logError } from "@/lib/logger"

const TRANSACTIONS_MARKER_TIMEOUT_MS = 300

async function getTransactionsDataMarker(userId: string, accountId: string): Promise<string> {
  const result = (await dbReadonly.execute(sql.raw(`
    SELECT COUNT(*) AS row_count, MAX(created_at) AS latest
    FROM transactions
    WHERE user_id = '${userId}' AND account_id = '${accountId}'
  `))) as unknown as { rows: { row_count: string; latest: string | null }[] }
  const row = result.rows[0]
  return `${row.row_count}:${row.latest ?? ""}`
}

// Same hard-timeout + degrade pattern used throughout the insights query route: a failure or
// timeout here is treated as "unknown", which the caller must treat as "cannot verify — do not
// serve this cache entry", not as a pass.
export async function getTransactionsDataMarkerOrUnknown(
  userId: string,
  accountId: string,
): Promise<string | "unknown"> {
  const work = getTransactionsDataMarker(userId, accountId)
  work.catch(() => {})

  let timedOut = false
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => {
      timedOut = true
      resolve("timeout")
    }, TRANSACTIONS_MARKER_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([work, timeout])
    if (timedOut) {
      logError({
        context: "getTransactionsDataMarkerOrUnknown",
        error: new Error(`Marker check exceeded ${TRANSACTIONS_MARKER_TIMEOUT_MS}ms budget`),
        userId,
        accountId,
        note: "treating as unknown — cache reads will be treated as a miss",
      })
      return "unknown"
    }
    return result as string
  } catch (err) {
    logError({
      context: "getTransactionsDataMarkerOrUnknown",
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
