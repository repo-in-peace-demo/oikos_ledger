"use client"

import { useEffect, useState, useCallback } from "react"
import { Mic, MicOff, X, ChevronDown, ChevronUp, Info } from "lucide-react"
import { useAccounts } from "@/components/accounts/AccountsContext"
import { useRealtimeVoiceSession } from "@/lib/voice/useRealtimeVoiceSession"
import { RecommendationCard } from "./RecommendationCard"

const VOICE_ENABLED = process.env.NEXT_PUBLIC_VOICE_ENABLED === "true"

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

function getCached(accountId: string): RecommendationsResponse | null {
  try {
    const raw = sessionStorage.getItem(`recs_cache_${accountId}`)
    if (!raw) return null
    const { data, ts } = JSON.parse(raw)
    if (Date.now() - ts > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function setCache(accountId: string, data: RecommendationsResponse) {
  try {
    sessionStorage.setItem(
      `recs_cache_${accountId}`,
      JSON.stringify({ data, ts: Date.now() })
    )
  } catch {}
}

interface Recommendation {
  category: string
  baseline_monthly: number
  current_spend: number
  projected_spend: number
  variance: number
  top_merchants: string[]
  day_of_month: number
  days_in_month: number
  is_stale: boolean
  insight: string
  impact: string
  action: string
  is_positive: boolean
}

interface CategoryBreakdown {
  category: string
  baseline_monthly: number
  current_spend: number
  projected_spend: number
  saving: number
}

interface RecommendationsResponse {
  recommendations: Recommendation[]
  positive: boolean
  total_savings: number
  message: string
  current_month?: string
  analysis_month?: string
  is_stale?: boolean
  category_breakdown?: CategoryBreakdown[]
  insufficient_data?: boolean
  baseline_months_available?: number
  warning?: string | null
}

interface RecommendationsPanelProps {
  firstName?: string
}

export function RecommendationsPanel({ firstName }: RecommendationsPanelProps) {
  const { selectedAccountId, setSelectedAccountId, accounts } = useAccounts()
  const [data, setData] = useState<RecommendationsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showExplanation, setShowExplanation] = useState(false)

  // The entire recommendations dataset + a guardrail-heavy system prompt (investment/tax/product-
  // advice prohibitions) is baked into the session's instructions once, at connect time — there is
  // no per-question tool call for content (only end_conversation is a defined tool), unlike
  // Compare/Macro's ask_* tool pattern. Recomputed on every render so a connect that happens after
  // data finishes loading picks up the real data (see useRealtimeVoiceSession's optionsRef, which
  // reads the latest options on every render, not just at mount).
  const voiceSystemPrompt = data
    ? `You are a warm, knowledgeable personal finance assistant for Oikos Ledger, an AI-powered personal finance app.

## Your role
Help the user understand their spending patterns, explain the recommendations shown on screen, and suggest practical behavioural changes they can make.

## User's current spending data
${JSON.stringify(data.recommendations.map(r => ({
  category: r.category,
  baseline_monthly: Math.round(r.baseline_monthly),
  current_spend: Math.round(r.current_spend),
  projected_spend: Math.round(r.projected_spend),
  variance: Math.round(r.variance),
  top_merchants: r.top_merchants,
  insight: r.insight,
  action: r.action,
})), null, 2)}
${data.positive
  ? `The user is on track across all discretionary categories and projected to save ₹${Math.round(data.total_savings).toLocaleString("en-IN")} this month.`
  : ""}
${data.is_stale
  ? `Note: This data is from ${data.analysis_month}, the most recent uploaded month. The current month has no data yet.`
  : ""}

## What you CAN do
- Explain overspending patterns in simple, conversational language
- Reference specific merchants from the data to make advice concrete
- Suggest practical day-to-day behavioural changes (e.g. reducing delivery orders, batch grocery shopping)
- Help the user understand how their baseline and projections are calculated
- Answer general questions about budgeting habits and spending hygiene
- Provide positive reinforcement when the user is on track

## What you MUST NOT do
- Recommend specific stocks, mutual funds, ETFs, or any securities by name
- Give tax advice, ITR filing guidance, or Section 80C/80D recommendations
- Recommend specific banks, credit cards, insurance products, or financial apps
- Ask for or repeat any account numbers, card details, or sensitive financial information
- Claim to be a certified financial advisor, SEBI-registered advisor, or chartered accountant
- Discuss topics unrelated to the user's personal spending and budgeting shown in this data
- Make guarantees about financial outcomes

## Guardrails
- If asked for investment advice, say: "I can help with your spending patterns, but for investment decisions please consult a SEBI-registered financial advisor."
- If asked for tax advice, say: "For tax-related questions, I'd recommend speaking with a chartered accountant."
- If asked about anything outside personal spending and budgeting, politely redirect to the spending data shown.
- Always clarify you are an AI assistant, not a human advisor, if directly asked.
- Keep all amounts in Indian Rupee (₹).
- Keep responses concise and conversational — this is a voice interaction.
- When speaking monetary amounts, percentages, and other numeric figures, pronounce them the way a person would say them naturally in conversation (e.g. "seven hundred forty-nine thousand rupees", not digit-by-digit), not written/formatted the way they'd appear on screen.`
    : `You are a personal finance assistant for Oikos Ledger.
The user's recommendations are still loading.
Only answer general budgeting and spending habit questions until the data is available.
Do not give investment, tax, or product-specific advice.
Keep responses brief — this is a voice interaction.
When speaking monetary amounts, percentages, and other numeric figures, pronounce them the way a person would say them naturally in conversation (e.g. "seven hundred forty-nine thousand rupees", not digit-by-digit), not written/formatted the way they'd appear on screen.`

  const session = useRealtimeVoiceSession({
    instructions: voiceSystemPrompt,
    greetingInstructions: `Greet the user warmly by name in exactly one brief sentence. Address them as "${firstName || "there"}". Mention you can help them understand their spending recommendations.`,
    // Gentler VAD tuning than Insights/Compare/Macro's shared defaults — a deliberate, pre-existing
    // difference for this page, not something to silently flatten when adopting the shared hook.
    vad: { threshold: 0.5, prefixPaddingMs: 300, silenceDurationMs: 800 },
  })
  const { isVoiceConnected, voiceStatus, connectVoice, disconnectVoice } = session

  const fetchRecommendations = useCallback(async (force = false) => {
    if (!selectedAccountId) return

    // Show cached data immediately if available and not forcing
    if (!force) {
      const cached = getCached(selectedAccountId)
      if (cached) {
        setData(cached)
        setIsLoading(false)
        // Revalidate in background
        fetch("/api/recommendations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: selectedAccountId }),
        })
          .then((r) => r.json())
          .then((json) => {
            setData(json)
            console.log("recommendations data cached:", json)
            setCache(selectedAccountId, json)
          })
          .catch(() => {}) // silent — cached data already shown
        return
      }
    }

    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: selectedAccountId }),
      })
      if (!res.ok) throw new Error("Failed to fetch recommendations")
      const json = await res.json()
      setData(json)
      console.log("recommendations data:", json)
      setCache(selectedAccountId, json)
    } catch {
      setError("Failed to load recommendations. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    fetchRecommendations()
  }, [fetchRecommendations])

  // On mount, immediately show cached data if available
  // This prevents loading flash on tab switch
  useEffect(() => {
    if (!selectedAccountId) return
    const cached = getCached(selectedAccountId)
    if (cached) {
      setData(cached)
      setIsLoading(false)
    }
  }, [selectedAccountId])

  if (!selectedAccountId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select an account to view recommendations.
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-background px-6 py-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold">Recommendations</h2>
          <p className="text-xs text-muted-foreground">
            Based on your rolling 3-month spending baseline
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (selectedAccountId) {
                try { sessionStorage.removeItem(`recs_cache_${selectedAccountId}`) } catch {}
              }
              fetchRecommendations(true)
            }}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Refresh
          </button>
          <select
            value={selectedAccountId ?? ""}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.bank_name} · {a.account_nickname ?? a.account_type}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowExplanation(prev => !prev)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Info className="h-3.5 w-3.5" />
            How this works
            {showExplanation
              ? <ChevronUp className="h-3 w-3" />
              : <ChevronDown className="h-3 w-3" />}
          </button>
          <button
            onClick={isVoiceConnected ? disconnectVoice : connectVoice}
            disabled={!isVoiceConnected && !VOICE_ENABLED}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isVoiceConnected
                ? "bg-red-100 text-red-700 hover:bg-red-200"
                : voiceStatus === "connecting"
                ? "bg-amber-100 text-amber-700 animate-pulse"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
            title={!VOICE_ENABLED ? "Voice requires OpenAI credits" : undefined}
          >
            {isVoiceConnected ? (
              <><MicOff className="h-3.5 w-3.5" /> End voice</>
            ) : (
              <><Mic className="h-3.5 w-3.5" /> Ask advisor</>
            )}
          </button>
        </div>
      </div>

      {/* How this works — collapsible */}
      {showExplanation && (
        <div className="border-b bg-slate-50 px-6 py-4 text-xs text-slate-600 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <p className="font-semibold text-slate-700 flex items-center gap-1">
                📊 Rolling Baseline
              </p>
              <p className="text-muted-foreground leading-relaxed">
                We compute your average monthly spend per category
                over the last 3 months of uploaded statements.
                This becomes your personal benchmark — not a generic
                national average.
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-semibold text-slate-700 flex items-center gap-1">
                📈 Pacing Projection
              </p>
              <p className="text-muted-foreground leading-relaxed">
                We use linear extrapolation: projected spend =
                current spend ÷ (days elapsed ÷ days in month).
                For example, ₹6,000 spent in 15 of 30 days gives
                ₹6,000 ÷ 0.5 = ₹12,000 projected. This assumes a
                uniform daily spend rate — a simplification, but one
                that is transparent and consistent with how leading
                personal finance apps like Copilot and Monarch Money
                work. Spending that is front-loaded (e.g. a large
                purchase on day 1) will make projections look worse
                than they end up being.
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-semibold text-slate-700 flex items-center gap-1">
                🎯 What We Flag
              </p>
              <p className="text-muted-foreground leading-relaxed">
                We only flag discretionary categories where your
                behaviour can change the outcome — Food, Shopping,
                Entertainment, Transport, Travel, and Health (pharmacy
                and wellness). Fixed costs like rent and insurance are
                excluded. Health is flagged only if spending exceeds
                1.5× your baseline, and Utilities only at 2× baseline,
                since both can spike for legitimate reasons.
              </p>
            </div>
          </div>
          <div className="border-t pt-3 flex items-start gap-2">
            <span className="text-amber-500">⚠️</span>
            <p className="text-muted-foreground leading-relaxed">
              Recommendations improve with more data. Upload at least
              3 months of statements for the most accurate baseline.
              The engine uses your most recently uploaded month as
              the "current" period — upload your latest statement
              regularly for up-to-date insights.
            </p>
          </div>
        </div>
      )}

      {/* Voice status bar */}
      {isVoiceConnected && (
        <div className={`flex items-center justify-between px-6 py-2 shrink-0 border-b ${
          voiceStatus === "connecting"
            ? "bg-amber-50 border-amber-200"
            : voiceStatus === "speaking"
            ? "bg-blue-50 border-blue-200"
            : "bg-green-50 border-green-200"
        }`}>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${
              voiceStatus === "connecting" ? "bg-amber-400"
              : voiceStatus === "speaking" ? "bg-blue-500 animate-pulse"
              : "bg-green-500 animate-pulse"
            }`} />
            <span className={`text-xs ${
              voiceStatus === "connecting" ? "text-amber-700"
              : voiceStatus === "speaking" ? "text-blue-700"
              : "text-green-700"
            }`}>
              {voiceStatus === "connecting" ? "Connecting..."
              : voiceStatus === "speaking" ? "Speaking"
              : "Listening — ask about your recommendations"}
            </span>
          </div>
          <button
            onClick={disconnectVoice}
            className="flex items-center gap-1 text-xs text-destructive hover:text-destructive/80 transition-colors"
          >
            <X className="h-3 w-3" />
            Disconnect
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-48 rounded-xl border bg-slate-50 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="flex h-32 items-center justify-center text-sm text-destructive gap-2">
            {error}
            <button onClick={() => fetchRecommendations(true)} className="underline">
              Retry
            </button>
          </div>
        ) : data?.insufficient_data ? (
          <div className="flex flex-col h-48 items-center justify-center gap-3 text-center px-8">
            <p className="text-3xl">📂</p>
            <p className="font-semibold text-slate-700">Not enough data</p>
            <p className="text-sm text-muted-foreground">
              Upload at least one month of bank statements before your most
              recent month to generate recommendations. We need a baseline
              to compare against.
            </p>
          </div>
        ) : data?.positive ? (
          <div className="space-y-4">
            {data.warning && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <span className="text-amber-500 shrink-0">⚠️</span>
                <p className="text-xs text-amber-700">{data.warning}</p>
              </div>
            )}
            {data.is_stale && (
              <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                <span className="text-blue-500 shrink-0">🕐</span>
                <p className="text-xs text-blue-700">
                  No transactions uploaded for {data.current_month}. Showing analysis for your most recent uploaded month ({data.analysis_month}).
                </p>
              </div>
            )}
            <div className="rounded-xl border bg-emerald-50 border-emerald-100 p-6 text-center space-y-2">
              <p className="text-3xl">🎉</p>
              <p className="font-semibold text-emerald-800">Spotless Track Record</p>
              <p className="text-sm text-emerald-700">{data.message}</p>
            </div>

            {data.category_breakdown && data.category_breakdown.length > 0 && (
              <div className="rounded-xl border bg-card p-5 space-y-3">
                <p className="text-sm font-semibold text-slate-700">Category breakdown</p>
                <div className="space-y-2">
                  {data.category_breakdown.map((cat) => {
                    const CATEGORY_EMOJI: Record<string, string> = {
                      Food: "🍔", Shopping: "🛍️", Entertainment: "🎬",
                      Transport: "🚗", Travel: "✈️", Utilities: "⚡", Health: "💊",
                    }
                    const emoji = CATEGORY_EMOJI[cat.category] ?? "📊"
                    const underPercent = cat.baseline_monthly > 0
                      ? Math.round((cat.saving / cat.baseline_monthly) * 100)
                      : 0
                    return (
                      <div key={cat.category} className="flex items-center gap-3">
                        <span className="text-base w-6 text-center">{emoji}</span>
                        <div className="flex-1">
                          <div className="flex justify-between text-xs mb-0.5">
                            <span className="font-medium text-slate-700">{cat.category}</span>
                            <span className="text-emerald-600 font-medium">
                              {cat.saving > 0
                                ? `₹${cat.saving.toLocaleString("en-IN")} under`
                                : "On track"}
                            </span>
                          </div>
                          <div className="relative h-1.5 rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-emerald-400 transition-all"
                              style={{
                                width: `${Math.min(
                                  Math.round((cat.projected_spend / cat.baseline_monthly) * 100),
                                  100
                                )}%`,
                              }}
                            />
                          </div>
                          <div className="flex justify-between text-xs text-muted-foreground mt-0.5">
                            <span>Projected ₹{cat.projected_spend.toLocaleString("en-IN")}</span>
                            <span>Baseline ₹{cat.baseline_monthly.toLocaleString("en-IN")}</span>
                          </div>
                        </div>
                        {underPercent > 0 && (
                          <span className="text-xs font-medium text-emerald-600 shrink-0">
                            -{underPercent}%
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ) : data?.recommendations.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground text-center">
            Not enough data to generate recommendations yet.
            <br />
            Upload at least 3 months of statements.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Overspending cards */}
            {data?.recommendations.map((rec) => (
              <RecommendationCard key={rec.category} {...rec} />
            ))}

            {/* Savings breakdown — shown when some categories are under baseline */}
            {data?.category_breakdown && data.category_breakdown.length > 0 && (
              <div className="rounded-xl border bg-card p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">✅</span>
                  <p className="text-sm font-semibold text-slate-700">
                    Where you&apos;re doing well
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">{data.message}</p>
                <div className="space-y-2">
                  {data.category_breakdown.map((cat) => {
                    const CATEGORY_EMOJI: Record<string, string> = {
                      Food: "🍔", Shopping: "🛍️", Entertainment: "🎬",
                      Transport: "🚗", Travel: "✈️", Utilities: "⚡", Health: "💊",
                    }
                    const emoji = CATEGORY_EMOJI[cat.category] ?? "📊"
                    const underPercent = cat.baseline_monthly > 0
                      ? Math.round((cat.saving / cat.baseline_monthly) * 100)
                      : 0
                    return (
                      <div key={cat.category} className="flex items-center gap-3">
                        <span className="text-base w-6 text-center">{emoji}</span>
                        <div className="flex-1">
                          <div className="flex justify-between text-xs mb-0.5">
                            <span className="font-medium text-slate-700">{cat.category}</span>
                            <span className="text-emerald-600 font-medium">
                              ₹{cat.saving.toLocaleString("en-IN")} under baseline
                            </span>
                          </div>
                          <div className="relative h-1.5 rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-emerald-400 transition-all"
                              style={{
                                width: `${Math.min(
                                  Math.round((cat.projected_spend / cat.baseline_monthly) * 100),
                                  100
                                )}%`,
                              }}
                            />
                          </div>
                          <div className="flex justify-between text-xs text-muted-foreground mt-0.5">
                            <span>Projected ₹{cat.projected_spend.toLocaleString("en-IN")}</span>
                            <span>Baseline ₹{cat.baseline_monthly.toLocaleString("en-IN")}</span>
                          </div>
                        </div>
                        {underPercent > 0 && (
                          <span className="text-xs font-medium text-emerald-600 shrink-0">
                            -{underPercent}%
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
