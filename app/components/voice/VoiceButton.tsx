"use client"

// Shared mic-button + status-bar + optional-transcript UI, driven entirely by a
// useRealtimeVoiceSession result. Compare, Macro, and Recommendations all render this directly;
// Insights keeps its own richer chat-turn UI (sql/chart-bearing cards, not plain text turns) and
// consumes the hook's callbacks instead of this component — see InsightsPanel.tsx.
import type { UseRealtimeVoiceSessionResult } from "@/lib/voice/useRealtimeVoiceSession"
import { Mic, MicOff, X } from "lucide-react"

const VOICE_ENABLED = process.env.NEXT_PUBLIC_VOICE_ENABLED === "true"

interface Props {
  session: UseRealtimeVoiceSessionResult
  /** Label shown next to the idle mic button, e.g. "Ask about this comparison by voice". */
  idleLabel: string
  /** Whether to render the transcript window. Recommendations opts out — see the shared-hook
   * extraction task notes: a page can opt out of showing turns while the hook still tracks them
   * internally for the model's own context. */
  showTranscript?: boolean
}

export function VoiceButton({ session, idleLabel, showTranscript = true }: Props) {
  const {
    isVoiceConnected, voiceStatus, error, turns,
    connectVoice, disconnectVoice, transcriptContainerRef, handleTranscriptScroll,
  } = session

  return (
    <div className="space-y-2">
      {isVoiceConnected && (
        <div className={`flex items-center justify-between rounded-lg px-3 py-2 border text-xs ${
          voiceStatus === "connecting"
            ? "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800"
            : voiceStatus === "speaking"
            ? "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800"
            : "bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800"
        }`}>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${
              voiceStatus === "connecting" ? "bg-amber-400"
                : voiceStatus === "speaking" ? "bg-blue-500 animate-pulse"
                : "bg-green-500 animate-pulse"
            }`} />
            <span className={
              voiceStatus === "connecting" ? "text-amber-700 dark:text-amber-400"
                : voiceStatus === "speaking" ? "text-blue-700 dark:text-blue-400"
                : "text-green-700 dark:text-green-400"
            }>
              {voiceStatus === "connecting" ? "Warming up..." : voiceStatus === "speaking" ? "Speaking" : "Listening"}
            </span>
          </div>
          <button
            onClick={disconnectVoice}
            className="flex items-center gap-1 text-destructive hover:text-destructive/80 transition-colors"
          >
            <X className="h-3 w-3" />
            Disconnect
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={isVoiceConnected ? disconnectVoice : connectVoice}
          disabled={!isVoiceConnected && !VOICE_ENABLED}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed ${
            isVoiceConnected
              ? "border-destructive bg-destructive/10 text-destructive"
              : voiceStatus === "connecting"
              ? "border-primary bg-primary/10 text-primary animate-pulse"
              : "border-border bg-background text-muted-foreground hover:text-foreground"
          }`}
          title={!VOICE_ENABLED ? "Voice requires OpenAI credits" : isVoiceConnected ? "Disconnect voice" : idleLabel}
        >
          {isVoiceConnected ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        <span className="text-xs text-muted-foreground">
          {isVoiceConnected ? "" : idleLabel}
        </span>
      </div>

      {/* Visible as soon as the session is connected, not gated on turns.length — the greeting
          plays before any user turn exists, and a condition requiring turns.length > 0 would hide
          the window for that entire window regardless of whether the greeting itself becomes a
          turn. */}
      {showTranscript && isVoiceConnected && (
        <div
          ref={transcriptContainerRef}
          onScroll={handleTranscriptScroll}
          className="max-h-64 overflow-y-auto rounded-lg border bg-slate-50 p-3 space-y-2"
        >
          {turns.filter((turn) => turn.content.trim().length > 0).map((turn) => (
            <div key={turn.id} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                turn.role === "user"
                  ? "bg-primary text-primary-foreground rounded-br-sm"
                  : "bg-muted rounded-bl-sm"
              }`}>
                {turn.content}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
