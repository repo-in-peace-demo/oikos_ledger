# Oikos Ledger — UI Architecture

## Layout

Three-column layout rendered inside `app/(dashboard)/layout.tsx`:

1. **Nav sidebar** — icon-only (56px), tooltips on hover. Nav items: Dashboard, Insights, Recommendations, Analytics, Compare, Macro Context.
2. **Accounts panel** — 220px fixed, lists bank accounts for the authenticated user
3. **Main panel** — `flex-1`, fills remaining space (transactions, insights, recommendations, or analytics)

---

## Accounts Panel

`components/accounts/AccountsSidebar.tsx`

- Lists all bank accounts via `useAccounts()` (SWR, `GET /api/bank-accounts`), ordered by most recent upload
- Selected account highlighted with a filled primary-colour dot
- Bank logo fetched via Google Favicon API; falls back to `public/fallback-bank-icon.svg`
- History clock icon on selected account row — opens Upload History modal
- Add bank account button pinned at bottom
- Selection stored in `localStorage` under `oikos_selected_account_id` and shared via `AccountsContext`
- New accounts auto-selected on creation

---

## Transactions Panel

`components/transactions/TransactionsPanel.tsx`

### Header (sticky)

- Bank logo, bank name, currency symbol
- Upload Statement button — opens `UploadStatementModal`

### Filter Bar (sticky, below header)

`components/transactions/FilterBar.tsx`

```
Row 1: [ Search merchants ] [ Category ▼ ] [ Method ▼ ] [ Min ₹ ] [ Max ₹ ]
Row 2: [ Jan 2026 ] [ Feb 2026 ] [ Mar 2026 ] [ Custom Range ]
Row 3: [ From  →  To ] (visible only when Custom Range is selected)
```

- Month tabs populated from `GET /api/transactions/months` (up to 3 most recent)
- Category dropdown populated from `GET /api/categories`
- Filter state held in `TransactionsPanel` and reset on account switch
- Search debounce uses `filtersRef` and `onChangeRef` refs so the closure always reads current state without causing extra re-renders or resetting pagination

### Transaction List (scrollable)

`components/transactions/TransactionGroup.tsx`

- Transactions grouped by month; each group rendered by `TransactionGroup`
- **Month heading** (sticky): `{Month name} | Opening ₹X | Debits –₹X | Credits +₹X | Closing ₹X | ⚠ Balance mismatch`
- Opening and closing balances fetched from `GET /api/transactions/balances` on filter/account change — not derived from transaction data on the client
- 20 transactions per page
- Columns: Date · Merchant · Category · Method · Amount
- Edit icon on row hover
- Blue dot on rows with amendments (`is_amended: true`)

### Pagination (sticky at bottom)

`components/transactions/Pagination.tsx`

- Shows `{offset + 1}–{offset + pageSize} of {total} transactions`
- Previous / Next buttons; disabled at boundaries

---

## Analytics Panel

`components/analytics/AnalyticsPanel.tsx`

Four-tab breakdown of spending across different dimensions. All data comes from deterministic SQL via `POST /api/analytics` — no LLM.

### Tabs

| Tab | Dimension | Chart type | Filters |
|---|---|---|---|
| Merchants | Top 15 merchants by spend | `bar` | months, transaction type, category |
| Payment Methods | Spend by method over time (pivoted wide) | `multi_bar` | months, transaction type |
| Subcategories | Top 15 subcategories by spend | `bar` | months, transaction type, category |
| Debit vs Credit | Monthly debit/credit comparison | `comparison_bar` | months |

### Filters

- **Month range** — Last 3 / 6 / 12 months
- **Transaction type** — Debits / Credits / All (hidden on Debit vs Credit tab)
- **Category** — populated from `GET /api/transactions/categories` (shown on Merchants and Subcategories tabs)

### Persistence

- Active tab stored in `localStorage` under `oikos_analytics_active_tab`
- Filters stored per account per tab under `oikos_analytics_{accountId}_{tab}`
- Filters restored on tab switch and account switch; fall back to defaults if no saved state

---

## Insights Panel

`components/insights/InsightsPanel.tsx`

### Chat Interface

- Message history persisted per account in `sessionStorage` (`insights_turns_{accountId}`)
- Conversation restored on mount and on account switch
- Quick question buttons: Monthly trend · Biggest expenses · Credits vs Debits · Top merchants · Spending by category

### Input Bar

- Text input with Enter-to-send
- Speaker button (audio toggle for browser TTS) — hidden when voice is active
- Voice button (connect/disconnect) — disabled when `NEXT_PUBLIC_VOICE_ENABLED !== "true"`
- Date filter toggle — persisted per account in `sessionStorage` (`insights_filter_{accountId}`)

### TurnCard

`components/insights/TurnCard.tsx`

- **User bubble** — dark background, right-aligned
- **Assistant bubble** — suppressed when content is empty and SQL/results are present (voice mode data cards)
- **Chart card** — open by default, collapsible; renders `InsightsChart` based on `chart_type`
- **Table card** — open by default, collapsible
- **SQL card** — collapsed by default, expandable with copy button
- **Cached badge** — `⚡ cached` appears inside bubble when `cached: true`
- **From-memory badge** — `🧠 from memory` appears inside bubble when `used_memory: true` (a semantic_facts match cleared the similarity threshold and was used); voice mode never shows this badge since the bubble itself is suppressed there, but the model is separately instructed to phrase such references naturally (e.g. "I've noticed that...") via the system prompt
- **Suggestions** — clickable buttons that trigger cached query lookup

### InsightsChart

`components/insights/InsightsChart.tsx`

Supported chart types:

| Type | X-axis detection | Y-axis |
|---|---|---|
| `line` | Key containing "day", "week", "month", "date" | All numeric columns (single series) |
| `bar` | `category` or `normalized_merchant` | `total` or `amount` column |
| `horizontal_bar` | same as bar | same as bar |
| `comparison_bar` | `month` | `debits` and `credits` |
| `multi_bar` | `month` / `week` / `day` / `date` | All remaining numeric columns as grouped bar series |
| `pie` | `category` | `total` with `percentage` |
| `table` | — | All columns, max 20 rows |
| `none` | — | Not rendered |

Line chart uses `connectNulls={true}` to bridge sparse date sequences. Single-point line charts fall back to bar. `multi_bar` derives series keys dynamically from column names — used for the payment methods tab where column names vary by account.

---

## Macro Panel

`components/macro/MacroPanel.tsx`

Data comes from `useMacro()` (SWR on `GET /api/macro`, `revalidateOnFocus: false`, `dedupingInterval: 60000`), exposing `indicators`, `facts`, `explanation`, `balances`, `currency`, `lastDistilledAt`, and a manual `refresh()`.

### Layout

- **Header** — manual Refresh button, `MacroVoiceButton`, and a collapsed-by-default "How this works" section.
- **Context** — indicator cards (RBI Repo Rate, Inflation (CPI), Food Inflation, GDP Growth, GDP per Capita), each showing a formatted value plus period/source. GDP per capita shows an "N months old" age note instead of a period (it's a reporting-gap disclosure, not a stability claim); repo rate shows an "Unchanged since ..." note (the repo rate genuinely only changes at RBI MPC meetings, so this framing is deliberately different from GDP per capita's). Empty state prompts to run the macro ingestion job if no indicators exist yet.
- **Your actual situation** (shown only once there's balance or indicator+explanation content):
  - Cash-across-accounts summary card, with a caveat banner if the user's accounts' balances are too far apart in recency to combine cleanly (`blended_with_caveat`) or can't be combined at all (`not_blended`).
  - **Erosion synthesis** — a "Personalized" badge and server-composed narrative combining the live inflation rate with the user's own balance (annual/monthly purchasing-power loss), a GDP-vs-erosion comparison sentence when both indicators are present, and any relevant confirmed memory facts, alongside `MemoryPanel`.
  - `BalanceTrendChart` — nominal vs. real (inflation-adjusted) balance, Recharts `LineChart`, with amber reference-line markers where the set of contributing accounts changed (so a structural jump from adding an account isn't misread as a balance trend).
  - `PurchasingPowerGapChart` — a second, separate chart isolating just the erosion amount (nominal − real) on its own auto-scaled axis, since a combined chart would let a structural jump dominate the axis and hide the actual erosion.
- **What you can do about it** — `InvestmentScenarioSlider` (shown only if an inflation indicator exists): adjustable hypothetical amount + assumed annual return (3–9%, step 0.5), computing net benefit vs. inflation client-side. Its state is lifted into `MacroPanel` (not local) so `MacroVoiceButton` can read live slider values. Deliberately never logged as a fact — it's a hypothetical, not an observation about the user.

### Memory Panel

`components/macro/MemoryPanel.tsx` — lists `trend:balance_snapshot` facts: a ✅/🤔 icon by confidence, description, "Confirmed"/"Tentative" label, occurrence count, and last-updated date. Empty state: "Still learning...". Shares `confidenceCardClassName()` (`lib/memoryCardStyle.ts`) with Compare's memory panel below.

---

## Compare Panel

`components/analytics/ComparePanel.tsx`

Lets a user pick exactly two of their bank accounts to compare — `MAX_COMPARE_ACCOUNTS = 2`, enforced both by disabling further checkboxes in the UI once two are selected and by the underlying `semantic_facts` schema, which has exactly one `account_id` and one `compared_account_id` column (built for a pair, not N accounts).

- **Category spend deltas** — a table of categories with each selected account's value and the delta between them.
- **Shared vs. unique categories** — which categories both accounts have spent in vs. categories unique to one.
- **Memory panel** — `trend:comparison_snapshot` facts: which account has run higher in a shared category across consecutive Compare checks, with the same confirmed/tentative styling as Macro's memory panel (shared `confidenceCardClassName()` helper).
- **Color-coding** — a fixed two-entry palette (indigo / pink), keyed by selection order (first selected = indigo, second = pink), not by account identity — so two accounts at the same bank still get distinguishable colors.
- **Voice narration** via `CompareVoiceButton`.

---

## Voice Interface

`app/lib/voice/useRealtimeVoiceSession.ts` (shared hook) + `app/components/voice/VoiceButton.tsx` (shared button/status-bar/transcript UI)

Four pages use voice — Insights, Compare, Macro, Recommendations. Each independently copied the WebSocket/audio/turn-ordering mechanics at first, accumulating inconsistent fixes; all four now share one hook. Compare and Macro also share the presentational `VoiceButton`. Insights keeps its own chat UI (SQL/chart-bearing data cards) and wires the hook's callbacks into its existing turn state instead. Recommendations keeps its own header-integrated button (visually predates the shared one) but runs on the same hook.

### Connection Flow

1. `connectVoice()` — warm up mic → fetch ephemeral key (`POST /api/insights/session`, generic across all four pages) → open WebSocket → send `session.update` (page-specific instructions/tools/VAD)
2. Greeting sent after mic connected via `response.create` with page-specific greeting instructions (skipped if a page doesn't configure one); tracked via `isGreetingInFlightRef` so it never becomes a visible turn
3. VAD detects speech → `input_audio_buffer.speech_started` → reserve a user-turn placeholder (see Turn Ordering below), mute gain, send `response.cancel` + `conversation.item.truncate` (only if the interrupted item is a `message`, not a `function_call`)
4. Transcription completed → fill the reserved placeholder, call the page's `onUserTurn` callback if provided
5. Tool call fires (`response.function_call_arguments.done`) → reserve an assistant-turn placeholder *before* awaiting the tool's backend fetch → call the page's tool handler → send `function_call_output` → `response.create` if not already in progress
6. Assistant text streams in live via `response.output_audio_transcript.delta`, keyed per `item_id`
7. `end_conversation` tool → 300ms delay → set `awaitingFarewellResponse` → `response.create`
8. `response.done` with `awaitingFarewellResponse` → promote to `shouldDisconnectAfterResponse` → disconnect after audio drains

### Turn Ordering

Both directions are keyed *before* the corresponding content exists:

- **User turns**: reserved at `speech_started`, filled at transcription-complete. FIFO queue (`pendingUserTurnIds`) — a second utterance's `speech_started` can fire before the first utterance's transcription lands, so a single ref would misattribute the fill.
- **Assistant turns**: reserved synchronously at `function_call_arguments.done`, before the `await` on the tool's own backend call — that call can take long enough for the user to ask a follow-up question in the meantime. Also a FIFO queue (`pendingAssistantTurnIds`); cleaned up explicitly if the tool call throws.
- **Assistant text**: keyed per `item_id` (`Map`, not a single "current" slot) — one response can contain more than one assistant item (e.g. a "commentary" item followed by a separate "final_answer" item), and a shared slot would have the second item's deltas overwrite the first's already-populated turn.

### Voice vs Text Mode Differences (Insights only — the other three pages are voice-first with no separate text mode)

| Behaviour | Text mode | Voice mode |
|---|---|---|
| Text bubble | Shows streamed content | Suppressed (content = "") |
| Data card (SQL + chart) | Always shown | Always shown |
| Suggestions | Shown | Suppressed |
| Off-topic canned message | Shown | Suppressed (model handles via audio) |
| Audio playback | Optional via speaker button | Always on (via Realtime API) |

### Barge-in

- Server-side VAD with `interrupt_response: true` handles auto-cancellation
- Client-side: on `speech_started`, GainNode gain set to 0 (mutes buffered audio), `mutedItemId` set to skip in-flight deltas
- `conversation.item.truncate` sent with `audio_end_ms` = samples played × (1000/24000) — captured *before* the sample counter resets for the next item, and only for a `message`-type current item (a `function_call` item has no audio; truncating one is rejected with `unsupported_content_type`)
- `currentAssistantItemId` cleared as soon as its item completes — left uncleared, a barge-in landing in the gap before `response.done` fires could target an already-finalized item ("item_id not found")
- `response.created` restores gain to 1 for the new response
- `response_cancel_not_active` errors suppressed silently

### Audio Pipeline

```
Mic → AudioWorklet (PCM 16kHz) → WebSocket → OpenAI
OpenAI → audio delta (PCM 24kHz) → AudioBufferSourceNode → GainNode → destination
```

- `audioSamplesPlayed` ref tracks playback position for truncation
- `currentAssistantItemId` / `currentAssistantItemType` refs track the active item and whether it's truncatable
- `lastAudioScheduledEndTimeRef` used for disconnect timing

### Transcript Window

Optional per page (`showTranscript` on `VoiceButton`) — Recommendations opts out (no transcript shown) while the hook still tracks turns internally; Compare and Macro opt in via the shared `VoiceButton`; Insights renders its own richer turn list instead. Where shown, the window is visible as soon as the session connects (not gated on any turn existing yet, so it's already open when the greeting plays) and auto-scrolls only when the user was already near the bottom, using `Element.scrollTo` on the transcript container itself rather than `scrollIntoView` (which can leak scroll to ancestor containers).

---

## State Management

| Concern | Mechanism |
|---|---|
| Server data | SWR with `keepPreviousData: true` |
| Upload polling | `setInterval` every 1s |
| Selected account | `localStorage` + `AccountsContext` |
| Filter state | `useState` in `TransactionsPanel`, reset on account switch |
| Per-month balances | `useState` in `TransactionsPanel`, fetched from `/api/transactions/balances` on filter/account change |
| Analytics filters | `localStorage` per account per tab, restored on tab/account switch |
| Analytics active tab | `localStorage` under `oikos_analytics_active_tab` |
| Insights turns | `sessionStorage` per account, restored on mount and account switch |
| Date filter | `sessionStorage` per account |
| Voice refs | `useRef` (never causes re-renders) for WebSocket, AudioContext, timers, flags — shared across all 4 voice-enabled pages via `useRealtimeVoiceSession` |

---

## Amendment Flow

1. Edit icon on transaction row opens `AmendTransactionModal`
2. Immutable fields shown read-only; editable: merchant, category, subcategory, payment method
3. Only changed fields submitted as amendments
4. `POST /api/transactions/[id]/amend` writes to `transaction_amendments`
5. If `normalized_merchant` changed and passes validation, `merchants` table upserted
6. Blue dot appears on row; SWR revalidates transaction list

---

## Upload Flow

1. Upload Statement button opens modal
2. SHA-256 hash computed client-side
3. `POST /api/upload` → `uploads` row created, CSV streamed to S3, Lambda invoked async
4. `setInterval` polls `GET /api/upload/{id}` every 1s
5. Modal shows: Uploading → Parsing → Normalising → Embedding → Complete
6. On complete: row count shown, balance warning badge if `balance_verified === false`
7. Modal auto-closes after 2s; `mutateTransactions()` and `mutateMonths()` called
8. Cancel during polling: `DELETE /api/upload/{id}` — 409 means race condition (upload just completed), modal transitions to success

---

## Upload History

`components/uploads/UploadHistoryModal.tsx`

- Opened via history clock icon on selected account in sidebar
- Table: filename · uploaded date · row count · balance badge · status badge · delete button
- Delete disabled for `pending`/`processing` uploads
- Confirm-to-delete flow with `DELETE /api/upload/{id}?force=true`
- After deletion: SWR global `mutate` revalidates all `/api/transactions*` caches
