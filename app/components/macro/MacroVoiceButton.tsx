"use client"

// Voice narration for the Macro page — additive only, does not replace or alter the existing
// indicators/synthesis/scenario-slider/Memory panel (MacroPanel.tsx is untouched by this
// component beyond mounting it and lifting the scenario slider's state — see MacroPanel.tsx and
// InvestmentScenarioSlider.tsx). Scoped to a single realtime tool (ask_macro) that POSTs to
// /api/macro/query, the narrowly-scoped three-tier (answer/redirect/reject) handler — see that
// route's own comments for why it has no SQL/tool-calling loop of its own.
//
// The WebSocket/audio/turn-ordering mechanics live in the shared useRealtimeVoiceSession hook (see
// app/lib/voice/useRealtimeVoiceSession.ts) — this component only supplies what's page-specific:
// the system prompt/scope, the ask_macro tool definition and its handler, and the greeting text.
import { useRef } from "react"
import { useRealtimeVoiceSession } from "@/lib/voice/useRealtimeVoiceSession"
import { VoiceButton } from "@/components/voice/VoiceButton"
import type { MacroIndicator, BalancesSummary } from "@/lib/hooks/useMacro"

// Mirrors the shape /api/macro/query expects as macro_data (see that route's MacroData type) —
// the exact data MacroPanel already holds from useMacro(), plus the scenario slider's live state
// (lifted up from InvestmentScenarioSlider so voice questions can be answered against what's
// actually on screen right now, not a default).
export type MacroVoiceData = {
  indicators: MacroIndicator[]
  explanation: string | null
  balances: BalancesSummary
  currency: string
  gdpPerCapitaAgeNote: string | null
  repoRateUnchangedNote: string | null
  scenarioAmount: number
  scenarioAssumedReturn: number
}

interface Props {
  macroData: MacroVoiceData | null
  firstName?: string
}

export function MacroVoiceButton({ macroData, firstName }: Props) {
  // Always reads the latest macroData at tool-call time without re-subscribing the hook.
  const macroDataRef = useRef(macroData)
  macroDataRef.current = macroData

  const session = useRealtimeVoiceSession({
    instructions: "You are a voice interface for the Macro page of Oikos Recall, a personal finance app. This page shows national economic indicators, a personalized synthesis comparing them against the user's own balance, an investment scenario slider, and a confidence-scored memory of the user's balance trend over time, plus explanations of how that memory feature itself works. "
      + "If the question has nothing to do with finances or this page's content (e.g. sports, weather, general knowledge, technology), respond immediately and directly with exactly: \"I'm only able to help with your economic context and balance trends. Want to check an indicator or your balance history?\" Do not call any tool first, and never say a filler phrase like \"let me check\" beforehand — refuse directly, with nothing said or done before it. "
      + "For every other question — including general bank statement questions, category-level spending trends, or individual transaction/debit/credit queries that belong on the Insights page, and questions about how this page's memory/confirmation mechanism works — call the ask_macro tool with the user's question verbatim. Never answer directly yourself, never add your own commentary, filler (\"let me check\", \"one moment\", etc.), or numbers before the tool responds. Once the tool returns a response, speak that response back naturally, without adding anything beyond what it says.",
    greetingInstructions: `Greet the user warmly by name in exactly one brief sentence. Address them as "${firstName || "there"}". Keep it short and friendly, welcoming them to ask about their economic context and balance trends.`,
    tools: [
      {
        name: "ask_macro",
        description: "Answer a question about the currently-displayed Macro page — economic indicators, the personalized erosion/synthesis explanation, the investment scenario slider, or the balance-trend confidence memory. Call this for every question the user asks, verbatim.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The user's question, as close to verbatim as possible.",
            },
          },
          required: ["question"],
        },
      },
    ],
    onToolCall: async (name, args, rawTranscript) => {
      const question = (args.question as string | undefined)?.trim() || rawTranscript
      const data = macroDataRef.current

      const res = await fetch("/api/macro/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          macro_data: data ? {
            indicators: data.indicators,
            explanation: data.explanation,
            balances: data.balances,
            currency: data.currency,
            gdp_per_capita_age_note: data.gdpPerCapitaAgeNote,
            repo_rate_unchanged_note: data.repoRateUnchangedNote,
            scenario: {
              amount: data.scenarioAmount,
              assumed_return: data.scenarioAssumedReturn,
            },
          } : null,
        }),
      })
      const json = await res.json()
      return res.ok && json.response ? json.response : "Sorry, I couldn't answer that just now."
    },
  })

  if (!macroData) return null

  return <VoiceButton session={session} idleLabel="Ask about your economic context by voice" />
}
