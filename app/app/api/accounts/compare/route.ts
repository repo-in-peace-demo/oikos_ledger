// Compares distilled memory (episodic_events + semantic_facts) across two or more of the user's accounts
import { and, eq, gte, lte, sql } from "drizzle-orm"
import { after } from "next/server"
import { auth } from "@/auth"
import { db, dbReadonly } from "@/lib/db/client"
import { episodic_events, transactions } from "@/lib/db/schema"
import { getBankAccountsByUserId } from "@/lib/db/queries/bank_accounts"
import {
  type ComparisonSnapshotRow,
  loadComparisonSnapshots,
} from "@/lib/compare/comparisonSnapshots"
import { generateEmbedding } from "@/lib/embeddings"
import { logError } from "@/lib/logger"
import { mcpSelectQuery } from "@/lib/mcp/client"
import { todayDateString } from "@/lib/today"

export const dynamic = "force-dynamic"

// category_baseline facts (see distillation/pipeline/distiller.py) can only ever be built from
// episodic_events that carry a real account_id plus a numeric metadata.amount/category — nothing
// else in the codebase writes events shaped like that. Compare is the natural place to start:
// every time it runs, record one observation per (account, category) actually involved, so the
// distillation job's generic trend/percentile pass (fetch_recent_events, unfiltered by
// event_type) has something to group.
const CATEGORY_SPEND_SNAPSHOT_EVENT_TYPE = "category_spend_snapshot"

// Window the "amount" itself is computed over — a rolling recent total, not all-time spend.
// All-time would grow every time more statements get uploaded, making repeat observations
// incomparable (never "flat", always "up"); a rolling window makes separate sessions sample the
// same kind of quantity, the same reasoning as Macro's point-in-time combined_balance snapshot.
const CATEGORY_SNAPSHOT_LOOKBACK_DAYS = 30

// Same throttle pattern as Macro's SNAPSHOT_THROTTLE_HOURS — repeatedly clicking Compare in one
// sitting shouldn't each write their own row and inflate occurrence_count with redundant
// observations. Scoped per (account_id, category) rather than globally, since a single Compare
// click can touch several categories independently.
const CATEGORY_SNAPSHOT_THROTTLE_HOURS = 24

type EpisodicEventRow = {
  id: string
  event_type: string
  content: string
  created_at: string
}

// account_id is a real column on semantic_facts (see ingestion/models/memory.py) — per-account
// category baselines are scoped by that column directly, not by encoding the account into
// fact_type. Part C's distillation job writes facts under this same fact_type constant.
const ACCOUNT_CATEGORY_BASELINE_FACT_TYPE = "category_baseline"

type SemanticFactRow = {
  id: string
  category: string | null
  description: string
  running_mean: number | null
  occurrence_count: number
  confidence_status: string
  relevance_score: number
}

type AccountMemory = {
  account_id: string
  label: string
  episodic_events: EpisodicEventRow[]
  semantic_facts: SemanticFactRow[]
}

// Both reads below (loadAccountMemory, loadComparisonSnapshots) only change when distillation
// writes/supersedes a semantic_facts row — never per-request — the same situation the Insights
// fact-similarity cache was built for (see app/app/api/insights/query/route.ts's now-removed
// factCandidatesCache/getFactsFreshnessMarker). That cache was later removed for an unrelated
// reason: it fetched raw embedding vectors in bulk, which hit the MCP select_query tool's
// response-size cap ("max result size exceeded", confirmed empirically to fail above 1 row when a
// query returns a 1536-float embedding column). These two queries never select `embedding` at
// all — empirically confirmed live at 0.6-4.2KB per call for this account's real data (20 events +
// several category_baseline facts), orders of magnitude under that cap — so the same caching
// pattern is safe to bring back here without re-hitting that limit.
//
// Marker checks are direct SQL (dbReadonly), not MCP — same one exception to "reads for this
// feature go through MCP" the Insights fix used: the marker never returns fact content, only a
// timestamp, so there's nothing here that needs the Managed MCP Server's involvement.
type AccountMemoryCacheEntry = { marker: string | null; data: Omit<AccountMemory, "label"> }
const accountMemoryCache = new Map<string, AccountMemoryCacheEntry>()

// MAX(updated_at) across this account's active category_baseline facts — the onupdate trigger on
// semantic_facts.updated_at (see ingestion/models/memory.py) fires on every bump-in-place or
// supersession, so this changes exactly when loadAccountMemory's semantic_facts result would.
// Deliberately doesn't cover episodic_events (recent_events) — those change on every Compare click
// via this account's own category_spend_snapshot writes, far more often than distillation runs,
// but recent_events isn't actually rendered anywhere in ComparePanel.tsx today, so a cache hit
// occasionally serving one cycle's worth of stale recent_events is unobservable, not a real bug.
async function getAccountMemoryMarker(userId: string, accountId: string): Promise<string | null> {
  const result = (await dbReadonly.execute(sql.raw(`
    SELECT MAX(updated_at) AS marker
    FROM semantic_facts
    WHERE user_id = '${userId}'
      AND account_id = '${accountId}'
      AND fact_type = '${ACCOUNT_CATEGORY_BASELINE_FACT_TYPE}'
      AND superseded_by IS NULL
  `))) as unknown as { rows: Record<string, unknown>[] }
  const marker = result.rows[0]?.marker
  return marker ? String(marker) : null
}

async function loadAccountMemory(userId: string, accountId: string): Promise<Omit<AccountMemory, "label">> {
  const cacheKey = `${userId}:${accountId}`

  let marker: string | null = null
  try {
    marker = await getAccountMemoryMarker(userId, accountId)
  } catch (err) {
    // Marker check failing just means "can't verify freshness" — fall through to a real fetch
    // below rather than risk serving a stale (or wrong) cached entry.
    logError({ context: "loadAccountMemory.marker", error: err, userId, accountId })
  }

  const cached = accountMemoryCache.get(cacheKey)
  if (cached && cached.marker === marker) {
    console.log(JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      context: "loadAccountMemory.cache",
      event: "HIT",
      userId,
      accountId,
      marker,
    }))
    return cached.data
  }

  console.log(JSON.stringify({
    level: "info",
    timestamp: new Date().toISOString(),
    context: "loadAccountMemory.cache",
    event: "MISS",
    reason: !cached ? "no_cached_entry" : "marker_mismatch",
    userId,
    accountId,
    marker,
    cachedMarker: cached?.marker ?? null,
  }))

  const [events, facts] = await Promise.all([
    mcpSelectQuery<EpisodicEventRow>(`
      SELECT id, event_type, content, created_at
      FROM episodic_events
      WHERE user_id = '${userId}' AND account_id = '${accountId}'
      ORDER BY created_at DESC
      LIMIT 20
    `),
    mcpSelectQuery<SemanticFactRow>(`
      SELECT id, category, description, running_mean, occurrence_count, confidence_status, relevance_score
      FROM semantic_facts
      WHERE user_id = '${userId}'
        AND account_id = '${accountId}'
        AND fact_type = '${ACCOUNT_CATEGORY_BASELINE_FACT_TYPE}'
        AND superseded_by IS NULL
      ORDER BY relevance_score DESC
    `),
  ])
  const data = { account_id: accountId, episodic_events: events, semantic_facts: facts }
  accountMemoryCache.set(cacheKey, { marker, data })
  return data
}

// Per-category debit totals for one account over the trailing CATEGORY_SNAPSHOT_LOOKBACK_DAYS —
// queried directly via the app's own db client (same as /api/analytics), not mcpSelectQuery,
// since transactions is a normal high-traffic table the app already has full grants on; MCP reads
// in this route are reserved for the memory tables (episodic_events/semantic_facts).
//
// Upper-bounded at `until` as well as lower-bounded at `since` — demo/seed data can legitimately
// extend past today (e.g. to cover an uncertain judging window), and without the upper bound this
// "trailing 30 days" window would also sum up future-dated rows that haven't happened yet,
// inflating both the live category_deltas and the category_spend_snapshot events this feeds into
// distillation (which would otherwise bake the inflated total into a category_baseline fact's
// running_mean). `until` is the caller's own todayDateString(), not SQL's CURRENT_DATE — see that
// function's doc comment for why trusting two independently-evaluated clocks for the same boundary
// is itself a source of exactly this kind of off-by-one.
async function getCategorySpendTotals(
  userId: string,
  accountId: string,
  since: string,
  until: string,
): Promise<{ category: string; amount: number }[]> {
  const rows = await db
    .select({
      category: transactions.category,
      total: sql<string>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .where(and(
      eq(transactions.user_id, userId),
      eq(transactions.account_id, accountId),
      eq(transactions.transaction_type, "debit"),
      gte(transactions.transaction_date, since),
      lte(transactions.transaction_date, until),
    ))
    .groupBy(transactions.category)

  return rows
    .map((r) => ({ category: r.category, amount: Number(r.total) }))
    .filter((r) => r.amount > 0)
}

// Records one category_spend_snapshot episodic event per (account, category) that actually had
// spend in the lookback window, skipping any (account_id, category) pair already recorded within
// CATEGORY_SNAPSHOT_THROTTLE_HOURS. Best-effort — a failure here degrades to "no new baseline
// evidence this run", not a failed comparison, same as the comparison_run write above.
async function recordCategorySpendSnapshots(
  userId: string,
  accounts: AccountMemory[],
): Promise<void> {
  const now = new Date()
  const until = todayDateString(now)
  const since = new Date(now.getTime() - CATEGORY_SNAPSHOT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const perAccountTotals = await Promise.all(
    accounts.map(async (acc) => ({
      account: acc,
      totals: await getCategorySpendTotals(userId, acc.account_id, since, until),
    })),
  )

  const idList = accounts.map((a) => `'${a.account_id}'`).join(",")
  const recentSnapshots = await mcpSelectQuery<{ account_id: string; category: string }>(`
    SELECT account_id, metadata->>'category' AS category
    FROM episodic_events
    WHERE user_id = '${userId}'
      AND event_type = '${CATEGORY_SPEND_SNAPSHOT_EVENT_TYPE}'
      AND account_id IN (${idList})
      AND created_at > NOW() - INTERVAL '${CATEGORY_SNAPSHOT_THROTTLE_HOURS} hours'
  `)
  const throttled = new Set(recentSnapshots.map((r) => `${r.account_id}::${r.category}`))

  const toWrite = perAccountTotals.flatMap(({ account, totals }) =>
    totals
      .filter((t) => !throttled.has(`${account.account_id}::${t.category}`))
      .map((t) => ({ account, category: t.category, amount: t.amount })),
  )

  await Promise.all(toWrite.map(async ({ account, category, amount }) => {
    const content = `${account.label} spent ₹${amount.toLocaleString("en-IN")} on ${category} `
      + `in the last ${CATEGORY_SNAPSHOT_LOOKBACK_DAYS} days.`
    const embedding = await generateEmbedding(content)
    await db.insert(episodic_events).values({
      user_id: userId,
      account_id: account.account_id,
      event_type: CATEGORY_SPEND_SNAPSHOT_EVENT_TYPE,
      content,
      embedding,
      metadata: { category, amount },
    })
  }))
}

function buildCategoryDeltas(accounts: AccountMemory[]) {
  const categories = new Set<string>()
  for (const acc of accounts) {
    for (const fact of acc.semantic_facts) {
      if (fact.category) categories.add(fact.category)
    }
  }

  return Array.from(categories).map((category) => {
    const values: Record<string, number | null> = {}
    for (const acc of accounts) {
      const fact = acc.semantic_facts.find((f) => f.category === category)
      values[acc.account_id] = fact?.running_mean ?? null
    }
    const present = Object.values(values).filter((v): v is number => v !== null)
    const delta = present.length >= 2 ? Math.max(...present) - Math.min(...present) : null
    return { category, values, delta }
  })
}

// Records the comparison_run summary event that distillation's _extract_comparison_pairs reads
// back to know which account pairs have actually been compared. Not on the response's critical
// path (see the POST handler's after() call below) — this only feeds future distillation runs,
// nothing the user waits on right now.
async function recordComparisonRunEvent(
  userId: string,
  accountMemories: AccountMemory[],
  categoryDeltaCount: number,
  validIds: string[],
): Promise<void> {
  const summary = `Compared ${accountMemories.length} accounts (${accountMemories.map((a) => a.label).join(", ")}) `
    + `across ${categoryDeltaCount} categories with distilled baselines.`
  const embedding = await generateEmbedding(summary)
  // account_labels alongside account_ids — the distillation job (oikos_recall_distill_rw) has
  // no grant on bank_accounts, same constraint as trend:balance_snapshot's combined_balance
  // (see distillation/pipeline/distiller.py), so it can't look account names up itself when
  // writing a trend:comparison_snapshot fact's description ("HDFC has run higher than Axis...").
  // Carrying the labels here, computed once at request time where bank_accounts is already
  // available, is the same workaround pattern already established for that fact type.
  const account_labels = Object.fromEntries(accountMemories.map((a) => [a.account_id, a.label]))
  await db.insert(episodic_events).values({
    user_id: userId,
    account_id: null, // spans multiple accounts — see metadata.account_ids
    event_type: "comparison_run",
    content: summary,
    embedding,
    metadata: { account_ids: validIds, account_labels },
  })
}

function buildFactOverlap(accounts: AccountMemory[]) {
  const categoriesByAccount = accounts.map(
    (acc) => new Set(acc.semantic_facts.map((f) => f.category).filter(Boolean) as string[]),
  )
  const shared = categoriesByAccount.length > 0
    ? [...categoriesByAccount[0]].filter((cat) => categoriesByAccount.every((set) => set.has(cat)))
    : []

  const unique_to = accounts.map((acc, i) => ({
    account_id: acc.account_id,
    categories: [...categoriesByAccount[i]].filter(
      (cat) => !categoriesByAccount.some((set, j) => j !== i && set.has(cat)),
    ),
  }))

  return { shared, unique_to }
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }
  const userId = session.user.id

  const body = await request.json()
  const requestedIds: string[] = Array.isArray(body?.account_ids) ? body.account_ids : []

  if (requestedIds.length < 2) {
    return Response.json({ error: "At least two account_ids are required" }, { status: 400 })
  }

  const userAccounts = await getBankAccountsByUserId(userId)
  const userAccountIds = new Set(userAccounts.map((a) => a.id))
  const validIds = [...new Set(requestedIds)].filter((id) => userAccountIds.has(id))

  if (validIds.length < 2) {
    return Response.json({ error: "At least two valid account_ids owned by this user are required" }, { status: 400 })
  }

  let accountMemories: AccountMemory[]
  try {
    const loaded = await Promise.all(validIds.map((id) => loadAccountMemory(userId, id)))
    accountMemories = loaded.map((mem) => {
      const account = userAccounts.find((a) => a.id === mem.account_id)
      // bank_name always shown — account_nickname alone isn't reliable for distinguishing
      // accounts (e.g. two accounts both left at a shared default nickname like "Primary" would
      // otherwise render identically, and — since this label also becomes account_labels below —
      // bake an indistinguishable "Primary has run higher than Primary" into a stored fact
      // description). Same convention as /api/macro's balance breakdown fix.
      const label = account
        ? (account.account_nickname ? `${account.bank_name} (${account.account_nickname})` : account.bank_name)
        : mem.account_id
      return { ...mem, label }
    })
  } catch (err) {
    console.error("MCP memory lookup failed for compare:", err)
    return Response.json({ error: "Memory lookup failed" }, { status: 502 })
  }

  const category_deltas = buildCategoryDeltas(accountMemories)
  const { shared, unique_to } = buildFactOverlap(accountMemories)

  let comparisonSnapshots: ComparisonSnapshotRow[] = []
  try {
    comparisonSnapshots = await loadComparisonSnapshots(userId, validIds)
  } catch (err) {
    console.error("Failed to load comparison_snapshot facts:", err)
  }

  // Both writes below only feed future distillation runs — nothing in this response depends on
  // them, so they run after the response is sent (Next.js's after()) instead of blocking it.
  // Promise.allSettled (not Promise.all) so one write's failure doesn't stop the other from
  // completing, and both failures get logged rather than swallowed just because they're no longer
  // on the request's critical path.
  after(async () => {
    const results = await Promise.allSettled([
      recordComparisonRunEvent(userId, accountMemories, category_deltas.length, validIds),
      recordCategorySpendSnapshots(userId, accountMemories),
    ])
    const contexts = ["compare.recordComparisonRunEvent", "compare.recordCategorySpendSnapshots"]
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        logError({ context: contexts[i], error: result.reason, userId, accountIds: validIds })
      }
    })
  })

  return Response.json({
    accounts: accountMemories.map((a) => ({
      account_id: a.account_id,
      label: a.label,
      recent_events: a.episodic_events,
    })),
    category_deltas,
    // category_deltas' running_mean values are a distilled average of per-category snapshots —
    // each one itself a rolling CATEGORY_SNAPSHOT_LOOKBACK_DAYS-day total (see
    // recordCategorySpendSnapshots above), sampled once per throttle-respecting Compare session.
    // There's no single fixed calendar period to report the way Macro's reference_month is one —
    // this is the honest equivalent: what window each individual data point covers.
    category_baseline_window_days: CATEGORY_SNAPSHOT_LOOKBACK_DAYS,
    shared_categories: shared,
    unique_categories: unique_to,
    comparison_snapshots: comparisonSnapshots,
  })
}
