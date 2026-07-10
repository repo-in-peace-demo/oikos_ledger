import { auth } from "@/auth"
import { dbReadonly } from "@/lib/db/client"
import { sql } from "drizzle-orm"
import { getTransactionsDataMarkerOrUnknown, isCacheEntryFresh } from "@/lib/queryCacheFreshness"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { query_hash, account_id } = await request.json()

  if (!query_hash || !account_id) {
    return Response.json(
      { error: "query_hash and account_id required" },
      { status: 400 },
    )
  }

  const userId = session.user.id

  try {
    const result = (await dbReadonly.execute(sql.raw(`
      SELECT result
      FROM query_cache
      WHERE user_id = '${userId}'
        AND account_id = '${account_id}'
        AND query_hash = '${query_hash}'
        AND expires_at > NOW()
      LIMIT 1
    `))) as unknown as { rows: Record<string, unknown>[] }

    if (result.rows.length === 0) {
      return Response.json(
        { error: "Cache entry not found or expired" },
        { status: 404 },
      )
    }

    const cached = result.rows[0].result as Record<string, unknown>
    // Same freshness check as the exact-hash path in /api/insights/query — a suggestion clicked
    // here goes straight to a raw cached result with no other staleness guard, so without this a
    // stale suggestion (e.g. referencing a since-deleted transaction) would be servable
    // indefinitely within its TTL. Reuses the same 404 shape as an expired/missing entry — the
    // client's existing error handling for this endpoint already covers it.
    const currentMarker = await getTransactionsDataMarkerOrUnknown(userId, account_id)
    if (!isCacheEntryFresh(cached._data_marker, currentMarker)) {
      return Response.json(
        { error: "Cache entry not found or expired" },
        { status: 404 },
      )
    }

    return Response.json({
      ...cached,
      cached: true,
    })
  } catch (error) {
    return Response.json(
      { error: "Cache lookup failed", detail: String(error) },
      { status: 500 },
    )
  }
}
