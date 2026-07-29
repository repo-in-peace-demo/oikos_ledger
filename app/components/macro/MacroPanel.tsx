"use client"

import { useEffect, useRef, useState } from "react"
import { useMacro } from "@/lib/hooks/useMacro"
import { formatCurrency } from "@/lib/currency"
import { formatIndicatorValue } from "@/lib/macro/formatIndicator"
import { InvestmentScenarioSlider, DEFAULT_RETURN } from "./InvestmentScenarioSlider"
import { MacroVoiceButton, type MacroVoiceData } from "./MacroVoiceButton"
import { MemoryPanel } from "./MemoryPanel"

const INDICATOR_LABELS: Record<string, string> = {
  repo_rate: "RBI Repo Rate",
  inflation: "Inflation (CPI)",
  food_inflation: "Food Inflation",
  gdp_growth: "GDP Growth",
  gdp_per_capita: "GDP per Capita",
}

const INDICATOR_EMOJI: Record<string, string> = {
  repo_rate: "🏦",
  inflation: "📈",
  food_inflation: "🛒",
  gdp_growth: "📊",
  gdp_per_capita: "💰",
}

interface Props {
  firstName?: string
}

export function MacroPanel({ firstName }: Props) {
  const {
    indicators, facts, explanation, balances, currency, lastDistilledAt,
    gdpPerCapitaAgeNote, repoRateUnchangedNote,
    isLoading, isRefreshing, isError, refresh,
  } = useMacro()

  const hasBalanceInfo = balances.accounts.length > 0 || balances.accounts_without_data > 0
  const hasIndicators = indicators.length > 0
  const hasRealityContent = hasBalanceInfo || (hasIndicators && !!explanation)
  const inflationIndicator = indicators.find((i) => i.indicator === "inflation")

  // Lifted out of InvestmentScenarioSlider (which used to own this as local state) so
  // MacroVoiceButton can read the slider's live values — a voice question like "what if I
  // invested it at 8%" needs to answer against what's actually on screen, not a default it can't
  // see. Initialized once, lazily, the same moment the slider itself used to initialize via
  // defaultAmount — not reset on every subsequent balances refresh, which would clobber whatever
  // the user has since typed in.
  const [scenarioAmount, setScenarioAmount] = useState(0)
  const [scenarioAssumedReturn, setScenarioAssumedReturn] = useState(DEFAULT_RETURN)
  const scenarioInitialized = useRef(false)
  useEffect(() => {
    if (scenarioInitialized.current) return
    if (balances.combined_balance != null) {
      setScenarioAmount(Math.max(0, Math.round(balances.combined_balance)))
      scenarioInitialized.current = true
    }
  }, [balances.combined_balance])

  const macroVoiceData: MacroVoiceData | null = (!isLoading && !isError && hasIndicators)
    ? {
        indicators, explanation, balances, currency,
        gdpPerCapitaAgeNote, repoRateUnchangedNote,
        scenarioAmount, scenarioAssumedReturn,
      }
    : null

  // Fire-and-forget cache/cluster warm-up (see the prefetch branch in
  // /api/insights/query/route.ts for the full rationale and its honest-scope caveat). Macro
  // aggregates across all of a user's accounts rather than having one "selected" account like
  // Insights does, so this fires once per account_id it knows about, from the balances this page
  // already fetched — not a new lookup. Deliberately does not block render, show a loading state,
  // or surface its result anywhere.
  const prefetchedAccountIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const account of balances.accounts) {
      if (prefetchedAccountIds.current.has(account.account_id)) continue
      prefetchedAccountIds.current.add(account.account_id)

      // Logged so it's observable (in the browser console, correlated against server logs by
      // timestamp) whether this actually finished before the user's first real question fired.
      const firedAt = Date.now()
      console.log(`[prefetch] fired for account ${account.account_id} at ${new Date(firedAt).toISOString()}`)
      fetch("/api/insights/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefetch: true, account_id: account.account_id }),
      }).then(() => {
        console.log(`[prefetch] completed for account ${account.account_id} in ${Date.now() - firedAt}ms`)
      }).catch(() => {
        // Best-effort only — nothing is watching this result beyond this log.
        console.log(`[prefetch] failed for account ${account.account_id} after ${Date.now() - firedAt}ms`)
      })
    }
  }, [balances.accounts])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b bg-background px-6 py-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold">Macro Context</h2>
          <p className="text-xs text-muted-foreground max-w-md">
            We track national economic trends (inflation, RBI rate changes) and connect them to
            your own balance, so you know what they actually mean for your money.
          </p>
        </div>
        <button
          onClick={() => refresh()}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs
            font-medium text-muted-foreground hover:text-foreground hover:bg-accent
            transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          <span className={isRefreshing ? "animate-spin" : ""}>↻</span>
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-xl border bg-slate-50 animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex h-32 items-center justify-center text-sm text-destructive">
            Failed to load macro data.
          </div>
        ) : (
          <>
            <MacroVoiceButton macroData={macroVoiceData} firstName={firstName} />

            {/* Context — the economic backdrop, national data, not specific to you */}
            <section className="space-y-4">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Context</p>
                <p className="text-xs text-muted-foreground">
                  The economic backdrop — national data, not specific to you.
                </p>
              </div>

              {!hasIndicators ? (
                <div className="flex flex-col h-48 items-center justify-center gap-2 text-center">
                  <p className="text-3xl">🌐</p>
                  <p className="font-semibold text-slate-700">No macro data yet</p>
                  <p className="text-sm text-muted-foreground max-w-sm">
                    Macro-economic indicators haven&apos;t been ingested yet. Run the macro ingestion
                    job to populate RBI and World Bank data.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {indicators.map((i) => (
                    <div key={i.indicator} className="rounded-xl border bg-card p-4 space-y-1">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{INDICATOR_EMOJI[i.indicator] ?? "📌"}</span>
                        {INDICATOR_LABELS[i.indicator] ?? i.indicator}
                      </div>
                      <p className="text-xl font-semibold text-slate-800">
                        {formatIndicatorValue(i.indicator, i.value)}
                      </p>
                      {i.indicator === "gdp_per_capita" && gdpPerCapitaAgeNote ? (
                        <p className="text-xs text-amber-600">{gdpPerCapitaAgeNote}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {i.period} · {i.source}
                        </p>
                      )}
                      {i.indicator === "repo_rate" && repoRateUnchangedNote && (
                        <p className="text-xs text-muted-foreground">{repoRateUnchangedNote}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Reality — what's actually true for you, now and over time */}
            {hasRealityContent && (
              <section className="space-y-4">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your actual situation</p>
                </div>

                {hasBalanceInfo && (
                  <div className="rounded-xl border bg-card p-5 space-y-3">
                    <p className="text-sm font-semibold text-slate-700">Cash across your accounts</p>

                    {balances.state !== "not_blended" && balances.combined_balance != null && (
                      <div className="space-y-2">
                        <p className="text-2xl font-semibold text-slate-800">
                          {formatCurrency(balances.combined_balance, currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Combined across {balances.accounts.length} account
                          {balances.accounts.length === 1 ? "" : "s"} · reference month {balances.reference_month}
                        </p>
                        {balances.state === "blended_with_caveat" && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                            <span className="text-amber-500 shrink-0">⚠️</span>
                            <p className="text-xs text-amber-700">
                              Your accounts&apos; most recent data spans different months — this total
                              may not be perfectly aligned. See the breakdown below.
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {balances.state === "not_blended" && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                        <span className="text-amber-500 shrink-0">⚠️</span>
                        <p className="text-xs text-amber-700">
                          Your accounts&apos; data is too far apart (or one hasn&apos;t been updated in a
                          while) to combine into a single figure — shown separately below.
                        </p>
                      </div>
                    )}

                    {balances.accounts.length > 0 && (
                      <div className="space-y-1.5">
                        {balances.accounts.map((a) => (
                          <div key={a.account_id} className="flex items-center justify-between text-xs">
                            <span className="font-medium text-slate-700">
                              {a.label}
                              {a.excluded_from_blend && (
                                <span className="ml-1.5 text-amber-600">(too stale to combine)</span>
                              )}
                            </span>
                            <span className="text-muted-foreground">
                              {formatCurrency(a.closing_balance, currency)} · as of {a.as_of_month}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {balances.accounts_without_data > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {balances.accounts_without_data} account
                        {balances.accounts_without_data === 1 ? "" : "s"} with no uploaded data yet —
                        excluded above.
                      </p>
                    )}
                  </div>
                )}

                {hasIndicators && explanation && (
                  <div className="rounded-xl border bg-slate-50 p-5 space-y-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <p className="text-sm font-semibold text-slate-700">What this means for you</p>
                        <span
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary cursor-help"
                          title="This is personalized synthesis — it combines the indicators above with your own account balance. It's not another data card; the numbers here are computed specifically for you."
                        >
                          Personalized
                        </span>
                      </div>
                      <p className="text-sm text-slate-600 leading-relaxed">{explanation}</p>
                    </div>

                    <MemoryPanel facts={facts} lastDistilledAt={lastDistilledAt} />
                  </div>
                )}
              </section>
            )}

            {/* Action — the one interactive thing the page invites you to do */}
            {hasIndicators && inflationIndicator && (
              <section className="space-y-4">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What you can do about it</p>
                </div>
                <InvestmentScenarioSlider
                  amount={scenarioAmount}
                  onAmountChange={setScenarioAmount}
                  assumedReturn={scenarioAssumedReturn}
                  onAssumedReturnChange={setScenarioAssumedReturn}
                  inflationRate={Number(inflationIndicator.value)}
                  currencyCode={currency}
                />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
