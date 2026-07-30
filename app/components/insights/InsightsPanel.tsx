"use client"

import { useState, useRef, useEffect } from "react"
import {
  Mic, MicOff, Send, X, RotateCcw, CalendarDays,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAccounts } from "@/components/accounts/AccountsContext"
import { useRealtimeVoiceSession } from "@/lib/voice/useRealtimeVoiceSession"
import { TurnCard } from "./TurnCard"

export interface ChatTurn {
  id: string
  role: "user" | "assistant"
  content: string
  type?: "message" | "suggestions"
  suggestions?: { query_text: string; query_hash: string }[]
  cached?: boolean
  used_memory?: boolean
  sql?: string
  chart_type?: string
  results?: Record<string, unknown>[]
  intent_label?: string
  intent_description?: string
  row_count?: number
  timestamp: Date
}

interface InsightResult {
  type?: "message" | "suggestions"
  suggestions?: { query_text: string; query_hash: string }[]
  cached?: boolean
  used_memory?: boolean
  question: string
  intent: string
  intent_label: string
  intent_description: string
  is_custom: boolean
  sql: string
  results: Record<string, unknown>[]
  response: string
  chart_type: string
  row_count: number
}

const QUICK_QUESTIONS = [
  { id: "monthly_trend", label: "Monthly trend" },
  { id: "biggest_expenses", label: "Biggest expenses" },
  { id: "credits_vs_debits", label: "Credits vs Debits" },
  { id: "top_merchants", label: "Top merchants" },
  { id: "spending_by_category", label: "Spending by category" },
]

const VOICE_ENABLED = process.env.NEXT_PUBLIC_VOICE_ENABLED === "true"


interface InsightsPanelProps {
  firstName?: string
}

export function InsightsPanel({ firstName }: InsightsPanelProps) {
  const { selectedAccountId, setSelectedAccountId, accounts } = useAccounts()
  const [question, setQuestion] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")
  const [showDateFilter, setShowDateFilter] = useState(false)

  const chatBottomRef = useRef<HTMLDivElement>(null)
  const prevAccountId = useRef<string | null>(null)
  const turnsRef = useRef<ChatTurn[]>([])
  // Voice's spoken-response text is confirmed via a *separate* Realtime API event (the shared
  // hook's onAssistantTurn) from when the query_database tool result handleQuery resolves — this
  // carries used_memory from that tool result across to the text turn built from that later
  // event, since by then handleQuery's own return value (just a summary string, per the
  // voice-safety addendum) is no longer available. Cleared immediately after being consumed by
  // the next final_answer turn, so a later unrelated conversational reply (farewell, small talk)
  // never inherits a stale value from an earlier query.
  const lastUsedMemoryRef = useRef<boolean | undefined>(undefined)
  // Tracks which account_ids this mounted panel has already fired the prefetch warm-up for, so
  // switching back and forth between accounts (or an unrelated re-render) doesn't re-fire it.
  const prefetchedAccountIds = useRef<Set<string>>(new Set())

  // Scroll to bottom on new turns
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [turns])

  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  // Fire-and-forget cache/cluster warm-up (see the prefetch branch in
  // /api/insights/query/route.ts for the full rationale and its honest-scope caveat). Deliberately
  // does not block render, show a loading state, or surface its result anywhere — this exists
  // purely to move cold-start cost earlier than the user's first real question, on a best-effort
  // basis only.
  useEffect(() => {
    if (!selectedAccountId) return
    if (prefetchedAccountIds.current.has(selectedAccountId)) return
    prefetchedAccountIds.current.add(selectedAccountId)

    // Logged so it's observable (in the browser console, correlated against server logs by
    // timestamp) whether this actually finished before the user's first real question fired —
    // rather than inferred from whether that question happened to be fast or slow.
    const firedAt = Date.now()
    console.log(`[prefetch] fired for account ${selectedAccountId} at ${new Date(firedAt).toISOString()}`)
    fetch("/api/insights/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefetch: true, account_id: selectedAccountId }),
    }).then(() => {
      console.log(`[prefetch] completed for account ${selectedAccountId} in ${Date.now() - firedAt}ms`)
    }).catch(() => {
      // Best-effort only — nothing is watching this result, so a network failure here is not
      // worth surfacing anywhere beyond this log.
      console.log(`[prefetch] failed for account ${selectedAccountId} after ${Date.now() - firedAt}ms`)
    })
  }, [selectedAccountId])

  function buildHistory() {
    return turnsRef.current.map(t => ({
      role: t.role,
      content: t.role === "assistant" && t.intent_label
        ? `[${t.intent_label}] ${t.content}`
        : t.content,
    }))
  }

  function addTurn(turn: Omit<ChatTurn, "id" | "timestamp">) {
    setTurns(prev => [
      ...prev,
      { ...turn, id: crypto.randomUUID(), timestamp: new Date() },
    ])
  }

  function updateTurn(
    id: string,
    updates: Partial<Omit<ChatTurn, "id" | "timestamp">>,
  ) {
    setTurns(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t))
  }

  function appendToTurn(id: string, text: string) {
    setTurns(prev => prev.map(t =>
      t.id === id ? { ...t, content: t.content + text } : t
    ))
  }

  async function handleQuery(
    q?: string,
    intentId?: string,
    skipUserTurn = false,
    isVoice = false,
  ): Promise<string> {
    if (!selectedAccountId) return ""
    const queryText = q ?? question
    if (!queryText && !intentId) return ""

    setIsLoading(true)
    setError(null)
    setQuestion("")

    if (!skipUserTurn) {
      addTurn({ role: "user", content: queryText || intentId!, type: "message" })
    }

    try {
      const lastAssistantTurn = [...turns]
        .reverse()
        .find(t => t.role === "assistant")

      console.log("conversation history length:", buildHistory().length)

      // Extract the last active chart layout classification from history turns
      const currentUiChart = [...turns].reverse().find(t => t.chart_type)?.chart_type || "table";

      const res = await fetch("/api/insights/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          question: queryText,
          intent: intentId ?? null,
          account_id: selectedAccountId,
          conversation_history: buildHistory(),
          last_chart_type: lastAssistantTurn?.chart_type ?? null,
          last_results: lastAssistantTurn?.results ?? null,
          date_from: dateFrom || null,
          date_to: dateTo || null,
          is_voice: isVoice,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? "Query failed")
        if (isVoice) lastUsedMemoryRef.current = undefined
        return ""
      }

      const contentType = res.headers.get("content-type") ?? ""

      // Non-streaming: off-topic, display command, cache hit, suggestions
      if (contentType.includes("application/json")) {
        const data: InsightResult = await res.json()

        if (data.intent === "off_topic") {
          if (!isVoice) {
              addTurn({ role: "assistant", content: data.response, type: "message" })
            } else {
              // Doesn't carry memory grounding — clear any stale value from an earlier query so
              // the next voice text turn (built separately, from the shared hook's
              // onAssistantTurn) doesn't inherit it.
              lastUsedMemoryRef.current = undefined
            }
          // Don't add canned message — let voice model handle conversation naturally
          return data.response ?? ""
        }

        if (data.type === "suggestions") {
          if (!isVoice) {
            addTurn({
              role: "assistant",
              content: data.response,
              type: "suggestions",
              suggestions: data.suggestions,
            })
          } else {
            lastUsedMemoryRef.current = undefined
          }
          return data.response ?? ""
        }

        if (isVoice) {
          // Show data card but skip text bubble — model speaks the summary
          // Only add data card if there are actual results or SQL to show
          const hasData = data.results && data.results.length > 0
          const hasSql = !!data.sql
          if (hasData || hasSql) {
            addTurn({
              role: "assistant",
              content: "",
              type: "message",
              cached: data.cached,
              used_memory: data.used_memory,
              sql: data.sql,
              chart_type: data.chart_type,
              results: data.results,
              intent_label: data.intent_label,
              intent_description: data.intent_description,
              row_count: data.row_count,
            })
        }
        // Carried across to the text turn built later from the shared hook's onAssistantTurn —
        // see lastUsedMemoryRef's declaration for why this can't just be read off this response
        // object directly at that point.
        lastUsedMemoryRef.current = data.used_memory
        return data.response ?? ""
      }

        addTurn({
          role: "assistant",
          content: data.response,
          type: "message",
          cached: data.cached,
          used_memory: data.used_memory,
          sql: data.sql,
          chart_type: data.chart_type,
          results: data.results,
          intent_label: data.intent_label,
          intent_description: data.intent_description,
          row_count: data.row_count,
        })
        return data.response ?? ""
      }

      // Streaming SSE response
      const turnId = crypto.randomUUID()

      if (!isVoice) {
        setTurns(prev => [
          ...prev,
          {
            id: turnId,
            role: "assistant" as const,
            content: "",
            type: "message" as const,
            timestamp: new Date(),
          },
        ])
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let fullText = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const payload = line.slice(6).trim()
          if (payload === "[DONE]") break

          try {
            const parsed = JSON.parse(payload)

            if (parsed.type === "metadata") {
              if (isVoice) {
                setTurns(prev => [
                  ...prev,
                  {
                    id: turnId,
                    role: "assistant" as const,
                    content: "",
                    type: "message" as const,
                    timestamp: new Date(),
                    sql: parsed.sql,
                    chart_type: parsed.chart_type,
                    results: parsed.results,
                    intent_label: parsed.intent_label,
                    intent_description: parsed.intent_description,
                    row_count: parsed.row_count,
                    used_memory: parsed.used_memory,
                  },
                ])
                // Carried across to the text turn built later from the shared hook's
                // onAssistantTurn — see lastUsedMemoryRef's declaration for why.
                lastUsedMemoryRef.current = parsed.used_memory
              } else {
                updateTurn(turnId, {
                  sql: parsed.sql,
                  chart_type: parsed.chart_type,
                  results: parsed.results,
                  intent_label: parsed.intent_label,
                  intent_description: parsed.intent_description,
                  row_count: parsed.row_count,
                  used_memory: parsed.used_memory,
                })
              }
            } else if (parsed.type === "text") {
              fullText += parsed.text
              if (!isVoice) {
                appendToTurn(turnId, parsed.text)
              }
            } else if (parsed.type === "error") {
              setError(parsed.message)
            }
          } catch {
            // skip malformed chunks
          }
        }
      }

      return fullText
    } catch {
      setError("Network error. Please try again.")
      return ""
    } finally {
      setIsLoading(false)
    }
  }

  async function handleCachedQuery(queryHash: string, queryText: string) {
    if (!selectedAccountId) return

    setIsLoading(true)
    setError(null)

    addTurn({ role: "user", content: queryText, type: "message" })

    try {
      const res = await fetch("/api/insights/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query_hash: queryHash,
          account_id: selectedAccountId,
        }),
      })

      if (!res.ok) {
        setError("Failed to load cached result")
        return
      }

      const data: InsightResult = await res.json()
      addTurn({
        role: "assistant",
        content: data.response,
        type: "message",
        cached: data.cached,
        used_memory: data.used_memory,
        sql: data.sql,
        chart_type: data.chart_type,
        results: data.results,
        intent_label: data.intent_label,
        intent_description: data.intent_description,
        row_count: data.row_count,
      })
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  // The WebSocket/audio/turn-ordering mechanics live in the shared useRealtimeVoiceSession hook
  // (see app/lib/voice/useRealtimeVoiceSession.ts) — this component supplies what's page-specific
  // (the system prompt/scope, the query_database tool and its handler) and its own richer
  // chat-turn state (sql/chart-bearing data cards, sessionStorage persistence — none of which the
  // shared hook's own simple turn list knows about; onUserTurn/onAssistantTurn bridge into this
  // component's own addTurn instead of relying on the hook's built-in transcript rendering).
  //
  // Dropped versus the pre-migration implementation: the 500ms conversational-vs-tool-call
  // disambiguation timer. That timer existed only to decide *when* to add the user's turn, a
  // problem the shared hook's stable speech-start keying now solves directly — the user's turn is
  // always added as soon as transcription completes, whether or not a tool call follows, so there
  // is no longer anything to disambiguate.
  const session = useRealtimeVoiceSession({
    instructions: `You are a personal finance assistant for Oikos Ledger. You ONLY discuss topics related to the user's personal finances — transactions, spending, income, merchants, categories, budgets, and account balances. If the user asks about ANYTHING else (technology, science, sports, cooking, general knowledge, coding, data structures, or any non-finance topic), respond with exactly: "I'm only able to help with your finances. Want to check your spending, transactions, or trends?" Do not answer off-topic questions under any circumstances, even if the user insists or frames them as hypothetical. When calling query_database, always include the full context in the question — especially date ranges, categories, and merchants from the current conversation. Never send a vague question like "plot by day" without specifying which time period. Example: if the user previously asked about March and April food spending and now says "by day", send: "Plot my food expenses by day for March and April 2026." When speaking monetary amounts, percentages, and other numeric figures, pronounce them the way a person would say them naturally in conversation (e.g. "seven hundred forty-nine thousand rupees", not digit-by-digit), not written/formatted the way they'd appear on screen.`,
    greetingInstructions: `Greet the user warmly by name in exactly one brief sentence. Address them as "${firstName || "there"}". Keep it short and friendly.`,
    tools: [
      {
        name: "query_database",
        description: `Query the user's financial transaction database and display the results as a chart or table in the app UI. Use this tool for ANY question about the user's finances including spending, income, merchants, categories, trends, and balances. Also use this tool when the user asks to plot, graph, chart, or visualize any financial data — the app will automatically render the appropriate chart type from the query results. Never say you cannot render a chart; always call this tool instead.`,
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The raw natural language financial question from the user. Do NOT expand categories or ask for currency formatting in this string. Keep it focused exactly on what the user asked.",
            },
          },
          required: ["question"],
        },
      },
    ],
    onToolCall: async (_name, args, rawTranscript) => {
      const reformulated = (args.question as string | undefined)?.trim()
      if (!reformulated) {
        console.warn("Tool call returned empty/missing question, falling back to raw transcript")
      }
      // Send the model's reformulated question, not the raw transcript — the model resolves
      // follow-ups/category context (e.g. "yes, check April" -> "How much did I spend on food in
      // April 2026?") using its own conversation context, which the raw transcript alone doesn't
      // carry.
      const queryQuestion = reformulated || rawTranscript
      return await handleQuery(queryQuestion, undefined, true, true)
    },
    onUserTurn: (text) => {
      addTurn({ role: "user", content: text, type: "message" })
      setQuestion("")
    },
    onAssistantTurn: (text) => {
      addTurn({
        role: "assistant",
        content: text,
        type: "message",
        used_memory: lastUsedMemoryRef.current,
      })
      // Consume once — an unrelated conversational turn after this (farewell, small talk)
      // shouldn't inherit this query's memory-grounding signal.
      lastUsedMemoryRef.current = undefined
    },
    onSpeechStarted: () => setQuestion(""),
    onUserTranscriptDelta: (delta) => setQuestion(prev => prev + delta),
  })
  const { isVoiceConnected, voiceStatus, connectVoice, disconnectVoice } = session

  // Consolidated account change + persistence effect
  useEffect(() => {
    if (!selectedAccountId) return

    // Account switched — reset everything
    if (prevAccountId.current && prevAccountId.current !== selectedAccountId) {
      setTurns([])
      setError(null)
      setQuestion("")
      setDateFrom("")
      setDateTo("")
      setShowDateFilter(false)
      disconnectVoice()
      prevAccountId.current = selectedAccountId

      // Restore turns for the new account from sessionStorage
      const storedTurns = sessionStorage.getItem(
        `insights_turns_${selectedAccountId}`
      )
      if (storedTurns) {
        try {
          const parsed = JSON.parse(storedTurns) as ChatTurn[]
          setTurns(parsed.map(t => ({ ...t, timestamp: new Date(t.timestamp) })))
        } catch {
          sessionStorage.removeItem(`insights_turns_${selectedAccountId}`)
          setTurns([])
        }
      } else {
        setTurns([])
      }

      // Restore date filter for new account
      const storedFilter = sessionStorage.getItem(
        `insights_filter_${selectedAccountId}`
      )
      if (storedFilter) {
        try {
          const { dateFrom: df, dateTo: dt, showDateFilter: show } =
            JSON.parse(storedFilter)
          if (df) setDateFrom(df)
          if (dt) setDateTo(dt)
          if (show) setShowDateFilter(show)
        } catch {
          sessionStorage.removeItem(`insights_filter_${selectedAccountId}`)
        }
      }
      return
    }

    // First load for this account — restore from sessionStorage
    if (prevAccountId.current === null) {
      prevAccountId.current = selectedAccountId

      // Restore turns
      const storedTurns = sessionStorage.getItem(`insights_turns_${selectedAccountId}`)
      if (storedTurns) {
        try {
          const parsed = JSON.parse(storedTurns) as ChatTurn[]
          setTurns(parsed.map(t => ({ ...t, timestamp: new Date(t.timestamp) })))
        } catch {
          sessionStorage.removeItem(`insights_turns_${selectedAccountId}`)
        }
      }

      // Restore date filter
      const storedFilter = sessionStorage.getItem(`insights_filter_${selectedAccountId}`)
      if (storedFilter) {
        try {
          const { dateFrom: df, dateTo: dt, showDateFilter: show } = JSON.parse(storedFilter)
          if (df) setDateFrom(df)
          if (dt) setDateTo(dt)
          if (show) setShowDateFilter(show)
        } catch {
          sessionStorage.removeItem(`insights_filter_${selectedAccountId}`)
        }
      }
    }
  }, [selectedAccountId, disconnectVoice])

  // Persist turns to sessionStorage whenever they change
  useEffect(() => {
    if (!selectedAccountId) return
    if (turns.length === 0) {
      sessionStorage.removeItem(`insights_turns_${selectedAccountId}`)
      return
    }
    sessionStorage.setItem(
      `insights_turns_${selectedAccountId}`,
      JSON.stringify(turns)
    )
  }, [turns, selectedAccountId])

  // Persist date filter to sessionStorage whenever it changes
  useEffect(() => {
    if (!selectedAccountId) return
    sessionStorage.setItem(
      `insights_filter_${selectedAccountId}`,
      JSON.stringify({ dateFrom, dateTo, showDateFilter })
    )
  }, [dateFrom, dateTo, showDateFilter, selectedAccountId])

  function clearConversation() {
    setTurns([])
    setError(null)
    setQuestion("")
    setDateFrom("")
    setDateTo("")
    setShowDateFilter(false)
    if (selectedAccountId) {
      sessionStorage.removeItem(`insights_turns_${selectedAccountId}`)
      sessionStorage.removeItem(`insights_filter_${selectedAccountId}`)
    }
  }

  if (!selectedAccountId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select an account to view insights.
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ height: "100%" }}>

      {/* Header */}
      <div className="flex items-center justify-between border-b bg-background px-6 py-4 shrink-0">
        <h1 className="text-base font-semibold">Insights</h1>
        <div className="flex items-center gap-2">
          {turns.length > 0 && (
            <button
              onClick={clearConversation}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Clear conversation"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
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
        </div>
      </div>

      {/* Date filter toggle */}
      <div className="shrink-0 px-6 pt-2 pb-0">
        <button
          onClick={() => setShowDateFilter(prev => !prev)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <CalendarDays className="h-3.5 w-3.5" />
          {dateFrom || dateTo
            ? `${dateFrom || "Start"} → ${dateTo || "Today"}`
            : "Filter by date range"
          }
        </button>

        {showDateFilter && (
          <div className="flex items-center gap-2 mt-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(""); setDateTo("") }}
                className="text-xs text-destructive hover:text-destructive/80 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">

        {/* Empty state */}
        {turns.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-6 py-12">
            <p className="text-sm text-muted-foreground">
              Ask anything about your finances
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {QUICK_QUESTIONS.map((q) => (
                <button
                  key={q.id}
                  onClick={() => handleQuery(q.label, q.id)}
                  disabled={isLoading}
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Conversation turns */}
        {turns.map((turn) => (
          <TurnCard
            key={turn.id}
            turn={turn}
            onSuggestionClick={handleCachedQuery}
          />
        ))}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Analyzing...
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Quick questions — show after first turn */}
        {turns.length > 0 && !isLoading && (
          <div className="flex flex-wrap gap-2 pt-2">
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q.id}
                onClick={() => handleQuery(q.label, q.id)}
                disabled={isLoading}
                className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                {q.label}
              </button>
            ))}
          </div>
        )}

        <div ref={chatBottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t bg-background px-6 py-4 shrink-0">

        {/* Voice status bar */}
        {isVoiceConnected && (
          <div className={`flex items-center justify-between rounded-lg px-3 py-2 mb-3 border ${
            voiceStatus === "connecting"
              ? "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800"
              : voiceStatus === "speaking"
              ? "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800"
              : "bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800"
          }`}>
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${
                voiceStatus === "connecting"
                  ? "bg-amber-400"
                  : voiceStatus === "speaking"
                  ? "bg-blue-500 animate-pulse"
                  : "bg-green-500 animate-pulse"
              }`} />
              <span className={`text-xs ${
                voiceStatus === "connecting"
                  ? "text-amber-700 dark:text-amber-400"
                  : voiceStatus === "speaking"
                  ? "text-blue-700 dark:text-blue-400"
                  : "text-green-700 dark:text-green-400"
              }`}>
                {voiceStatus === "connecting"
                  ? "Warming up audio pipelines... Please wait"
                  : voiceStatus === "speaking"
                  ? "Speaking"
                  : "Listening"
                }
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

        <div className="flex gap-2">
          {/* Voice connect/disconnect */}
          <button
            onClick={isVoiceConnected ? disconnectVoice : connectVoice}
            disabled={!isVoiceConnected && !VOICE_ENABLED}
            className={`flex h-10 w-10 shrink-0 items-center justify-center
              rounded-full border transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed ${
              isVoiceConnected
                ? "border-destructive bg-destructive/10 text-destructive"
                : voiceStatus === "connecting"
                ? "border-primary bg-primary/10 text-primary animate-pulse"
                : "border-border bg-background text-muted-foreground hover:text-foreground"
            }`}
            title={!VOICE_ENABLED
                  ? "Voice requires OpenAI credits"
                  : isVoiceConnected
                  ? "Disconnect voice"
                  : "Connect voice (VAD enabled)"
                }
          >
            {isVoiceConnected ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>

          {/* Text input */}
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isLoading && question) {
                handleQuery()
              }
            }}
            placeholder={isVoiceConnected
              ? "Voice active — or type a question..."
              : "Ask anything about your finances..."
            }
            className="flex h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />

          {/* Send */}
          <Button
            onClick={() => handleQuery()}
            disabled={isLoading || !question}
            size="sm"
            className="h-10"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

    </div>
  )
}
