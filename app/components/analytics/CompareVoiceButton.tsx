"use client"

// Voice narration for the Compare page — additive only, does not replace or alter the existing
// table/memory panel (ComparePanel.tsx is untouched by this component beyond mounting it). Scoped
// to a single realtime tool (ask_compare) that POSTs to /api/accounts/compare/query, the narrowly-
// scoped three-tier (answer/redirect/reject) handler — see that route's own comments for why it
// has no SQL/tool-calling loop of its own.
//
// The WebSocket/audio/turn-ordering mechanics live in the shared useRealtimeVoiceSession hook (see
// app/lib/voice/useRealtimeVoiceSession.ts) — this component only supplies what's page-specific:
// the system prompt/scope, the ask_compare tool definition and its handler, and the greeting text.
import { useRef } from "react"
import { useRealtimeVoiceSession } from "@/lib/voice/useRealtimeVoiceSession"
import { VoiceButton } from "@/components/voice/VoiceButton"
import type { CompareResponse } from "./ComparePanel"

interface Props {
  compareData: CompareResponse | null
  firstName?: string
}

export function CompareVoiceButton({ compareData, firstName }: Props) {
  // Always reads the latest compare_data at tool-call time without re-subscribing the hook.
  const compareDataRef = useRef(compareData)
  compareDataRef.current = compareData

  const session = useRealtimeVoiceSession({
    instructions: "You are a voice interface for the Compare page of Oikos Recall, a personal finance app. This page lets a user compare two of their bank accounts: category spend deltas, shared/unique categories, a confidence-scored memory of which account has consistently run higher over time, and explanations of how that comparison/memory feature itself works. "
      + "If the user makes a brief personal or social remark that isn't actually a question — correcting how you addressed them (e.g. their name), a greeting, a simple acknowledgment like \"okay\" or \"thanks\", or apologizing for talking over you — respond with a brief, warm, one-sentence acknowledgment (apologize plainly if you got their name wrong, otherwise just acknowledge what they said) and naturally invite them back to the page's content. Do not call any tool for this, and do not use the fixed off-topic refusal below — this is not the same as an off-topic question. "
      + "If the question has nothing to do with bank statements, spending, or this comparison feature (e.g. sports, weather, general knowledge, technology), respond immediately and directly with exactly: \"I'm only able to help with comparing your accounts. Want to check a category or ask about one of your accounts?\" Do not call any tool first, and never say a filler phrase like \"let me check\" beforehand — refuse directly, with nothing said or done before it. "
      + "For every other question — including questions about individual transactions or broader spending trends that belong on the Insights page, and questions about how this page's memory/confirmation mechanism works — call the ask_compare tool with the user's question verbatim. Never answer directly yourself, never add your own commentary, filler (\"let me check\", \"one moment\", etc.), or numbers before the tool responds. Once the tool returns a response, speak that response back naturally, without adding anything beyond what it says. "
      + "When speaking monetary amounts, percentages, and other numeric figures, pronounce them the way a person would say them naturally in conversation (e.g. \"seven hundred forty-nine thousand rupees\", not digit-by-digit), not written/formatted the way they'd appear on screen.",
    greetingInstructions: `Greet the user warmly by name in exactly one brief sentence. Address them as "${firstName || "there"}". Keep it short and friendly, welcoming them to ask about their account comparison.`,
    tools: [
      {
        name: "ask_compare",
        description: "Answer a question about the currently-displayed account comparison — category spend deltas, shared/unique categories, or a comparison confidence fact. Call this for every question the user asks, verbatim.",
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

      const res = await fetch("/api/accounts/compare/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, compare_data: compareDataRef.current }),
      })
      const json = await res.json()
      return res.ok && json.response ? json.response : "Sorry, I couldn't answer that just now."
    },
  })

  if (!compareData) return null

  return <VoiceButton session={session} idleLabel="Ask about this comparison by voice" />
}
