// Shared cached read for Macro's user-level memory facts (trend:balance_snapshot) — the SINGLE
// source of truth for this query, so the Macro page (app/app/api/macro/route.ts) and Macro's
// voice handler (app/app/api/macro/query/route.ts) both go through the same marker-based cache
// instead of two independent code paths that could drift apart.
//
// Built this way from the start, unlike Compare's equivalent: Compare's voice feature originally
// bypassed its page's cache entirely (a fresh, uncached MCP call on every question), fixed only
// after live testing exposed it — see app/lib/compare/comparisonSnapshots.ts's own header comment
// for that history. Checked before writing this: the Macro page itself had NO marker-based cache
// at all yet (a single fresh mcpSelectQuery per page load) — so there was nothing to "reuse" here
// in the literal sense; this module is that cache, built once, for both consumers from day one.
//
// Honest caveat on what "shared" actually guarantees, same as Compare's: Next.js API routes can
// each be bundled and deployed as their own serverless function on this platform. Importing this
// module from two different route.ts files guarantees identical caching *logic* and a single place
// to fix bugs or tune behavior in, and genuinely shares one in-memory Map within a single process
// (local dev, or two routes that happen to land on the same warm serverless instance) — it does
// NOT guarantee that across separately-scheduled instances in production.
import { sql } from "drizzle-orm"
import { dbReadonly } from "@/lib/db/client"
import { logError } from "@/lib/logger"
import { mcpSelectQuery } from "@/lib/mcp/client"

// Allow-list, not a block-list: only fact_types that belong on the Macro page's memory panel.
// account_id-scoped facts (e.g. Compare's "category_baseline") are excluded by the account_id IS
// NULL filter below regardless, but this allow-list also keeps out any future user-level fact_type
// that isn't macro-relevant. Add new macro-relevant types here as they're built (e.g. a future
// "trend:repo_rate_snapshot").
export const MACRO_RELEVANT_FACT_TYPES = ["trend:balance_snapshot"] as const

export type MacroFactRow = {
  id: string
  fact_type: string
  category: string | null
  description: string
  relevance_score: number
  confidence_status: string
  occurrence_count: number
  updated_at: string
}

type MacroFactCacheEntry = { marker: string | null; data: MacroFactRow[] }
const macroFactCache = new Map<string, MacroFactCacheEntry>()

// MAX(updated_at) across this user's active, allow-listed macro facts — the onupdate trigger on
// semantic_facts.updated_at (see ingestion/models/memory.py) fires on every bump-in-place or
// supersession, so this changes exactly when the facts query below would return something
// different. Direct SQL (dbReadonly), not MCP — same one exception to "reads for this feature go
// through MCP" already established for Compare's markers: the marker never returns fact content,
// only a timestamp, so there's nothing here that needs the Managed MCP Server's involvement.
async function getMacroFactsMarker(userId: string): Promise<string | null> {
  const factTypeList = MACRO_RELEVANT_FACT_TYPES.map((t) => `'${t}'`).join(", ")
  const result = (await dbReadonly.execute(sql.raw(`
    SELECT MAX(updated_at) AS marker
    FROM semantic_facts
    WHERE user_id = '${userId}'
      AND account_id IS NULL
      AND fact_type IN (${factTypeList})
      AND superseded_by IS NULL
  `))) as unknown as { rows: Record<string, unknown>[] }
  const marker = result.rows[0]?.marker
  return marker ? String(marker) : null
}

// Fetches this user's active, allow-listed macro memory facts (currently just
// trend:balance_snapshot) — user-level (account_id IS NULL), so scoped by user_id alone, no
// account pairing/ordering concern the way Compare's comparison_snapshot cache has.
export async function loadMacroFacts(userId: string): Promise<MacroFactRow[]> {
  let marker: string | null = null
  try {
    marker = await getMacroFactsMarker(userId)
  } catch (err) {
    // Marker check failing just means "can't verify freshness" — fall through to a real fetch
    // below rather than risk serving a stale (or wrong) cached entry.
    logError({ context: "loadMacroFacts.marker", error: err, userId })
  }

  const cached = macroFactCache.get(userId)
  if (cached && cached.marker === marker) {
    console.log(JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      context: "loadMacroFacts.cache",
      event: "HIT",
      userId,
      marker,
    }))
    return cached.data
  }

  console.log(JSON.stringify({
    level: "info",
    timestamp: new Date().toISOString(),
    context: "loadMacroFacts.cache",
    event: "MISS",
    reason: !cached ? "no_cached_entry" : "marker_mismatch",
    userId,
    marker,
    cachedMarker: cached?.marker ?? null,
  }))

  const factTypeList = MACRO_RELEVANT_FACT_TYPES.map((t) => `'${t}'`).join(", ")
  const data = await mcpSelectQuery<MacroFactRow>(`
    SELECT id, fact_type, category, description, relevance_score, confidence_status,
      occurrence_count, updated_at
    FROM semantic_facts
    WHERE user_id = '${userId}'
      AND account_id IS NULL
      AND fact_type IN (${factTypeList})
      AND superseded_by IS NULL
    ORDER BY relevance_score DESC
    LIMIT 5
  `)
  macroFactCache.set(userId, { marker, data })
  return data
}
