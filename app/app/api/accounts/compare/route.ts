// Compares distilled memory (episodic_events + semantic_facts) across two or more of the user's accounts
import { auth } from "@/auth"
import { db } from "@/lib/db/client"
import { episodic_events } from "@/lib/db/schema"
import { getBankAccountsByUserId } from "@/lib/db/queries/bank_accounts"
import { generateEmbedding } from "@/lib/embeddings"
import { mcpSelectQuery } from "@/lib/mcp/client"

export const dynamic = "force-dynamic"

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

async function loadAccountMemory(userId: string, accountId: string): Promise<Omit<AccountMemory, "label">> {
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
  return { account_id: accountId, episodic_events: events, semantic_facts: facts }
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
    accountMemories = loaded.map((mem) => ({
      ...mem,
      label: userAccounts.find((a) => a.id === mem.account_id)?.account_nickname
        ?? userAccounts.find((a) => a.id === mem.account_id)?.bank_name
        ?? mem.account_id,
    }))
  } catch (err) {
    console.error("MCP memory lookup failed for compare:", err)
    return Response.json({ error: "Memory lookup failed" }, { status: 502 })
  }

  const category_deltas = buildCategoryDeltas(accountMemories)
  const { shared, unique_to } = buildFactOverlap(accountMemories)

  const summary = `Compared ${accountMemories.length} accounts (${accountMemories.map((a) => a.label).join(", ")}) `
    + `across ${category_deltas.length} categories with distilled baselines.`

  try {
    const embedding = await generateEmbedding(summary)
    await db.insert(episodic_events).values({
      user_id: userId,
      account_id: null, // spans multiple accounts — see metadata.account_ids
      event_type: "comparison_run",
      content: summary,
      embedding,
      metadata: { account_ids: validIds },
    })
  } catch (err) {
    console.error("Failed to record comparison_run episodic event:", err)
  }

  return Response.json({
    accounts: accountMemories.map((a) => ({
      account_id: a.account_id,
      label: a.label,
      recent_events: a.episodic_events,
    })),
    category_deltas,
    shared_categories: shared,
    unique_categories: unique_to,
  })
}
