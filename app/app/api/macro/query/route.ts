// Narrowly-scoped voice/text query handler for the Macro page — built directly against the
// pattern already proven (after several rounds of fixes) for Compare's equivalent feature; see
// app/components/analytics/CompareVoiceButton.tsx and app/app/api/accounts/compare/query/route.ts
// for the reference implementation this mirrors. Like Compare's handler, this is NOT an
// extension of the Insights advisor's agent (app/app/api/insights/query/route.ts) — different,
// narrower scope (answer/redirect/reject) rather than Insights' "answer anything about your
// finances" posture — and NOT a SQL/tool-calling loop, since the table-shaped content (indicators,
// synthesis, scenario slider) is already computed and handed over by the caller.
//
// Memory facts (trend:balance_snapshot, confidence-scored) are the one thing NOT taken from the
// caller — same reasoning as Compare's fix: the caller's data could be stale by the time a voice
// question is asked, and a confidence-aware "what has been noticed" answer needs the real thing,
// not a value that might already be superseded. This route fetches macro facts via
// loadMacroFacts — the SAME marker-based cached function the Macro page route uses (see
// app/lib/macro/balanceFacts.ts) — built shared from day one, unlike Compare's first pass, which
// bypassed its own page's cache and needed a follow-up fix.
import { auth } from "@/auth"
import { type MacroFactRow, loadMacroFacts } from "@/lib/macro/balanceFacts"
import { formatIndicatorValue } from "@/lib/macro/formatIndicator"
import { formatCurrency } from "@/lib/currency"
import { logError } from "@/lib/logger"
import OpenAI from "openai"

export const dynamic = "force-dynamic"

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
})

type MacroIndicator = {
  indicator: string
  period: string
  value: string
  source: string
}

type BalancesSummary = {
  state: "blended_clean" | "blended_with_caveat" | "not_blended"
  combined_balance: number | null
  reference_month: string | null
  recency_mismatch: boolean
  accounts: { account_id: string; label: string; closing_balance: number; as_of_month: string; excluded_from_blend: boolean }[]
  accounts_without_data: number
}

// The scenario slider (InvestmentScenarioSlider.tsx) is pure client-side "what if" state, never
// persisted or returned by GET /api/macro — the caller sends its current live values so a
// question like "what if I invested it at 8%" can be answered against what's actually on screen
// right now, not a default. See buildUserContent below for the (server-computed, not
// LLM-computed) net-benefit arithmetic derived from these two numbers plus the inflation rate.
type ScenarioState = {
  amount: number
  assumed_return: number
}

// Mirrors useMacro()'s return shape in app/lib/hooks/useMacro.ts — the exact data the client
// already holds after calling GET /api/macro, passed straight through for the table-shaped
// fields only. Memory facts are NOT read from this — see file header.
type MacroData = {
  indicators: MacroIndicator[]
  explanation: string | null
  balances: BalancesSummary
  currency: string
  gdp_per_capita_age_note: string | null
  repo_rate_unchanged_note: string | null
  scenario: ScenarioState
}

type Tier = "answer" | "redirect" | "reject"

// Mirrors distillation/config.py's settings.min_occurrences_for_trend — a Python-side constant
// this TS route can't import directly (separate runtime/deployment from the distillation Lambda).
// Duplicated-with-a-comment is the same cross-language pattern already used for Compare's voice
// handler and elsewhere in this codebase. Keep in sync if that Python value changes.
const MIN_OCCURRENCES_FOR_TREND = 3

function computeScenarioNetBenefit(macroData: MacroData): {
  inflation_rate: number | null
  net_annual_benefit: number | null
} {
  const inflation = macroData.indicators.find((i) => i.indicator === "inflation")
  const inflationRate = inflation ? Number(inflation.value) : null
  if (inflationRate == null || Number.isNaN(inflationRate)) {
    return { inflation_rate: null, net_annual_benefit: null }
  }
  const { amount, assumed_return } = macroData.scenario
  const netAnnualBenefit = amount * (assumed_return / 100) - amount * (inflationRate / 100)
  return { inflation_rate: inflationRate, net_annual_benefit: netAnnualBenefit }
}

// The three-tier scope contract, enforced entirely through this system prompt — deliberately not
// a tool-calling agent (there's nothing to call for the table-shaped data; see file header). Tier
// "reject"'s tone mirrors the existing Insights voice advisor's own off-topic refusal
// (InsightsPanel.tsx's realtime session instructions: "I'm only able to help with your
// finances...") for a consistent posture across all three voice assistants in this app.
//
// "answer" includes mechanism/self-explanatory questions about how comparison/memory itself
// works, same as Compare's widened scope — these are architecture questions about this exact
// page's feature, not general finance questions, so they stay in-scope rather than being
// redirected or rejected.
const SYSTEM_PROMPT = `You are a narrowly-scoped voice assistant for the "Macro" page of Oikos \
Recall, a personal finance app. Macro shows: (1) national economic indicators — GDP growth, \
inflation, GDP per capita, the RBI repo rate; (2) a personalized synthesis comparing those \
indicators against the user's own account balance (inflation's erosion of purchasing power, and \
GDP growth the user isn't participating in while cash sits idle); (3) a "what if you invested it \
instead" scenario slider the user controls (an amount and an assumed annual return); and (4) a \
separate, growing memory of the user's combined-balance trend over repeated visits — whether it's \
stayed flat, increased, or decreased — each such memory fact carries a confidence level \
(tentative or confirmed) based on how many times it's been observed. Questions about how that \
memory mechanism itself works are also in scope — see point 4 below.

You will be given the user's question, the current Macro page's data (indicators, the synthesis \
explanation, balances, the scenario slider's current amount/assumed return and its computed net \
benefit), and this user's actual trend:balance_snapshot memory facts (each with description, \
occurrence_count, confidence_status), freshly queried from the database. These are two different \
things — always use the memory facts, never a guess, when the question is about what the app \
"remembers," "recalls," "has noticed," or about confidence/trends over time.

Decide which of exactly three tiers the question falls into, and respond with ONLY a JSON object \
of the shape {"tier": "answer" | "redirect" | "reject", "response": "..."} — no other text.

Keep "response" concise and conversational — this is spoken aloud, not read. Even when a \
question asks you to cover multiple things (e.g. "what else does this page talk about", which \
should still mention all four capabilities below), keep each one to a short phrase or sentence \
rather than a paragraph — a complete, brief answer is always better than a longer one that risks \
being cut off.

1. "answer" — the question is about what this Macro page itself offers:
   - Indicator values (GDP growth, inflation, GDP per capita, repo rate): each indicator in the \
provided data includes a pre-formatted "display_value" string — always state that string \
verbatim, never reconstruct the number or its unit/currency symbol yourself. GDP per capita is a \
US-dollar figure from World Bank data ("$" — always, regardless of the user's own account \
currency shown elsewhere); GDP growth, inflation, food inflation, and the repo rate are all \
percentages ("%"). Never invent a number that isn't in the provided data, and never apply the \
user's own account currency (shown separately for balance/scenario figures) to GDP per capita or \
any percentage indicator.
   - The erosion/purchasing-power synthesis, or the GDP-vs-erosion comparison: answer using the \
provided explanation text and indicator values directly.
   - The scenario slider's what-if math, or the user's own account balance figures: these ARE in \
the user's own account currency (see the balances/scenario data's pre-formatted "_display" \
strings) — use those verbatim, never attempt your own arithmetic or currency conversion.
   - What the app remembers/recalls/has noticed about the user's balance trend, or confidence/ \
trends over time: answer ONLY from the provided memory facts, never invented. Confidence phrasing \
is decided STRICTLY by each individual fact's own confidence_status field — "confirmed" is always \
stated with confidence, "tentative" is always visibly hedged ("I've only seen this once or twice \
so far, so take it with a grain of salt"). Never infer confidence from occurrence_count itself, \
and never compare one fact's occurrence_count against another fact's if more than one is present \
— a "confirmed" fact with a low occurrence_count and one with a much higher count are BOTH stated \
with equal confidence; the exact count is supplementary detail, not something that downgrades the \
confidence framing on its own. If there are no memory facts yet, say plainly that nothing is \
confirmed yet rather than inventing one.
   - What this page/feature can do ("what can this do", "what does this page talk about"): \
describe all four capabilities above — indicators, personalized synthesis, the scenario slider, \
AND confidence-scored memory of the balance trend — don't just say it shows economic data.
   - How the comparison/memory mechanism itself works (episodic events, semantic facts, \
distillation, the confirmation threshold, decay): answer directly using these exact facts, never \
a guess, and never an unrelated fact's occurrence_count used as if it illustrated the threshold:
     * Every real visit to this page is logged as an immutable "episodic event" — a permanent \
record of the combined balance observed that one time.
     * A "semantic fact" (what's shown as a memory fact above) is the conclusion drawn once \
enough episodic events agree with each other — e.g. that the balance has consistently increased, \
and for how many checks in a row.
     * "Distillation" is the scheduled background process that periodically reads the log of \
episodic events and either promotes a pattern to a semantic fact, updates an existing one, or \
lets a fact that hasn't been reinforced recently decay in relevance over time.
     * The confirmation threshold is a fixed number, not an estimate: a pattern needs to be \
observed ${MIN_OCCURRENCES_FOR_TREND} separate times before it's promoted from "tentative" to \
"confirmed". State this exact number directly whenever asked what the minimum/threshold is.
   If nothing in the provided data answers the question, say so plainly rather than guessing.

2. "redirect" — the question is financial but NOT specific to Macro's own content: general bank \
statement questions, category-level spending trends, or individual transaction/debit/credit \
queries (e.g. "what did I spend on Swiggy last month", "show me my food spending trend"). Do not \
attempt to answer it yourself. Give a brief, friendly one-sentence redirect to the Insights page, \
where that kind of question is already handled.

3. "reject" — the question has nothing to do with finances at all. Decline plainly and briefly, \
matching this tone: "I'm only able to help with your economic context and balance trends. Want to \
check an indicator or your balance history?" Do not attempt to be helpful beyond that, even if the \
user insists or frames it as hypothetical.
   Exception: if the input is a brief personal/social remark rather than an actual off-topic \
question — correcting how they were addressed (e.g. their name), a greeting, a simple \
acknowledgment like "okay" or "thanks", or apologizing for talking over the assistant — still use \
tier "reject" (there is nothing to look up), but respond with a brief, warm acknowledgment instead \
of the fixed refusal above (apologize plainly if a name was wrong, otherwise just acknowledge it), \
then invite them back to the page's content.`

function buildUserContent(
  question: string,
  macroData: MacroData,
  facts: MacroFactRow[],
): string {
  const { scenario, balances, indicators, ...restPageData } = macroData
  const { inflation_rate, net_annual_benefit } = computeScenarioNetBenefit(macroData)

  // Pre-formatted with the correct unit/currency per indicator (GDP per capita is always $, the
  // rest are %) — the same formatIndicatorValue the visual card itself uses, so the model is never
  // left to reconstruct a symbol from a bare number and the user's own (unrelated) account
  // currency sitting elsewhere in this same payload. See lib/macro/formatIndicator.ts.
  const indicatorsWithDisplay = indicators.map((i) => ({
    ...i,
    display_value: formatIndicatorValue(i.indicator, i.value),
  }))

  // Balance figures ARE in the user's own account currency — pre-formatted the same way, so the
  // model relays a ready-made string instead of guessing which currency applies where.
  const balancesWithDisplay = {
    ...balances,
    combined_balance_display: balances.combined_balance != null
      ? formatCurrency(balances.combined_balance, macroData.currency)
      : null,
    accounts: balances.accounts.map((a) => ({
      ...a,
      closing_balance_display: formatCurrency(a.closing_balance, macroData.currency),
    })),
  }

  const pageData = { ...restPageData, indicators: indicatorsWithDisplay, balances: balancesWithDisplay }

  return `Question: ${question}\n\n`
    + `Current Macro page data:\n${JSON.stringify(pageData, null, 2)}\n\n`
    + `Scenario slider (current live values, server-computed net benefit, pre-formatted in the \
user's own account currency):\n`
    + `${JSON.stringify({
      ...scenario,
      inflation_rate,
      net_annual_benefit,
      amount_display: formatCurrency(scenario.amount, macroData.currency),
      net_annual_benefit_display: net_annual_benefit != null
        ? formatCurrency(net_annual_benefit, macroData.currency)
        : null,
    }, null, 2)}\n\n`
    + `Balance trend memory facts (freshly queried, confidence-scored):\n`
    + `${JSON.stringify(facts, null, 2)}`
}

function parseTierResponse(text: string): { tier: Tier; response: string } | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}") + 1
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end))
    if (
      (parsed.tier === "answer" || parsed.tier === "redirect" || parsed.tier === "reject")
      && typeof parsed.response === "string" && parsed.response.length > 0
    ) {
      return { tier: parsed.tier, response: parsed.response }
    }
    return null
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json()
  const question: string = typeof body?.question === "string" ? body.question.trim() : ""
  const macroData = body?.macro_data as MacroData | undefined

  if (!question) {
    return Response.json({ error: "question is required" }, { status: 400 })
  }
  if (!macroData || !Array.isArray(macroData.indicators)) {
    return Response.json({ error: "macro_data is required" }, { status: 400 })
  }

  let facts: MacroFactRow[] = []
  try {
    facts = await loadMacroFacts(session.user.id)
  } catch (err) {
    // Degrades to "no memory facts yet" rather than failing the whole answer — same posture as
    // every other best-effort MCP read in this codebase (e.g. this same route's own indicator
    // data, or Compare's equivalent handler).
    logError({
      context: "macro.query.loadMacroFacts",
      error: err,
      userId: session.user.id,
    })
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      // Raised from 300 — a "describe all four capabilities" answer (see the "answer" tier's
      // "what this page/feature can do" bullet) routinely needed more than 300 tokens, and a
      // response cut off mid-sentence gets spoken back verbatim by the realtime voice model,
      // producing an incomplete-sounding reply. The brevity instruction above keeps genuinely
      // short answers short; this headroom is for the cases that legitimately cover more ground.
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(question, macroData, facts) },
      ],
    })

    if (completion.choices[0]?.finish_reason === "length") {
      // Not fatal — still returns whatever text was generated — but worth surfacing, since a
      // truncated mid-sentence answer is a real UX problem for a voice response, not a cosmetic one.
      logError({
        context: "macro.query.truncated",
        error: new Error("Completion hit max_tokens before finishing — response may be cut off mid-sentence"),
        userId: session.user.id,
        question,
      })
    }

    const raw = completion.choices[0]?.message?.content ?? ""
    const result = parseTierResponse(raw)

    if (!result) {
      logError({
        context: "macro.query.parseTierResponse",
        error: new Error("Model response did not match the expected {tier, response} shape"),
        userId: session.user.id,
        rawResponse: raw,
      })
      return Response.json({
        tier: "reject" as Tier,
        response: "Sorry, I couldn't quite work that one out — could you ask again?",
      })
    }

    return Response.json(result)
  } catch (err) {
    logError({
      context: "macro.query",
      error: err,
      userId: session.user.id,
      question,
    })
    return Response.json({ error: "Failed to answer question" }, { status: 502 })
  }
}
