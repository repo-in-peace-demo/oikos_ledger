"use client"

// Shared realtime-voice-session mechanics for Insights, Compare, Macro, and Recommendations —
// extracted after all four were found to have independently copied (and inconsistently fixed) the
// same WebSocket/audio/turn-ordering code. See the per-page components for what stays separate:
// which tools are available, the in-scope/redirect/reject system prompt, and whether a transcript
// window is rendered at all (Recommendations opts out — see showTranscript below).
//
// Fixes applied here that no prior copy had (see investigation notes in the extraction task):
//   - Real streaming of the assistant's spoken text via response.output_audio_transcript.delta,
//     rather than only populating text once response.output_item.done delivers the whole thing at
//     once (the "blob" bug, present identically in Insights/Compare/Macro). A turn placeholder is
//     created eagerly at response.output_item.added and filled incrementally, and finalizes as a
//     genuine turn regardless of phase (final_answer or commentary — see the "fixed after
//     streaming surfaced them" note below for why phase no longer gates visibility). The one
//     exception is the one-off greeting-on-connect — tracked explicitly via isGreetingInFlightRef
//     — whose placeholder is removed rather than left as a stray bubble.
//   - Stable turn-keying: the user's turn is reserved as an empty placeholder at
//     input_audio_buffer.speech_started — before transcription or any response exists — so no
//     assistant reply (however fast, e.g. an instant off-topic rejection) can render ahead of the
//     question that prompted it. Insights never had this; Compare/Macro already did.
//   - Scroll containment via Element.scrollTo on the transcript container itself (never
//     scrollIntoView, which can walk up and scroll ancestor scrollables including the page), and
//     position-aware auto-scroll (only scrolls if the user was already near the bottom). Insights
//     never had this; Compare/Macro already did.
//
// Fixed after the initial extraction, once streaming surfaced them in practice:
//   - Turn/text tracking for the assistant side is keyed by item_id (assistantTurnIdByItemId /
//     assistantTextByItemId), not a single "current" ref — a response can contain more than one
//     assistant output item (e.g. a "commentary" item followed by a separate "final_answer" item,
//     each with its own item_id and phase), and a shared ref had the second item's deltas
//     overwrite the first item's already-populated turn instead of getting its own.
//   - Barge-in's conversation.item.truncate call read audioSamplesPlayed *after* resetting it to
//     0, so audio_end_ms was always sent as 0 regardless of how much had actually played. Also,
//     currentAssistantItemId was never cleared once an item completed, so a barge-in landing in
//     the gap between an item's own completion and the response's overall response.done could
//     target an already-finalized item, which the Realtime API rejects with "item_id not found."
//   - A commentary-phase item is no longer hidden/removed once item_id-keying fixed the overwrite
//     above — with distinct turns per item, hiding commentary just made it flash on screen (its
//     audio played regardless) and then vanish, reading as the same "overwritten" symptom from
//     the user's perspective. Phase-based hiding existed only to stop a filler item from racing
//     ahead of the user's own question in the turn list; stable speech-start keying already
//     prevents that regardless of phase, so commentary now persists as its own genuine turn, the
//     same as final_answer — only the connect-time greeting is still suppressed.
import { useCallback, useEffect, useRef, useState } from "react"

const NEAR_BOTTOM_THRESHOLD_PX = 48

export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking"
export type VoiceTurn = { id: string; role: "user" | "assistant"; content: string }

export interface VoiceToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface UseRealtimeVoiceSessionOptions {
  /** Complete page-specific system instructions (scope, off-topic handling, tool-calling directive). */
  instructions: string
  /** Instructions for the one-off greeting response sent right after connecting. Omit to skip the greeting entirely. */
  greetingInstructions?: string
  /** Page-specific tools beyond the always-included end_conversation tool. */
  tools?: VoiceToolDefinition[]
  /** Called when the model invokes a page-specific tool (never end_conversation, handled internally). Must resolve to the text to speak back. rawTranscript is the last completed user transcript, for callers whose tool args don't carry the question verbatim. */
  onToolCall?: (name: string, args: Record<string, unknown>, rawTranscript: string) => Promise<string>
  /** Realtime VAD tuning. Defaults match Insights/Compare/Macro's shared values; pass overrides for a gentler feel (e.g. Recommendations uses threshold 0.5/300/800). */
  vad?: { threshold?: number; prefixPaddingMs?: number; silenceDurationMs?: number }
  voice?: string
  /** Fires with the user's completed transcript text — lets a page build its own richer turn representation in addition to (or instead of) this hook's own simple turns list. */
  onUserTurn?: (text: string) => void
  /** Fires with the assistant's confirmed final-answer text. */
  onAssistantTurn?: (text: string) => void
  /** Fires at the moment a new user utterance is detected, before any transcript exists — e.g. so a page can clear a live-updating input box for the new utterance. */
  onSpeechStarted?: () => void
  /** Fires with each incremental piece of the user's own speech transcript as it's recognized (conversation.item.input_audio_transcription.delta) — for pages that mirror it into a live text input, not for building turns (use onUserTurn for the completed text). */
  onUserTranscriptDelta?: (delta: string) => void
}

export interface UseRealtimeVoiceSessionResult {
  isVoiceConnected: boolean
  voiceStatus: VoiceStatus
  error: string | null
  /** Always maintained internally regardless of whether a page renders a transcript window. */
  turns: VoiceTurn[]
  connectVoice: () => Promise<void>
  disconnectVoice: () => void
  transcriptContainerRef: React.RefObject<HTMLDivElement | null>
  handleTranscriptScroll: () => void
}

export function useRealtimeVoiceSession(
  options: UseRealtimeVoiceSessionOptions,
): UseRealtimeVoiceSessionResult {
  const [isVoiceConnected, setIsVoiceConnected] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [turns, setTurns] = useState<VoiceTurn[]>([])

  // Always reads the latest page-specific config at connect/tool-call time without re-subscribing
  // the WS effect — instructions/tools/greeting can legitimately change between renders (e.g.
  // Recommendations' system prompt depends on data that loads asynchronously after mount).
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options })

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const activeAudioSourcesRef = useRef<AudioBufferSourceNode[]>([])
  // TEMPORARY — diagnostic-only, added to test the hypothesis that create_response: true lets the
  // server auto-trigger a second, unrelated response before a first tool call's onToolCall
  // resolves, which could have that second response's own output_item.added incorrectly consume
  // a reservation meant for the still-pending first exchange. Do not build on this id for actual
  // logic; remove this whole block (and the log call sites below) once the diagnostic pass is
  // done and a real fix (if needed) is decided.
  const currentResponseInstanceIdRef = useRef<string | null>(null)
  function logDiagnostic(event: string, extra: Record<string, unknown>) {
    console.log(JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      context: "useRealtimeVoiceSession.diagnostic",
      event,
      ...extra,
    }))
  }
  const isResponseInProgress = useRef(false)
  const processedCallIds = useRef<Set<string>>(new Set())
  const lastTranscriptRef = useRef<string>("")
  // FIFO queue, not a single "current" slot — back-to-back utterances (e.g. a short "all right"
  // immediately followed by a real question) can have a second speech_started fire before the
  // first utterance's transcription.completed arrives. A single ref got overwritten by the
  // second placeholder before the first utterance's transcript landed, so the completed event
  // (matched only by whatever pendingUserTurnId currently held, not by which utterance it was
  // actually for) filled the *wrong* turn and left the second utterance's own turn never filled.
  // Utterances are detected in strict chronological order (VAD boundaries) and their
  // transcriptions complete in that same order, so a FIFO queue — push on speech_started, shift
  // on the next completed event — pairs each transcript with its own utterance correctly
  // regardless of how close together they were spoken.
  const pendingUserTurnIds = useRef<string[]>([])
  const currentAssistantItemId = useRef<string | null>(null)
  // Tracked alongside currentAssistantItemId — a function_call item has no audio content at all,
  // so a barge-in landing while it's "current" (e.g. interrupting the assistant mid tool-call,
  // before any spoken response exists yet) must not send conversation.item.truncate against it:
  // the Realtime API rejects that with "Only model output audio messages can be truncated"
  // (unsupported_content_type). response.cancel alone still applies — there's a response in
  // progress to cancel, just nothing audio-bearing to truncate.
  const currentAssistantItemType = useRef<string | null>(null)
  // Keyed by item_id, not a single "current" slot — a single response can contain more than one
  // assistant output item (e.g. a "commentary" item followed by a separate "final_answer" item,
  // each with its own item_id). A single shared ref would have the second item's deltas target
  // and overwrite the first item's already-populated turn instead of getting its own; per-item_id
  // maps make that structurally impossible regardless of exact event timing.
  const assistantTurnIdByItemId = useRef<Map<string, string>>(new Map())
  const assistantTextByItemId = useRef<Map<string, string>>(new Map())
  // FIFO queue, reserved synchronously at response.function_call_arguments.done — *before*
  // awaiting the tool call — not only once response.output_item.added eventually fires. A tool
  // call's own backend fetch (onToolCall) can take long enough that the user asks a follow-up
  // question before it resolves; that follow-up's own turn gets appended immediately (at its
  // speech_started), so if the first answer's turn isn't reserved until output_item.added — which
  // only fires *after* the fetch resolves and a new response.create is sent — the follow-up's
  // turn lands ahead of the still-pending first answer's, bunching both questions before either
  // answer. Reserving here, synchronously, guarantees the first answer's position in the array is
  // locked in before the second question can be asked, mirroring the same principle already
  // applied to user turns at speech_started. Consumed once per response (see
  // assistantReservationConsumedRef) by whichever item's output_item.added fires first for that
  // response; a second item in the same response (e.g. commentary followed by final_answer) gets
  // its own fresh turn instead, since by then its position is already correctly determined by
  // having streamed after the first item, not by anything still waiting to be asked.
  const pendingAssistantTurnIds = useRef<string[]>([])
  const assistantReservationConsumedRef = useRef(false)
  const isGreetingInFlightRef = useRef(false)
  const mutedItemId = useRef<string | null>(null)
  const audioSamplesPlayed = useRef<number>(0)
  const lastAudioScheduledEndTimeRef = useRef<number>(0)
  const shouldDisconnectAfterResponse = useRef(false)
  const awaitingFarewellResponse = useRef(false)

  const transcriptContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptContainerRef.current
    if (!el) return
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX
  }, [])

  useEffect(() => {
    const el = transcriptContainerRef.current
    if (!el || !isNearBottomRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [turns])

  function addTurn(turn: Omit<VoiceTurn, "id">): string {
    const id = crypto.randomUUID()
    setTurns((prev) => [...prev, { ...turn, id }])
    return id
  }

  function updateTurn(id: string, updates: Partial<Omit<VoiceTurn, "id">>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...updates } : t)))
  }

  function removeTurn(id: string) {
    setTurns((prev) => prev.filter((t) => t.id !== id))
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

  const disconnectVoice = useCallback(() => {
    shouldDisconnectAfterResponse.current = false
    awaitingFarewellResponse.current = false
    wsRef.current?.close()
    wsRef.current = null
    stopMicCapture()
    setIsVoiceConnected(false)
    setVoiceStatus("idle")
    setTurns([])
  }, [])

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
      console.error("useRealtimeVoiceSession: startMicCapture failed:", err)
      return null
    }
  }

  const connectVoice = useCallback(async () => {
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
        const opts = optionsRef.current
        const vad = opts.vad ?? {}

        const allTools = [
          ...(opts.tools ?? []).map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          {
            type: "function",
            name: "end_conversation",
            description: `Call this tool ONLY when the user's own words are themselves a closing/farewell statement. Trigger phrases include: "no", "that is all", "nothing else", "i'm done", "no more", "goodbye", "bye", "nope", "all good", "that's it", "no thank you", "no thanks", or any similar closing response to "is there anything else?" Do NOT ask a follow-up question first. Call the tool immediately on these phrases. Do NOT call this tool for an actual question, no matter how broad, how similar to something already asked, or how much it might resemble a natural stopping point in the conversation — a real question (however phrased) is never a signal to end the conversation. If the input is a genuine question about this page's content, always answer it via the page's own content tool instead, never end_conversation.`,
            parameters: { type: "object", properties: {} },
          },
        ]

        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                transcription: { model: "gpt-realtime-whisper" },
                turn_detection: {
                  type: "server_vad",
                  threshold: vad.threshold ?? 0.8,
                  prefix_padding_ms: vad.prefixPaddingMs ?? 500,
                  silence_duration_ms: vad.silenceDurationMs ?? 1000,
                  interrupt_response: true,
                  create_response: true,
                },
              },
              output: { voice: opts.voice ?? "shimmer" },
            },
            tools: allTools,
            tool_choice: "auto",
            instructions: opts.instructions,
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

          if (opts.greetingInstructions) {
            ws.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Hello! I am ready to talk." }],
              },
            }))
            isGreetingInFlightRef.current = true
            ws.send(JSON.stringify({
              type: "response.create",
              response: { instructions: opts.greetingInstructions },
            }))
            isResponseInProgress.current = true
          }
        } catch (micErr) {
          console.error("useRealtimeVoiceSession: mic handshake failed:", micErr)
          setError("Could not access the microphone.")
          disconnectVoice()
        }
      }

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data as string)

        if (msg.type === "response.created") {
          isResponseInProgress.current = true
          // Each new response gets one chance to claim a pending reservation, at whichever of its
          // own items' output_item.added fires first (see pendingAssistantTurnIds above).
          assistantReservationConsumedRef.current = false
          const responseInstanceId = Math.random().toString(36).slice(2, 8)
          currentResponseInstanceIdRef.current = responseInstanceId
          logDiagnostic("response.created", {
            responseInstanceId,
            responseId: msg.response?.id ?? null,
            pendingAssistantTurnIds: [...pendingAssistantTurnIds.current],
            pendingUserTurnIds: [...(pendingUserTurnIds.current ?? [])],
          })
          if (gainNodeRef.current) gainNodeRef.current.gain.value = 1
        }

        if (msg.type === "response.done") {
          isResponseInProgress.current = false
          logDiagnostic("response.done", {
            responseInstanceId: currentResponseInstanceIdRef.current,
            responseId: msg.response?.id ?? null,
          })
          // Cleared once per response, not per-item — a greeting response with more than one
          // output item (e.g. a commentary item followed by a final_answer item) would otherwise
          // have its second item incorrectly treated as no longer part of the greeting.
          isGreetingInFlightRef.current = false

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

        // Barge-in: mute + truncate + cancel so an interruption doesn't leave two voices
        // overlapping, plus reserve this question's position in the transcript immediately — see
        // file header on stable turn-keying.
        if (msg.type === "input_audio_buffer.speech_started") {
          optionsRef.current.onSpeechStarted?.()
          // Defensive: a hot-reload that changes this ref's shape can leave an already-mounted
          // component with a stale value from before the edit (React preserves ref identity
          // across Fast Refresh rather than re-running the initializer) — guard rather than trust
          // the initial value alone.
          if (!pendingUserTurnIds.current) pendingUserTurnIds.current = []
          const newUserTurnId = addTurn({ role: "user", content: "" })
          pendingUserTurnIds.current.push(newUserTurnId)
          logDiagnostic("speech_started", {
            userTurnId: newUserTurnId,
            pendingUserTurnIds: [...pendingUserTurnIds.current],
            pendingAssistantTurnIds: [...pendingAssistantTurnIds.current],
            currentResponseInstanceId: currentResponseInstanceIdRef.current,
            isResponseInProgress: isResponseInProgress.current,
          })

          // Always interrupt on genuine barge-in, greeting included — deliberately reconsidered
          // and reverted from an earlier version of this fix that skipped cancellation during the
          // greeting specifically. That skip created a real risk: with create_response: true, the
          // server auto-triggers a response as soon as it detects the end of the user's speech —
          // if the greeting's own response were still active at that moment (since we'd stopped
          // cancelling it), two responses could end up active in the same session simultaneously,
          // a state this code elsewhere explicitly guards against ever allowing (e.g. the
          // isResponseInProgress check before every other manual response.create below). A
          // dropped or scrambled follow-up answer is a worse failure than the false-positive
          // barge-in this was meant to prevent, and that root cause was never actually confirmed.
          {
            // A still-streaming assistant item gets interrupted here — its partial content (what
            // was actually spoken before the interruption) is left as-is rather than removed. No
            // per-item tracking to reset: the next item gets its own fresh map entry at its own
            // output_item.added, keyed by its own item_id (see assistantTurnIdByItemId above).

            activeAudioSourcesRef.current.forEach((source) => {
              try { source.stop() } catch { /* already finished naturally */ }
            })
            activeAudioSourcesRef.current = []

            // Captured before the reset below (which zeroes the counter for the *next* item) — the
            // truncate call needs how much of the *current*, being-interrupted item actually played.
            // Previously this was read *after* the reset, so audio_end_ms was always sent as 0
            // regardless of how much the user had actually heard, telling the model's own
            // conversation history that its prior turn produced no audio at all.
            const samplesPlayedBeforeInterrupt = audioSamplesPlayed.current

            if (audioContextRef.current) {
              nextAudioStartTime = audioContextRef.current.currentTime
              lastAudioScheduledEndTimeRef.current = audioContextRef.current.currentTime
              audioSamplesPlayed.current = 0
            }
            if (gainNodeRef.current) gainNodeRef.current.gain.value = 0
            mutedItemId.current = currentAssistantItemId.current

            if (wsRef.current?.readyState === WebSocket.OPEN && isResponseInProgress.current) {
              // A function_call item has no audio content at all — truncating it is rejected by
              // the Realtime API with "Only model output audio messages can be truncated"
              // (unsupported_content_type). Only a message (audio-bearing) item is truncatable;
              // response.cancel still applies either way, since there's a response in progress to
              // cancel regardless of what its current item type is.
              if (currentAssistantItemId.current && currentAssistantItemType.current === "message") {
                const playedMs = Math.round((samplesPlayedBeforeInterrupt / 24000) * 1000)
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
        }

        if (msg.type === "conversation.item.input_audio_transcription.delta" && typeof msg.delta === "string") {
          optionsRef.current.onUserTranscriptDelta?.(msg.delta)
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          if (msg.transcript?.trim()) {
            const transcript = msg.transcript.trim()
            lastTranscriptRef.current = transcript
            const turnId = pendingUserTurnIds.current?.shift()
            if (turnId) {
              updateTurn(turnId, { content: transcript })
            }
            optionsRef.current.onUserTurn?.(transcript)
          }
        }

        if (msg.type === "response.function_call_arguments.done") {
          const callId = msg.call_id as string
          if (processedCallIds.current.has(callId)) return
          processedCallIds.current.add(callId)

          const rawTranscript = lastTranscriptRef.current
          lastTranscriptRef.current = ""

          if (msg.name === "end_conversation") {
            // Reserved for consistency with the tool-call path below, though this race is far
            // less likely here — nothing is awaited before response.create is sent.
            const endConversationTurnId = addTurn({ role: "assistant", content: "" })
            pendingAssistantTurnIds.current.push(endConversationTurnId)
            logDiagnostic("function_call_arguments.done.reserve", {
              callId,
              reservedTurnId: endConversationTurnId,
              name: msg.name,
              currentResponseInstanceId: currentResponseInstanceIdRef.current,
            })
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

          // Reserved synchronously, before awaiting the tool call below — see
          // pendingAssistantTurnIds' declaration for why this can't wait until output_item.added.
          const reservedTurnId = addTurn({ role: "assistant", content: "" })
          pendingAssistantTurnIds.current.push(reservedTurnId)
          logDiagnostic("function_call_arguments.done.reserve", {
            callId,
            reservedTurnId,
            name: msg.name,
            currentResponseInstanceId: currentResponseInstanceIdRef.current,
          })

          try {
            const args = msg.arguments ? JSON.parse(msg.arguments as string) : {}
            const responseText = (await optionsRef.current.onToolCall?.(msg.name, args, rawTranscript))
              ?? "Sorry, I couldn't answer that just now."

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
            // No response will ever come to consume this reservation — clean it up explicitly so
            // a later question's turn doesn't inherit this one's stale, never-filled placeholder.
            const idx = pendingAssistantTurnIds.current.indexOf(reservedTurnId)
            if (idx !== -1) pendingAssistantTurnIds.current.splice(idx, 1)
            removeTurn(reservedTurnId)
            console.error("useRealtimeVoiceSession: tool execution failed:", err)
            setError("Failed to process voice query.")
          }
        }

        if (msg.type === "response.output_item.added" && msg.item?.role === "assistant") {
          const itemId = msg.item.id as string
          currentAssistantItemId.current = itemId
          currentAssistantItemType.current = (msg.item.type as string | undefined) ?? null
          audioSamplesPlayed.current = 0
          mutedItemId.current = null
          assistantTextByItemId.current.set(itemId, "")
          // The greeting's own item(s) never become a visible turn (matching the pre-existing
          // convention of suppressing ambient/conversational content) — tracked explicitly via
          // isGreetingInFlightRef (cleared once, at the greeting response's own response.done,
          // not per-item — a multi-item greeting response would otherwise have its second item
          // incorrectly treated as no longer part of the greeting).
          if (!isGreetingInFlightRef.current) {
            // The first item of a response claims this response's reservation (if any) — see
            // pendingAssistantTurnIds' declaration. A second item in the same response (e.g.
            // commentary followed by final_answer) falls through to a fresh turn instead, since
            // there's nothing still waiting to be asked between two items of the same response.
            let turnId: string | undefined
            let consumedReservation = false
            if (!assistantReservationConsumedRef.current) {
              assistantReservationConsumedRef.current = true
              turnId = pendingAssistantTurnIds.current?.shift()
              consumedReservation = turnId !== undefined
            }
            const finalTurnId = turnId ?? addTurn({ role: "assistant", content: "" })
            assistantTurnIdByItemId.current.set(itemId, finalTurnId)
            logDiagnostic("output_item.added", {
              itemId,
              currentResponseInstanceId: currentResponseInstanceIdRef.current,
              consumedReservation,
              turnId: finalTurnId,
              freshlyCreated: !consumedReservation,
              pendingAssistantTurnIdsAfter: [...pendingAssistantTurnIds.current],
            })
          } else {
            logDiagnostic("output_item.added", {
              itemId,
              currentResponseInstanceId: currentResponseInstanceIdRef.current,
              suppressedAsGreeting: true,
              pendingAssistantTurnIdsAfter: [...pendingAssistantTurnIds.current],
            })
          }
        }

        // Streams the assistant's spoken text live into its item's own turn as it's generated —
        // the fix for the "blob" bug shared by every prior copy of this code (Insights/Compare/
        // Macro), which only ever populated text once output_item.done delivered it all at once.
        // Keyed by item_id (not a single "current" slot) so a second item in the same response
        // (e.g. a separate "commentary" item followed by a separate "final_answer" item) gets its
        // own turn instead of its deltas overwriting the first item's already-populated one.
        if (msg.type === "response.output_audio_transcript.delta" && typeof msg.delta === "string" && msg.item_id) {
          const itemId = msg.item_id as string
          const newText = (assistantTextByItemId.current.get(itemId) ?? "") + msg.delta
          assistantTextByItemId.current.set(itemId, newText)
          const turnId = assistantTurnIdByItemId.current.get(itemId)
          if (turnId) updateTurn(turnId, { content: newText })
        }

        if (msg.type === "response.output_item.done" && msg.item?.role === "assistant") {
          const itemId = msg.item.id as string
          const textContent = msg.item.content
            ?.map((c: { text?: string; transcript?: string }) => c.text ?? c.transcript ?? "")
            .join("")
            .trim()
          const hasFunctionCall = msg.item.content?.some(
            (c: { type?: string }) => c.type === "function_call",
          )
          const turnId = assistantTurnIdByItemId.current.get(itemId) ?? null
          assistantTurnIdByItemId.current.delete(itemId)
          assistantTextByItemId.current.delete(itemId)
          const wasGreeting = isGreetingInFlightRef.current

          // This item is now complete server-side — its id is no longer a valid target for
          // conversation.item.truncate. Left uncleared, a barge-in landing in the gap between this
          // event and the (slightly later) response.done would truncate an already-finalized item,
          // which the Realtime API rejects with "item_id not found." Short responses (e.g. a
          // one-sentence greeting) make that gap proportionally more likely to be hit.
          if (currentAssistantItemId.current === itemId) {
            currentAssistantItemId.current = null
            currentAssistantItemType.current = null
          }

          if (hasFunctionCall && !textContent) {
            // Pure tool-call item, nothing spoken — remove the (empty) placeholder.
            if (turnId) removeTurn(turnId)
          } else if (textContent && !wasGreeting) {
            // Persisted as a genuine turn regardless of phase (final_answer vs. commentary). The
            // phase filter used to hide non-final_answer items entirely — that existed only to
            // stop a filler bubble from racing ahead of the user's own question, a class of bug
            // now structurally prevented by stable speech-start keying instead (the user's turn
            // is always reserved first, before any assistant item can exist). With that ordering
            // guaranteed, there's no remaining reason to hide genuinely-spoken commentary — doing
            // so just made it flash on screen (while its audio played) and then vanish, which reads
            // as the same "overwritten" symptom the item_id-keying fix above was meant to resolve.
            if (turnId) {
              updateTurn(turnId, { content: textContent })
            } else {
              addTurn({ role: "assistant", content: textContent })
            }
            // onAssistantTurn is a page's bridge into its own richer turn state (e.g. Insights'
            // used_memory carry-across from handleQuery) — still gated to the true final answer
            // only, since that carry-across is specifically about grounded query results, not
            // incidental spoken remarks, and firing it twice per response risks the memory flag
            // being consumed by a commentary item before the real final answer reads it.
            if (msg.item?.phase === "final_answer") {
              optionsRef.current.onAssistantTurn?.(textContent)
            }
          } else if (turnId) {
            // The greeting — never left as a stray bubble.
            removeTurn(turnId)
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
          // Benign truncate-race: a barge-in landing between an item's own completion and the
          // (slightly later) response.done can still target an item the server has already
          // finalized, even with the item-tracking fix above — belt-and-suspenders suppression so
          // a harmless race never surfaces as a jarring "Voice error" toast.
          if (msg.error?.code === "item_not_found" || /item.*not found/i.test(msg.error?.message ?? "")) {
            console.warn("useRealtimeVoiceSession: benign truncate race, ignoring:", msg.error)
            return
          }
          console.error("useRealtimeVoiceSession: realtime API error:", msg.error)
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
  }, [disconnectVoice])

  return {
    isVoiceConnected,
    voiceStatus,
    error,
    turns,
    connectVoice,
    disconnectVoice,
    transcriptContainerRef,
    handleTranscriptScroll,
  }
}
