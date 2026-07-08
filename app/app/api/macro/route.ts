// Macro route handler — returns latest macro-economic indicators, distilled memory context,
// and a gap-aware blended balance figure across all of the user's accounts
import { auth } from "@/auth"
import { db } from "@/lib/db/client"
import { episodic_events } from "@/lib/db/schema"
import { getLatestMacroIndicators } from "@/lib/db/queries/macro"
import { getBankAccountsByUserId } from "@/lib/db/queries/bank_accounts"
import { getLatestAccountBalance } from "@/lib/db/queries/transactions"
import { generateEmbedding } from "@/lib/embeddings"
import { mcpSelectQuery } from "@/lib/mcp/client"

export const dynamic = "force-dynamic"

// How close an account's most-recent data month must be to the most recent one across all of
// the user's accounts (the reference month) to sum balances into one clean combined figure.
const BLEND_CLEAN_MONTH_THRESHOLD = 1
// Wider than that, but within this, still sum — the response flags recency_mismatch so the UI
// can show a caveat instead of presenting one unqualified number.
const BLEND_CAVEAT_MONTH_THRESHOLD = 3
// An account whose most recent data is older than this many months (relative to today, not the
// reference month — this is about whether the account itself has gone stale) is excluded from
// blending entirely. Its own figure is still shown, just not summed in.
const MAX_ACCOUNT_STALENESS_MONTHS = 6

type MacroIndicatorRow = {
  indicator: string
  period: string
  value: string
  source: string
}

type SemanticFactRow = {
  id: string
  fact_type: string
  category: string | null
  description: string
  relevance_score: number
  confidence_status: string
}

type BlendState = "blended_clean" | "blended_with_caveat" | "not_blended"

type AccountBalanceEntry = {
  account_id: string
  label: string
  closing_balance: number
  as_of_month: string
  excluded_from_blend: boolean
}

type BalancesSummary = {
  state: BlendState
  combined_balance: number | null
  reference_month: string | null
  recency_mismatch: boolean
  accounts: AccountBalanceEntry[]
  accounts_without_data: number
}

const INDICATOR_LABELS: Record<string, string> = {
  repo_rate: "RBI repo rate",
  inflation: "Inflation (CPI)",
  food_inflation: "Food inflation",
  gdp_growth: "GDP growth",
  gdp_per_capita: "GDP per capita",
}

// The four indicators macro_fetch.py actually populates (food_inflation is deliberately
// unmapped — see ingestion/sources/macro_fetch.py — so it's never "missing", just untracked).
const CORE_INDICATORS = ["gdp_growth", "gdp_per_capita", "inflation", "repo_rate"] as const

function buildExplanationKey(indicators: MacroIndicatorRow[]): string {
  return indicators
    .map((i) => `${i.indicator}:${i.period}`)
    .sort()
    .join(",")
}

function formatRupees(value: number): string {
  return `₹${Math.round(Math.abs(value)).toLocaleString("en-IN")}`
}

function missingIndicatorNote(indicators: MacroIndicatorRow[]): string | null {
  const present = new Set(indicators.map((i) => i.indicator))
  const missing = CORE_INDICATORS.filter((ind) => !present.has(ind))
  if (missing.length === 0) return null
  const labels = missing.map((ind) => INDICATOR_LABELS[ind] ?? ind)
  return `${labels.join(" and ")} ${missing.length === 1 ? "isn't" : "aren't"} available right now, so ${missing.length === 1 ? "it's" : "they're"} left out below.`
}

// Combines the inflation rate with the user's own balance into one concrete rupee figure —
// this is the "actual synthesis" step, not a restatement of the indicator card above it.
function inflationErosionSentence(
  inflationValue: number,
  balances: BalancesSummary,
  alreadyExplained: boolean,
): string {
  const lead = alreadyExplained
    ? "You've seen this inflation figure before — here's how it applies to your current balance:"
    : "Here's what this means for your cash:"

  if (balances.state === "not_blended") {
    if (balances.accounts.length === 0) {
      return `${lead} we don't have a balance yet to estimate inflation's impact on your cash — upload a statement to see this.`
    }
    const perAccount = balances.accounts.map((a) => {
      const annualErosion = a.closing_balance * (inflationValue / 100)
      const monthlyErosion = annualErosion / 12
      return `${a.label} (${formatRupees(a.closing_balance)} as of ${a.as_of_month}) is losing about `
        + `${formatRupees(annualErosion)}/year (~${formatRupees(monthlyErosion)}/month)`
    })
    return `${lead} your accounts' data is too spread out to combine into one figure, so here's inflation's `
      + `impact per account, assuming each stays in a low-interest account: ${perAccount.join("; ")}.`
  }

  if (balances.combined_balance == null) {
    return `${lead} we don't have a balance yet to estimate inflation's impact on your cash — upload a statement to see this.`
  }

  const annualErosion = balances.combined_balance * (inflationValue / 100)
  const monthlyErosion = annualErosion / 12
  const caveat = balances.state === "blended_with_caveat"
    ? " Note: your accounts' most recent data spans different months, so this figure may not reflect all accounts equally."
    : ""

  return `${lead} your combined balance of ${formatRupees(balances.combined_balance)} is losing about `
    + `${formatRupees(annualErosion)} a year (~${formatRupees(monthlyErosion)} a month) to inflation at `
    + `${inflationValue.toFixed(2)}%, assuming this stays in a low-interest account.${caveat}`
}

function composeMacroExplanation(
  indicators: MacroIndicatorRow[],
  facts: SemanticFactRow[],
  balances: BalancesSummary,
  alreadyExplained: boolean,
): string {
  const sentences: string[] = []

  const inflation = indicators.find((i) => i.indicator === "inflation")
  sentences.push(
    inflation
      ? inflationErosionSentence(Number(inflation.value), balances, alreadyExplained)
      : "Inflation data isn't available right now, so we can't estimate how it's affecting your cash.",
  )

  const missingNote = missingIndicatorNote(indicators)
  if (missingNote) sentences.push(missingNote)

  // GDP per capita and repo rate are deliberately excluded here — they're not part of this
  // comparison. If GDP growth is missing, this line is skipped entirely rather than left with a
  // gap; the erosion sentence above still stands on its own.
  const gdpGrowth = indicators.find((i) => i.indicator === "gdp_growth")
  if (inflation && gdpGrowth) {
    sentences.push(
      `The economy grew ${Number(gdpGrowth.value).toFixed(2)}% this period, but your idle cash `
      + `lost ${Number(inflation.value).toFixed(2)}% to inflation in real terms — growth you're `
      + `not participating in while it sits uninvested.`,
    )
  }

  // Only reference memory that's actually relevant (macro context or a balance trend) — if
  // neither exists yet, this loop contributes nothing and the text reads fine without it.
  for (const f of facts) {
    sentences.push(`Based on your history: ${f.description}`)
  }

  return sentences.join(" ")
}

// Absolute month distance between two "YYYY-MM" strings.
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number)
  const [by, bm] = b.split("-").map(Number)
  return Math.abs((ay - by) * 12 + (am - bm))
}

async function buildBalancesSummary(userId: string): Promise<BalancesSummary> {
  const accounts = await getBankAccountsByUserId(userId)

  const withBalances = await Promise.all(
    accounts.map(async (account) => {
      const balance = await getLatestAccountBalance(userId, account.id)
      return balance
        ? {
            account_id: account.id,
            label: account.account_nickname ?? account.bank_name,
            closing_balance: balance.closing_balance,
            as_of_month: balance.as_of_month,
          }
        : null
    }),
  )

  const accountsWithData = withBalances.filter((a): a is NonNullable<typeof a> => a !== null)
  const accountsWithoutData = withBalances.length - accountsWithData.length

  if (accountsWithData.length === 0) {
    return {
      state: "not_blended",
      combined_balance: null,
      reference_month: null,
      recency_mismatch: false,
      accounts: [],
      accounts_without_data: accountsWithoutData,
    }
  }

  // Reference point is the most recent as-of month across the user's own accounts — not
  // today's calendar date, since the user may not have uploaded anything recently at all.
  const referenceMonth = accountsWithData.reduce(
    (max, a) => (a.as_of_month > max ? a.as_of_month : max),
    accountsWithData[0].as_of_month,
  )

  const currentMonthKey = new Date().toISOString().slice(0, 7)

  const withStaleness = accountsWithData.map((a) => ({
    ...a,
    spread_from_reference: monthsBetween(a.as_of_month, referenceMonth),
    months_since_now: monthsBetween(a.as_of_month, currentMonthKey),
  }))

  const anyTooStale = withStaleness.some((a) => a.months_since_now > MAX_ACCOUNT_STALENESS_MONTHS)
  const maxSpread = Math.max(...withStaleness.map((a) => a.spread_from_reference))

  let state: BlendState
  let combinedBalance: number | null = null
  let recencyMismatch = false

  if (anyTooStale || maxSpread > BLEND_CAVEAT_MONTH_THRESHOLD) {
    state = "not_blended"
  } else if (maxSpread > BLEND_CLEAN_MONTH_THRESHOLD) {
    state = "blended_with_caveat"
    recencyMismatch = true
    combinedBalance = withStaleness.reduce((sum, a) => sum + a.closing_balance, 0)
  } else {
    state = "blended_clean"
    combinedBalance = withStaleness.reduce((sum, a) => sum + a.closing_balance, 0)
  }

  return {
    state,
    combined_balance: combinedBalance,
    reference_month: referenceMonth,
    recency_mismatch: recencyMismatch,
    accounts: withStaleness.map((a) => ({
      account_id: a.account_id,
      label: a.label,
      closing_balance: a.closing_balance,
      as_of_month: a.as_of_month,
      excluded_from_blend: a.months_since_now > MAX_ACCOUNT_STALENESS_MONTHS,
    })),
    accounts_without_data: accountsWithoutData,
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }
  const userId = session.user.id

  const balances = await buildBalancesSummary(userId)
  const indicators = await getLatestMacroIndicators() as MacroIndicatorRow[]
  const explanationKey = buildExplanationKey(indicators)

  // Two kinds of user-level memory are relevant to this synthesis: prior macro-impact facts,
  // and any distilled balance trend (e.g. "balance has been flat for N months") — both are
  // account_id IS NULL since they're about the user as a whole, not one account. If neither
  // exists yet (the common case today — nothing writes trend:balance_snapshot facts yet), the
  // query just returns empty and the synthesis reads naturally without forcing a reference.
  let facts: SemanticFactRow[] = []
  let alreadyExplained = false
  try {
    facts = await mcpSelectQuery<SemanticFactRow>(`
      SELECT id, fact_type, category, description, relevance_score, confidence_status
      FROM semantic_facts
      WHERE user_id = '${userId}'
        AND account_id IS NULL
        AND (fact_type = 'macro_impact' OR fact_type = 'trend:balance_snapshot')
        AND superseded_by IS NULL
      ORDER BY relevance_score DESC
      LIMIT 5
    `)

    const priorEvents = await mcpSelectQuery<{ id: string }>(`
      SELECT id FROM episodic_events
      WHERE user_id = '${userId}'
        AND event_type = 'macro_explanation'
        AND metadata->>'explanation_key' = '${explanationKey}'
      LIMIT 1
    `)
    alreadyExplained = priorEvents.length > 0
  } catch (err) {
    // Memory context is an enhancement, not a hard dependency — degrade to indicators-only
    // rather than failing the whole page if the Managed MCP Server is unreachable.
    console.error("MCP memory lookup failed, degrading to indicators-only:", err)
  }

  const explanation = composeMacroExplanation(indicators, facts, balances, alreadyExplained)

  if (!alreadyExplained) {
    try {
      const embedding = await generateEmbedding(explanation)
      await db.insert(episodic_events).values({
        user_id: userId,
        event_type: "macro_explanation",
        content: explanation,
        embedding,
        // combined_balance/balance_state/reference_month let the distillation job detect balance
        // trends without needing its own DB grant on bank_accounts/transactions — it only has
        // SELECT on episodic_events, so this is the only way it can see balance history at all.
        // See distillation/pipeline/distiller.py's BALANCE_TREND_FACT_TYPE.
        metadata: {
          explanation_key: explanationKey,
          combined_balance: balances.combined_balance,
          balance_state: balances.state,
          reference_month: balances.reference_month,
        },
      })
    } catch (err) {
      console.error("Failed to record macro_explanation episodic event:", err)
    }
  }

  return Response.json({
    indicators,
    facts,
    explanation,
    already_explained: alreadyExplained,
    balances,
  })
}
