// Read-only time series of this user's combined-balance snapshots, for the nominal-vs-real
// trend chart on the Macro page (BalanceTrendChart.tsx). Extraction mirrors
// distillation/pipeline/distiller.py's _extract_balance_snapshots exactly — same "only events
// with a usable numeric combined_balance" filter, same account_ids-sorted-or-null handling —
// rather than a re-derived calculation that could quietly drift out of sync with it. Python and
// TypeScript can't literally share this function across runtimes, so keep this in sync by hand if
// _extract_balance_snapshots' own extraction rules ever change (same cross-language pattern
// already used for MIN_OCCURRENCES_FOR_TREND elsewhere in this app).
import { auth } from "@/auth"
import { mcpSelectQuery } from "@/lib/mcp/client"
import { logError } from "@/lib/logger"

export const dynamic = "force-dynamic"

type MacroExplanationEventRow = {
  created_at: string
  metadata: Record<string, unknown> | null
}

export type BalanceHistoryPoint = {
  timestamp: string
  nominal_balance: number
  account_ids: string[]
  // True when the contributing account set differs from the immediately preceding snapshot's —
  // mirrors _classify_balance_steps' own "account_set_changed" detection (distiller.py): only
  // fires when BOTH snapshots have a known account_ids set and they actually differ. An unknown
  // set (an event recorded before this field existed) is treated as unchanged, same conservative
  // default as the Python side.
  account_set_changed: boolean
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }
  const userId = session.user.id

  let rows: MacroExplanationEventRow[] = []
  try {
    rows = await mcpSelectQuery<MacroExplanationEventRow>(`
      SELECT created_at, metadata
      FROM episodic_events
      WHERE user_id = '${userId}'
        AND event_type = 'macro_explanation'
      ORDER BY created_at ASC
    `)
  } catch (err) {
    logError({ context: "macro.balanceHistory", error: err, userId })
    return Response.json({ error: "Failed to load balance history" }, { status: 502 })
  }

  type ExtractedSnapshot = { timestamp: string; balance: number; accountIds: string[] | null }
  const snapshots: ExtractedSnapshot[] = []
  for (const row of rows) {
    // Defensive: no existing route in this app selects a whole metadata JSONB column via
    // mcpSelectQuery (every other read extracts a specific scalar sub-field via
    // metadata->>'field'), so there's no confirmed precedent for whether the MCP layer hands
    // this back as an already-parsed object or a raw JSON string — handle either rather than
    // assume one.
    const raw = row.metadata
    const metadata: Record<string, unknown> = raw == null
      ? {}
      : typeof raw === "string"
        ? (() => { try { return JSON.parse(raw) } catch { return {} } })()
        : raw

    const balance = metadata.combined_balance
    if (typeof balance !== "number") continue
    const rawAccountIds = metadata.account_ids
    const accountIds = Array.isArray(rawAccountIds)
      ? [...rawAccountIds].map(String).sort()
      : null
    snapshots.push({ timestamp: row.created_at, balance, accountIds })
  }
  // Already ordered via ORDER BY created_at ASC — re-sorted defensively (same-timestamp ties, or
  // a future query change) rather than trusting the query alone, matching
  // _extract_balance_snapshots' own explicit sort.
  snapshots.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  const points: BalanceHistoryPoint[] = snapshots.map((s, i) => {
    const prev = i > 0 ? snapshots[i - 1] : null
    // Null (predates the account_ids field) and [] (genuinely no contributing accounts known)
    // are normalized together here — both mean "nothing known was contributing" from this
    // chart's point of view. Distiller.py's _classify_balance_steps deliberately treats an
    // unknown set as unchanged, but that's specific to its own purpose (avoid suppressing a
    // genuine up/down % trend calculation off incomplete old data) — for annotating *this*
    // chart, an empty-or-unknown-to-populated transition is exactly the jump that most needs
    // explaining, not one to exempt from detection.
    const accountSetChanged = !!(
      prev && JSON.stringify(prev.accountIds ?? []) !== JSON.stringify(s.accountIds ?? [])
    )
    return {
      timestamp: s.timestamp,
      nominal_balance: s.balance,
      account_ids: s.accountIds ?? [],
      account_set_changed: accountSetChanged,
    }
  })

  return Response.json({ points })
}
