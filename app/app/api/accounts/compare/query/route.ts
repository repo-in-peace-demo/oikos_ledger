// Narrowly-scoped voice/text query handler for the Compare page — NOT an extension of the
// Insights advisor's agent (app/app/api/insights/query/route.ts). Insights answers open-ended
// questions about a user's finances via NL->SQL against live transaction data; this handler only
// ever talks about what a single Compare result already contains (category spend deltas,
// shared/unique categories, comparison_snapshot facts and their confidence). There is no SQL
// generation or tool-calling loop for the table-shaped data (category_deltas, shared/unique
// categories) since the caller already has it — but confidence-scored memory
// (comparison_snapshot facts) is NOT taken from the caller. See below.
//
// CONFIRMED BUG (fixed previously): an earlier version of this route trusted a
// `comparison_snapshots` field inside the client-forwarded compare_data JSON instead of querying
// semantic_facts itself. Live testing showed "what does the app recall?" answered from raw
// category totals, not confidence-aware memory.
//
// CONFIRMED GAP (fixed here): the fix for the bug above then ran its own fresh, uncached MCP query
// on every single question — bypassing the marker-based cache already proven for this exact query
// shape on the Compare page itself (app/app/api/accounts/compare/route.ts), worse for voice
// specifically given the Realtime API's sub-second response design goal (ADR 013). Both routes now
// import loadComparisonSnapshots from app/lib/compare/comparisonSnapshots.ts — one cached read
// path, not two independently-evolving copies of the same query. category_deltas/
// shared_categories/unique_categories are still taken from the client's compare_data — those are
// just the current table's computed values, not a "memory" claim, so caching them here separately
// wouldn't add anything the page's own cache doesn't already cover.
import { auth } from "@/auth"
import { loadComparisonSnapshots, type ComparisonSnapshotRow } from "@/lib/compare/comparisonSnapshots"
import { logError } from "@/lib/logger"
import OpenAI from "openai"

export const dynamic = "force-dynamic"

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
})

type ComparisonSnapshot = ComparisonSnapshotRow

type CategoryDelta = {
  category: string
  values: Record<string, number | null>
  delta: number | null
}

// Mirrors CompareResponse in app/components/analytics/ComparePanel.tsx — this is the exact
// payload the client already holds after calling POST /api/accounts/compare, passed straight
// through for the table-shaped fields only. `comparison_snapshots` on this type is accepted but
// deliberately never read — see the file header; kept in the type only so passing the whole
// CompareResponse object through from the client doesn't require the caller to strip a field.
type CompareData = {
  accounts: { account_id: string; label: string }[]
  category_deltas: CategoryDelta[]
  category_baseline_window_days: number
  shared_categories: string[]
  unique_categories: { account_id: string; categories: string[] }[]
  comparison_snapshots: ComparisonSnapshot[]
}

type Tier = "answer" | "redirect" | "reject"

// Mirrors distillation/config.py's settings.min_occurrences_for_trend — a Python-side constant
// this TS route can't import directly (separate runtime/deployment from the distillation Lambda).
// Duplicated-with-a-comment is the same cross-language pattern already used elsewhere in this
// codebase for values/strings shared between distiller.py and the Next.js app (e.g. the
// trend:comparison_snapshot fact_type string). Keep this in sync if that Python value changes —
// stated directly in the prompt below so the model has the real number instead of guessing or
// pointing at an unrelated fact's occurrence_count as if it illustrated the threshold.
const MIN_OCCURRENCES_FOR_TREND = 3

// The three-tier scope contract, enforced entirely through this system prompt — deliberately not
// a tool-calling agent (there's nothing to call for the table-shaped data; see file header). Tier
// "reject"'s tone mirrors the existing Insights voice advisor's own off-topic refusal
// (InsightsPanel.tsx's realtime session instructions: "I'm only able to help with your
// finances...") for a consistent posture across both voice assistants, adapted here to a second,
// narrower refusal tier ("redirect") that the Insights advisor doesn't need — Insights itself is
// the thing Compare's "redirect" tier points to.
//
// "answer" was widened (after live testing) to also cover mechanism/self-explanatory questions
// about how comparison_snapshot memory itself works — these are architecture questions about
// this exact page's feature, not general finance questions, so they stay in-scope rather than
// being redirected or rejected. The redirect/reject boundaries themselves are unchanged: general
// bank-statement questions, broader spending trends, and individual transaction/debit/credit
// queries still redirect to Insights; anything unrelated to finance still rejects.
const SYSTEM_PROMPT = `You are a narrowly-scoped voice assistant for the "Compare" page of \
Oikos Recall, a personal finance app. Compare lets a user compare two of their bank accounts \
side by side, and offers three distinct things: (1) category-level spend deltas between the two \
accounts, (2) which spending categories the two accounts share versus which are unique to one of \
them, and (3) a separate, growing memory of which account has consistently run higher in a \
shared category across repeated comparisons over time — each such memory fact carries a \
confidence level (tentative or confirmed) based on how many times it's been observed. Questions \
about how that memory mechanism itself works are also in scope — see point 4 below.

You will be given the user's question, the current Compare table's data (category_deltas, \
shared_categories, unique_categories), and this account pair's actual comparison_snapshot memory \
facts (each with category, description, occurrence_count, confidence_status), freshly queried \
from the database. These are two different things — always use the memory facts, never the raw \
table data, when the question is about what the app "remembers," "recalls," "has noticed," or \
about confidence/trends over time.

Decide which of exactly three tiers the question falls into, and respond with ONLY a JSON object \
of the shape {"tier": "answer" | "redirect" | "reject", "response": "..."} — no other text.

Keep "response" concise and conversational — this is spoken aloud, not read. Even when a \
question asks you to cover multiple things (e.g. "what else does this page talk about", which \
should still mention all three capabilities below), keep each one to a short phrase or sentence \
rather than a paragraph — a complete, brief answer is always better than a longer one that risks \
being cut off.

1. "answer" — the question is about what this Compare page itself offers:
   - Spend deltas or shared/unique categories: answer using ONLY the numbers in the provided \
table data — never invent a number that isn't there.
   - What the app remembers/recalls/has noticed, or confidence/trends over time: answer ONLY \
from the provided comparison_snapshot memory facts, never from the raw table data. If the \
question covers more than one category (e.g. "what have you noticed", "summarize everything"), \
use the pre-grouped "by which account is higher" structure and its category lists VERBATIM — do \
NOT read multiple facts' description text yourself and work out who's higher in which category; \
that grouping is computed for you precisely because reading several descriptions and mentally \
combining them is exactly where mistakes happen. If the question is about ONE specific category, \
you may read that single fact's own description/occurrence_count/confidence_status directly. \
Confidence phrasing is decided STRICTLY by each individual fact's own confidence_status field — \
"confirmed" is always stated with confidence, "tentative" is always visibly hedged ("I've only \
seen this once or twice so far, so take it with a grain of salt"). Never infer confidence from \
occurrence_count itself, and never compare one fact's occurrence_count against another fact's in \
the same response — a "confirmed" fact with occurrence_count 4 and a "confirmed" fact with \
occurrence_count 27 are BOTH stated with equal confidence; the exact count is supplementary \
detail, not something that downgrades the confidence framing on its own. HOWEVER, "supplementary" \
does not mean optional: when a group (same higher account) has more than one category, you MUST \
state EVERY category's own occurrence_count individually — never fold two or more categories \
into one undifferentiated list ("Axis has run higher in Other, Shopping, and Utilities") without \
each one's own count attached, even though they're all confirmed and all stated with equal \
confidence. Confirmed with confidence is Yes/No — that never depends on the count; the count \
itself must always be surfaced per category, one axis (confidence) never subsumes the other \
(the actual number of checks), because two categories that happen to share a higher account can \
still have wildly different amounts of evidence behind them (e.g. 8 checks vs. 31), and a listener \
has no way to tell that apart if the counts aren't spoken. Example tone, showing three confirmed \
facts in the same higher-account group with very different counts, each stated individually and \
all with equal confidence, alongside one genuinely tentative fact: "Axis has run higher than HDFC \
in Shopping for 27 straight checks, in Utilities for 31, and in Other for 8 — I'm confident about \
all three of those. Groceries I've only seen once so far, so take that with a grain of salt." If \
there are no memory facts yet, say plainly that nothing is confirmed yet rather than falling back \
to raw totals or inventing one.
   - What this page/feature can do ("what can this do", "what does this page talk about"): \
describe all three capabilities above — spend comparison, shared/unique categories, AND \
confidence-scored memory of which account has run higher over time — don't just say it compares \
two accounts.
   - How the comparison/memory mechanism itself works (episodic events, semantic facts, \
distillation, the confirmation threshold, decay): answer directly using these exact facts, never \
a guess, and never an unrelated fact's occurrence_count used as if it illustrated the threshold:
     * Every time these two accounts are compared, that single check is logged as an immutable \
"episodic event" — a permanent record of what was observed that one time.
     * A "semantic fact" (what's shown as a memory fact above) is the conclusion drawn once \
enough episodic events agree with each other — e.g. which account has run higher in a category, \
and for how many checks in a row.
     * "Distillation" is the scheduled background process that periodically reads the log of \
episodic events and either promotes a pattern to a semantic fact, updates an existing one, or \
lets a fact that hasn't been reinforced recently decay in relevance over time.
     * The confirmation threshold is a fixed number, not an estimate: a pattern needs to be \
observed ${MIN_OCCURRENCES_FOR_TREND} separate times before it's promoted from "tentative" to \
"confirmed". State this exact number directly whenever asked what the minimum/threshold is.
   If nothing in the provided data answers the question, say so plainly rather than guessing.

2. "redirect" — the question is financial but NOT specific to comparing these two accounts: \
individual transactions, statement details, spending trends, or anything else about the user's \
finances broadly (e.g. "what did I spend on Swiggy last month", "show me my balance trend"). Do \
not attempt to answer it yourself. Give a brief, friendly one-sentence redirect to the Insights \
page, where that kind of question is already handled.

3. "reject" — the question has nothing to do with bank statements or personal finance at all. \
Decline plainly and briefly, matching this tone: "I'm only able to help with comparing your \
accounts. Want to check a category or ask about one of your accounts?" Do not attempt to be \
helpful beyond that, even if the user insists or frames it as hypothetical.
   Exception: if the input is a brief personal/social remark rather than an actual off-topic \
question — correcting how they were addressed (e.g. their name), a greeting, a simple \
acknowledgment like "okay" or "thanks", or apologizing for talking over the assistant — still use \
tier "reject" (there is nothing to look up), but respond with a brief, warm acknowledgment instead \
of the fixed refusal above (apologize plainly if a name was wrong, otherwise just acknowledge it), \
then invite them back to the page's content.`

// Groups facts by which account is higher, computed from each fact's own account_id/
// compared_account_id/running_mean fields — never by reading and comparing multiple facts'
// free-text descriptions, which is what let a multi-category summary answer misattribute one
// category to the wrong account (confirmed live: "Axis has run higher... Utilities..." when the
// Utilities fact's own data said HDFC). running_mean is account_id's mean minus
// compared_account_id's — mirrors describe_comparison_snapshot's own higher/lower derivation
// exactly (distiller.py): account_id is higher when running_mean >= 0, compared_account_id
// otherwise.
function groupByHigherAccount(
  comparisonSnapshots: ComparisonSnapshot[],
  accounts: { account_id: string; label: string }[],
): { account_label: string; categories: { category: string; occurrence_count: number; confidence_status: string }[] }[] {
  const labelFor = (id: string) => accounts.find((a) => a.account_id === id)?.label ?? id
  const groups = new Map<string, { category: string; occurrence_count: number; confidence_status: string }[]>()

  for (const fact of comparisonSnapshots) {
    const higherAccountId = Number(fact.running_mean) >= 0 ? fact.account_id : fact.compared_account_id
    const label = labelFor(higherAccountId)
    const list = groups.get(label) ?? []
    list.push({
      category: fact.category,
      occurrence_count: fact.occurrence_count,
      confidence_status: fact.confidence_status,
    })
    groups.set(label, list)
  }

  return Array.from(groups.entries()).map(([account_label, categories]) => ({ account_label, categories }))
}

function buildUserContent(
  question: string,
  compareData: CompareData,
  comparisonSnapshots: ComparisonSnapshot[],
): string {
  const { comparison_snapshots: _ignored, ...tableData } = compareData
  const groupedByHigherAccount = groupByHigherAccount(comparisonSnapshots, compareData.accounts)
  return `Question: ${question}\n\n`
    + `Current Compare table data:\n${JSON.stringify(tableData, null, 2)}\n\n`
    + `Comparison memory facts (freshly queried, confidence-scored):\n`
    + `${JSON.stringify(comparisonSnapshots, null, 2)}\n\n`
    + `Pre-grouped by which account is higher (computed deterministically, not by you) — when \
answering a question covering more than one category, use this grouping and these category \
lists VERBATIM. Never re-derive who is higher in which category yourself by reading multiple \
facts' description text — read each fact's description only for a single specific category \
asked about directly. Each category entry below carries its OWN occurrence_count — when a group \
has more than one category, state every category's occurrence_count individually in your \
response; never name two or more categories together without each one's own count, even though \
they share the same higher account and the same confidence framing:\n`
    + `${JSON.stringify(groupedByHigherAccount, null, 2)}`
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
  const compareData = body?.compare_data as CompareData | undefined

  if (!question) {
    return Response.json({ error: "question is required" }, { status: 400 })
  }
  if (!compareData || !Array.isArray(compareData.accounts)) {
    return Response.json({ error: "compare_data is required" }, { status: 400 })
  }

  let comparisonSnapshots: ComparisonSnapshot[] = []
  try {
    const accountIds = compareData.accounts.map((a) => a.account_id)
    comparisonSnapshots = await loadComparisonSnapshots(session.user.id, accountIds)
  } catch (err) {
    // Degrades to "no memory facts yet" rather than failing the whole answer — same posture as
    // every other best-effort MCP read in this codebase (e.g. /api/macro's "MCP memory lookup
    // failed, degrading to indicators-only"). The model is still told explicitly (via the empty
    // array) not to fall back to raw totals when asked a memory question.
    logError({
      context: "compare.query.loadComparisonSnapshots",
      error: err,
      userId: session.user.id,
    })
  }

  // What was actually retrieved, before grouping/formatting for the model — lets a future
  // investigation directly compare "what the database returned" against "what got said" without
  // needing to manually query and cross-reference by hand (see the multi-category-summary
  // miscategorization bug this was added for).
  console.log(JSON.stringify({
    level: "info",
    timestamp: new Date().toISOString(),
    context: "compare.query.comparisonSnapshots",
    userId: session.user.id,
    question,
    facts: comparisonSnapshots.map((f) => ({
      category: f.category,
      account_id: f.account_id,
      compared_account_id: f.compared_account_id,
      running_mean: f.running_mean,
      occurrence_count: f.occurrence_count,
      confidence_status: f.confidence_status,
    })),
  }))

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      // Raised from 300 — a "describe all three capabilities" answer (see the "answer" tier's
      // "what this page/feature can do" bullet) can routinely need more than 300 tokens, and a
      // response cut off mid-sentence gets spoken back verbatim by the realtime voice model,
      // producing an incomplete-sounding reply. The brevity instruction above keeps genuinely
      // short answers short; this headroom is for the cases that legitimately cover more ground.
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(question, compareData, comparisonSnapshots) },
      ],
    })

    if (completion.choices[0]?.finish_reason === "length") {
      // Not fatal — still returns whatever text was generated — but worth surfacing, since a
      // truncated mid-sentence answer is a real UX problem for a voice response, not a cosmetic one.
      logError({
        context: "compare.query.truncated",
        error: new Error("Completion hit max_tokens before finishing — response may be cut off mid-sentence"),
        userId: session.user.id,
        question,
      })
    }

    const raw = completion.choices[0]?.message?.content ?? ""
    const result = parseTierResponse(raw)

    if (!result) {
      logError({
        context: "compare.query.parseTierResponse",
        error: new Error("Model response did not match the expected {tier, response} shape"),
        userId: session.user.id,
        rawResponse: raw,
      })
      // Degrade to a "redirect"-flavored safe default rather than a hard failure — same
      // "never a hard failure on this best-effort path" posture as the rest of the memory layer
      // (e.g. /api/macro's "MCP memory lookup failed, degrading to indicators-only").
      return Response.json({
        tier: "reject" as Tier,
        response: "Sorry, I couldn't quite work that one out — could you ask again?",
      })
    }

    return Response.json(result)
  } catch (err) {
    logError({
      context: "compare.query",
      error: err,
      userId: session.user.id,
      question,
    })
    return Response.json({ error: "Failed to answer question" }, { status: 502 })
  }
}
