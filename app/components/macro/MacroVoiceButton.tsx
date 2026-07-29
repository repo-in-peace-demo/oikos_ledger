"use client"

// Voice narration for the Macro page — additive only, does not replace or alter the existing
// indicators/synthesis/scenario-slider/Memory panel (MacroPanel.tsx is untouched by this
// component beyond mounting it and lifting the scenario slider's state — see MacroPanel.tsx and
// InvestmentScenarioSlider.tsx). Scoped to a single realtime tool (ask_macro) that POSTs to
// /api/macro/query, the narrowly-scoped three-tier (answer/redirect/reject) handler — see that
// route's own comments for why it has no SQL/tool-calling loop of its own.
//
// Built directly against Compare's equivalent feature (app/components/analytics/
// CompareVoiceButton.tsx) as the reference pattern, incorporating every fix that feature needed
// after live testing, from the start rather than re-deriving them:
//   - Turns are keyed by a stable id (not array-insertion order). The user's turn is reserved as
//     an empty placeholder the moment speech is detected (input_audio_buffer.speech_started),
//     before transcription or any response exists, so no assistant reply — however fast an
//     instant off-topic rejection is — can ever render ahead of the question that prompted it.
//   - Assistant turns are only added from response.output_item.done items the Realtime API itself
//     tags phase === "final_answer" — the same fix InsightsPanel.tsx already uses (challenges.md's
//     "Duplicate Turn Bubbles") — so a commentary/filler phase never becomes its own bubble.
//   - Transcript auto-scroll uses Element.scrollTo on the transcript container itself, never
//     scrollIntoView (which can leak to ancestor/page scroll by design), and is position-aware:
//     only auto-scrolls when the user is already near the bottom.
//   - Off-topic questions are refused instantly, client-side, with zero tool call or "let me
//     check" preamble — genuine in-scope/redirect questions still go through the ask_macro tool.
//   - Greeting-on-connect (personalized by first name), the end_conversation tool, and the
//     farewell-response-then-timed-disconnect sequencing (ADR 013) are all reused verbatim from
//     the same proven pattern, not reinvented.
//   - Memory facts (trend:balance_snapshot) are NOT taken from macroData — the backend route
//     fetches them itself via loadMacroFacts, the same marker-based cached function the Macro
//     page route uses (app/lib/macro/balanceFacts.ts), confirmed grepped for below rather than
//     assumed. This component makes zero MCP calls of its own.
import { useEffect, useRef, useState } from "react"
import { Mic, MicOff, X } from "lucide-react"
import type { MacroIndicator, BalancesSummary } from "@/lib/hooks/useMacro"

const VOICE_ENABLED = process.env.NEXT_PUBLIC_VOICE_ENABLED === "true"
const NEAR_BOTTOM_THRESHOLD_PX = 48

type Turn = { id: string; role: "user" | "assistant"; content: string }

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
  const [isVoiceConnected, setIsVoiceConnected] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "connecting" | "listening" | "speaking">("idle")
  const [error, setError] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const activeAudioSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const isResponseInProgress = useRef(false)
  const processedCallIds = useRef<Set<string>>(new Set())
  const lastTranscriptRef = useRef<string>("")
  // The user-turn placeholder created at speech_started, filled in once transcription completes —
  // see the fix note on addTurn/speech_started below.
  const pendingUserTurnId = useRef<string | null>(null)
  const currentAssistantItemId = useRef<string | null>(null)
  const mutedItemId = useRef<string | null>(null)
  const audioSamplesPlayed = useRef<number>(0)
  const lastAudioScheduledEndTimeRef = useRef<number>(0)
  const shouldDisconnectAfterResponse = useRef(false)
  const awaitingFarewellResponse = useRef(false)
  // Always reads the latest macroData at tool-call time without re-subscribing the WS effect.
  const macroDataRef = useRef(macroData)
  useEffect(() => { macroDataRef.current = macroData }, [macroData])

  // Transcript auto-scroll — deliberately NOT scrollIntoView(), which can also scroll outer
  // scrollable ancestors (including the page itself) since it's defined in terms of "bring this
  // element into view within whatever contains it," not "scroll this one element." Element.scrollTo
  // has no such ancestor-scrolling behavior at all — it's defined purely in terms of the target
  // element's own scroll box, so it structurally cannot leak to the page the way scrollIntoView did.
  const transcriptContainerRef = useRef<HTMLDivElement>(null)
  // Starts true — an empty/short transcript is trivially "at the bottom." Updated on every scroll
  // event so the turns-effect below always checks where the user actually is *before* this new
  // turn arrived, not a value recomputed after the DOM (and scrollHeight) already changed.
  const isNearBottomRef = useRef(true)

  function handleTranscriptScroll() {
    const el = transcriptContainerRef.current
    if (!el) return
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX
  }

  useEffect(() => {
    const el = transcriptContainerRef.current
    if (!el || !isNearBottomRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [turns])

  // Ordering key is assigned here, at insertion time — for the user role this is called from
  // speech_started (see below), before transcription or any response exists, so no assistant
  // reply (however fast) can ever be inserted ahead of the question that prompted it.
  function addTurn(turn: Omit<Turn, "id">): string {
    const id = crypto.randomUUID()
    setTurns((prev) => [...prev, { ...turn, id }])
    return id
  }

  function updateTurn(id: string, updates: Partial<Omit<Turn, "id">>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...updates } : t)))
  }

  function stopMicCapture() {
    processorRef.current?.disconnect()
    processorRef.current = null
    gainNodeRef.current?.disconnect()
    gainNodeRef.current = null
    audioContextRef.current?.close()
    audioContextRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  // "Conversation window closes on disconnect" — turns are session-scoped, not persisted, so a
  // fresh connect always starts from an empty transcript, same as a call ending and a new one
  // starting (unlike Insights' chat log, which persists across voice sessions in sessionStorage —
  // Macro's voice narration doesn't have a page-level chat history to persist into).
  function disconnectVoice() {
    shouldDisconnectAfterResponse.current = false
    awaitingFarewellResponse.current = false
    wsRef.current?.close()
    wsRef.current = null
    stopMicCapture()
    setIsVoiceConnected(false)
    setVoiceStatus("idle")
    setTurns([])
  }

  // Cleanup on unmount (navigating away from /macro mid-call)
  useEffect(() => disconnectVoice, [])

  async function startMicCapture(): Promise<{ workletNode: AudioWorkletNode } | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      })
      streamRef.current = stream

      const audioContext = new AudioContext({ sampleRate: 24000 })
      audioContextRef.current = audioContext

      const workletCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0][0]
            if (input) {
              const pcm16 = new Int16Array(input.length)
              for (let i = 0; i < input.length; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, input[i] * 32768))
              }
              this.port.postMessage(pcm16.buffer, [pcm16.buffer])
            }
            return true
          }
        }
        registerProcessor('pcm-processor', PCMProcessor)
      `
      const blob = new Blob([workletCode], { type: "application/javascript" })
      const url = URL.createObjectURL(blob)
      await audioContext.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)

      const source = audioContext.createMediaStreamSource(stream)
      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor")
      processorRef.current = workletNode
      source.connect(workletNode)
      workletNode.connect(audioContext.destination)

      const gainNode = audioContext.createGain()
      gainNode.gain.value = 1
      gainNode.connect(audioContext.destination)
      gainNodeRef.current = gainNode

      return { workletNode }
    } catch (err) {
      console.error("MacroVoiceButton: startMicCapture failed:", err)
      return null
    }
  }

  async function connectVoice() {
    setIsVoiceConnected(true)
    setVoiceStatus("connecting")
    setError(null)

    try {
      const micPromise = startMicCapture()

      const tokenRes = await fetch("/api/insights/session", { method: "POST" })
      if (!tokenRes.ok) throw new Error("Failed to get session token")
      const { client_secret } = await tokenRes.json() as { client_secret: { value: string } }

      const ws = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
        ["realtime", `openai-insecure-api-key.${client_secret.value}`],
      )

      let nextAudioStartTime = 0

      ws.onopen = async () => {
        setVoiceStatus("listening")

        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                transcription: { model: "gpt-realtime-whisper" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.8,
                  prefix_padding_ms: 500,
                  silence_duration_ms: 1000,
                  interrupt_response: true,
                  create_response: true,
                },
              },
              output: { voice: "shimmer" },
            },
            tools: [
              {
                type: "function",
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
              {
                type: "function",
                name: "end_conversation",
                description: `Call this tool immediately when the user indicates they are done. Trigger phrases include: "no", "that is all", "nothing else", "i'm done", "no more", "goodbye", "bye", "nope", "all good", "that's it", "no thank you", "no thanks", or any similar closing response to "is there anything else?" Do NOT ask a follow-up question first. Call the tool immediately on these phrases.`,
                parameters: { type: "object", properties: {} },
              },
            ],
            tool_choice: "auto",
            instructions: "You are a voice interface for the Macro page of Oikos Recall, a personal finance app. This page shows national economic indicators, a personalized synthesis comparing them against the user's own balance, an investment scenario slider, and a confidence-scored memory of the user's balance trend over time, plus explanations of how that memory feature itself works. "
              + "If the question has nothing to do with finances or this page's content (e.g. sports, weather, general knowledge, technology), respond immediately and directly with exactly: \"I'm only able to help with your economic context and balance trends. Want to check an indicator or your balance history?\" Do not call any tool first, and never say a filler phrase like \"let me check\" beforehand — refuse directly, with nothing said or done before it. "
              + "For every other question — including general bank statement questions, category-level spending trends, or individual transaction/debit/credit queries that belong on the Insights page, and questions about how this page's memory/confirmation mechanism works — call the ask_macro tool with the user's question verbatim. Never answer directly yourself, never add your own commentary, filler (\"let me check\", \"one moment\", etc.), or numbers before the tool responds. Once the tool returns a response, speak that response back naturally, without adding anything beyond what it says.",
          },
        }))

        try {
          const streamData = await micPromise
          if (streamData) {
            streamData.workletNode.port.onmessage = (e) => {
              if (ws.readyState !== WebSocket.OPEN) return
              const bytes = new Uint8Array(e.data as ArrayBuffer)
              let binary = ""
              for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
              ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(binary) }))
            }
          }

          if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext({ sampleRate: 24000 })
          }
          if (audioContextRef.current.state === "suspended") {
            await audioContextRef.current.resume()
          }

          // Greeting on connect — same init-turn-then-response.create flow as InsightsPanel.
          ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Hello! I am ready to talk." }],
            },
          }))
          ws.send(JSON.stringify({
            type: "response.create",
            response: {
              instructions: `Greet the user warmly by name in exactly one brief sentence. Address them as "${firstName || "there"}". Keep it short and friendly, welcoming them to ask about their economic context and balance trends.`,
            },
          }))
          isResponseInProgress.current = true
        } catch (micErr) {
          console.error("MacroVoiceButton: mic handshake failed:", micErr)
          setError("Could not access the microphone.")
          disconnectVoice()
        }
      }

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data as string)

        if (msg.type === "response.created") {
          isResponseInProgress.current = true
          if (gainNodeRef.current) gainNodeRef.current.gain.value = 1
        }

        if (msg.type === "response.done") {
          isResponseInProgress.current = false

          if (awaitingFarewellResponse.current) {
            awaitingFarewellResponse.current = false
            shouldDisconnectAfterResponse.current = true
          }

          if (shouldDisconnectAfterResponse.current) {
            shouldDisconnectAfterResponse.current = false
            const now = audioContextRef.current ? audioContextRef.current.currentTime : 0
            const remainingPlayTimeMs = Math.max(0, (lastAudioScheduledEndTimeRef.current - now) * 1000)
            setTimeout(() => {
              disconnectVoice()
            }, remainingPlayTimeMs + 800)
          } else {
            setVoiceStatus("listening")
          }
        }

        // Barge-in — same pattern as InsightsPanel: mute + truncate + cancel so an interruption
        // doesn't leave two voices overlapping.
        if (msg.type === "input_audio_buffer.speech_started") {
          // Reserve this question's position in the transcript the moment speech is detected —
          // *before* transcription or any response exists, so no response (however fast, e.g. an
          // instant off-topic rejection) can ever be inserted ahead of the question that prompted
          // it. Content fills in once transcription completes (see conversation.item
          // .input_audio_transcription.completed below); the turn's position is locked in now.
          pendingUserTurnId.current = addTurn({ role: "user", content: "" })

          activeAudioSourcesRef.current.forEach((source) => {
            try { source.stop() } catch { /* already finished naturally */ }
          })
          activeAudioSourcesRef.current = []

          if (audioContextRef.current) {
            nextAudioStartTime = audioContextRef.current.currentTime
            lastAudioScheduledEndTimeRef.current = audioContextRef.current.currentTime
            audioSamplesPlayed.current = 0
          }
          if (gainNodeRef.current) gainNodeRef.current.gain.value = 0
          mutedItemId.current = currentAssistantItemId.current

          if (wsRef.current?.readyState === WebSocket.OPEN && isResponseInProgress.current) {
            const playedMs = Math.round((audioSamplesPlayed.current / 24000) * 1000)
            if (currentAssistantItemId.current) {
              wsRef.current.send(JSON.stringify({
                type: "conversation.item.truncate",
                item_id: currentAssistantItemId.current,
                content_index: 0,
                audio_end_ms: playedMs,
              }))
            }
            wsRef.current.send(JSON.stringify({ type: "response.cancel" }))
            isResponseInProgress.current = false
          }
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          if (msg.transcript?.trim()) {
            const transcript = msg.transcript.trim()
            lastTranscriptRef.current = transcript
            // Fill in the placeholder reserved at speech_started — its position was already
            // locked in, this only ever changes its content.
            if (pendingUserTurnId.current) {
              updateTurn(pendingUserTurnId.current, { content: transcript })
              pendingUserTurnId.current = null
            }
          }
        }

        if (msg.type === "response.function_call_arguments.done") {
          const callId = msg.call_id as string
          if (processedCallIds.current.has(callId)) return
          processedCallIds.current.add(callId)

          // The user turn itself was already inserted at speech_started (see above) — this is
          // just reading the transcript text for the tool-call fallback below, not adding a turn.
          const rawTranscript = lastTranscriptRef.current
          lastTranscriptRef.current = ""

          if (msg.name === "end_conversation") {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: JSON.stringify({ success: true }),
                },
              }))
              wsRef.current.send(JSON.stringify({ type: "response.create" }))
              isResponseInProgress.current = true
            }
            // Delay arming the farewell trap so this tool-call's own response.done fires and
            // clears first, before we treat the *next* response.done as the farewell's.
            setTimeout(() => {
              awaitingFarewellResponse.current = true
            }, 300)
            return
          }

          try {
            const args = JSON.parse(msg.arguments as string) as { question: string }
            const question = args.question?.trim() || rawTranscript

            const res = await fetch("/api/macro/query", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                question,
                macro_data: macroDataRef.current ? {
                  indicators: macroDataRef.current.indicators,
                  explanation: macroDataRef.current.explanation,
                  balances: macroDataRef.current.balances,
                  currency: macroDataRef.current.currency,
                  gdp_per_capita_age_note: macroDataRef.current.gdpPerCapitaAgeNote,
                  repo_rate_unchanged_note: macroDataRef.current.repoRateUnchangedNote,
                  scenario: {
                    amount: macroDataRef.current.scenarioAmount,
                    assumed_return: macroDataRef.current.scenarioAssumedReturn,
                  },
                } : null,
              }),
            })
            const json = await res.json()
            const responseText: string = res.ok && json.response
              ? json.response
              : "Sorry, I couldn't answer that just now."

            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: JSON.stringify({ response: responseText }),
                },
              }))
              if (!isResponseInProgress.current) {
                wsRef.current.send(JSON.stringify({ type: "response.create" }))
                isResponseInProgress.current = true
              }
            }
          } catch (err) {
            console.error("MacroVoiceButton: tool execution failed:", err)
            setError("Failed to process voice query.")
          }
        }

        if (msg.type === "response.output_item.added" && msg.item?.role === "assistant") {
          currentAssistantItemId.current = msg.item.id as string
          audioSamplesPlayed.current = 0
          mutedItemId.current = null
        }

        // Captures what the model actually spoke, for turns that are the true final answer to a
        // question — rather than trusting the backend's response text to match verbatim (the
        // realtime model is instructed to speak it naturally, which could paraphrase slightly).
        // The one-off greeting-on-connect is spoken audio only and deliberately does not appear
        // here as a transcript turn, matching Insights' own voice-mode convention of suppressing
        // ambient/conversational content from the visible turn list, not a gap in this filter.
        if (msg.type === "response.output_item.done" && msg.item?.role === "assistant") {
          const textContent = msg.item.content
            ?.map((c: { text?: string; transcript?: string }) => c.text ?? c.transcript ?? "")
            .join("")
            .trim()
          const hasFunctionCall = msg.item.content?.some(
            (c: { type?: string }) => c.type === "function_call",
          )
          if (hasFunctionCall && !textContent) {
            // Pure tool-call item, nothing spoken — nothing to add.
          } else if (textContent && msg.item?.phase === "final_answer") {
            // Same fix already proven in InsightsPanel.tsx (see challenges.md's "Duplicate Turn
            // Bubbles") and reused for Compare's voice feature — only the item the Realtime API
            // itself tags as the true final answer becomes a transcript turn, so a commentary/
            // filler phase never renders ahead of the question that prompted it.
            addTurn({ role: "assistant", content: textContent })
          }
        }

        if (msg.type === "response.output_audio.delta" && audioContextRef.current) {
          if (msg.item_id && msg.item_id === mutedItemId.current) return

          setVoiceStatus("speaking")
          const audioBuffer = Uint8Array.from(atob(msg.delta as string), (c) => c.charCodeAt(0)).buffer
          const pcmData = new Int16Array(audioBuffer)
          const float32Data = new Float32Array(pcmData.length)
          for (let i = 0; i < pcmData.length; i++) float32Data[i] = pcmData[i] / 32768.0
          audioSamplesPlayed.current += float32Data.length

          const ctx = audioContextRef.current
          const buffer = ctx.createBuffer(1, float32Data.length, 24000)
          buffer.copyToChannel(float32Data, 0)

          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(gainNodeRef.current ?? ctx.destination)

          const startTime = Math.max(ctx.currentTime, nextAudioStartTime)
          source.start(startTime)
          nextAudioStartTime = startTime + buffer.duration
          lastAudioScheduledEndTimeRef.current = nextAudioStartTime

          activeAudioSourcesRef.current.push(source)
          source.onended = () => {
            activeAudioSourcesRef.current = activeAudioSourcesRef.current.filter((s) => s !== source)
          }
        }

        if (msg.type === "error") {
          if (msg.error?.code === "response_cancel_not_active") return
          console.error("MacroVoiceButton: realtime API error:", msg.error)
          setError(`Voice error: ${msg.error?.message}`)
        }
      }

      ws.onerror = () => {
        setError("Voice connection error. Please try again.")
        disconnectVoice()
      }
      ws.onclose = () => {
        setIsVoiceConnected(false)
        setVoiceStatus("idle")
        stopMicCapture()
      }

      wsRef.current = ws
    } catch {
      setError("Failed to connect voice. Please try again.")
      setVoiceStatus("idle")
      setIsVoiceConnected(false)
    }
  }

  if (!macroData) return null

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
          title={!VOICE_ENABLED
            ? "Voice requires OpenAI credits"
            : isVoiceConnected ? "Disconnect voice" : "Ask about your economic context by voice"
          }
        >
          {isVoiceConnected ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        <span className="text-xs text-muted-foreground">
          {isVoiceConnected ? "" : "Ask about your economic context by voice"}
        </span>
      </div>

      {/* Transcript — conversation-scoped, not persisted (see disconnectVoice) — closes/clears
          when the session ends, matching a phone call rather than a page-level chat log. */}
      {isVoiceConnected && turns.length > 0 && (
        <div
          ref={transcriptContainerRef}
          onScroll={handleTranscriptScroll}
          className="max-h-64 overflow-y-auto rounded-lg border bg-slate-50 p-3 space-y-2"
        >
          {/* A user placeholder reserved at speech_started can still be empty if transcription
              never arrives (VAD false-positive, background noise) — filtered out here, not at
              insertion time, so its reserved position in the array is unaffected either way. */}
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
