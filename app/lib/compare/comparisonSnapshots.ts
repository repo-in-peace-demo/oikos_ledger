// Shared cached read for trend:comparison_snapshot facts — the SINGLE source of truth for this
// query, so the Compare page (app/app/api/accounts/compare/route.ts) and Compare's voice handler
// (app/app/api/accounts/compare/query/route.ts) both go through the same marker-based cache
// instead of two independent code paths that could drift apart. This was extracted after a
// confirmed gap: the voice handler used to run its own fresh, uncached MCP query on every single
// question — worse for voice specifically, given the Realtime API's sub-second response design
// goal (ADR 013), and duplicating a query that already had a working cache right next to it.
//
// Honest caveat on what "shared" actually guarantees: Next.js API routes under app/app/api/ can
// each be bundled and deployed as their own serverless function (see the existing note in
// app/app/api/insights/query/route.ts on why its prefetch branch is handled in-route rather than
// as a separate endpoint, for exactly this reason). Importing this module from two different
// route.ts files guarantees identical caching *logic* and a single place to fix bugs or tune
// behavior in — and genuinely shares the same in-memory Map within one process (local dev, or two
// routes that happen to run in the same warm serverless instance). It does NOT guarantee the two
// routes share one Map across separate deployed instances if the platform schedules them onto
// different processes — there is no code-level fix for that on this platform; only running both
// through one route (which neither currently does) would give an absolute guarantee.
import { sql } from "drizzle-orm"
import { dbReadonly } from "@/lib/db/client"
import { logError } from "@/lib/logger"
import { mcpSelectQuery } from "@/lib/mcp/client"

// account_id/compared_account_id are both real columns (see ingestion/models/memory.py) — the
// distillation job writes facts under this same fact_type constant once both accounts have a
// confirmed category_baseline for the same category.
export const COMPARISON_SNAPSHOT_FACT_TYPE = "trend:comparison_snapshot"

export type ComparisonSnapshotRow = {
  id: string
  category: string
  description: string
  occurrence_count: number
  confidence_status: string
  updated_at: string
}

type ComparisonSnapshotCacheEntry = { marker: string | null; data: ComparisonSnapshotRow[] }
const comparisonSnapshotCache = new Map<string, ComparisonSnapshotCacheEntry>()

// Canonical, order-independent key for an account pair — the same two accounts can arrive here in
// either order depending on which the user happened to select first (or which order the client
// happened to list accounts in for a voice question), and should hit the same cache entry either
// way.
function pairCacheKey(userId: string, accountIds: string[]): string {
  return `${userId}:${[...accountIds].sort().join(",")}`
}

// Marker check is direct SQL (dbReadonly), not MCP — same one exception to "reads for this
// feature go through MCP" already established for loadAccountMemory's marker in ../route.ts: the
// marker never returns fact content, only a timestamp, so there's nothing here that needs the
// Managed MCP Server's involvement.
async function getComparisonSnapshotMarker(userId: string, accountIds: string[]): Promise<string | null> {
  const idList = accountIds.map((id) => `'${id}'`).join(",")
  const result = (await dbReadonly.execute(sql.raw(`
    SELECT MAX(updated_at) AS marker
    FROM semantic_facts
    WHERE user_id = '${userId}'
      AND fact_type = '${COMPARISON_SNAPSHOT_FACT_TYPE}'
      AND superseded_by IS NULL
      AND account_id IN (${idList})
      AND compared_account_id IN (${idList})
  `))) as unknown as { rows: Record<string, unknown>[] }
  const marker = result.rows[0]?.marker
  return marker ? String(marker) : null
}

// Fetches trend:comparison_snapshot facts for any pair within the given account set —
// account_id/compared_account_id are a canonical sorted pair internally (see
// _extract_comparison_pairs in distillation/pipeline/distiller.py), but that ordering is an
// implementation detail; matching both columns against the same IN-list surfaces a fact
// regardless of which of the two selected IDs the distillation job happened to store as which
// column.
export async function loadComparisonSnapshots(
  userId: string,
  accountIds: string[],
): Promise<ComparisonSnapshotRow[]> {
  if (accountIds.length === 0) return []

  const cacheKey = pairCacheKey(userId, accountIds)

  let marker: string | null = null
  try {
    marker = await getComparisonSnapshotMarker(userId, accountIds)
  } catch (err) {
    // Marker check failing just means "can't verify freshness" — fall through to a real fetch
    // below rather than risk serving a stale (or wrong) cached entry.
    logError({ context: "loadComparisonSnapshots.marker", error: err, userId, accountIds })
  }

  const cached = comparisonSnapshotCache.get(cacheKey)
  if (cached && cached.marker === marker) {
    return cached.data
  }

  const idList = accountIds.map((id) => `'${id}'`).join(",")
  const data = await mcpSelectQuery<ComparisonSnapshotRow>(`
    SELECT id, category, description, occurrence_count, confidence_status, updated_at
    FROM semantic_facts
    WHERE user_id = '${userId}'
      AND fact_type = '${COMPARISON_SNAPSHOT_FACT_TYPE}'
      AND superseded_by IS NULL
      AND account_id IN (${idList})
      AND compared_account_id IN (${idList})
    ORDER BY updated_at DESC
  `)
  comparisonSnapshotCache.set(cacheKey, { marker, data })
  return data
}
