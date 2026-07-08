"use client"

import { useMacro } from "@/lib/hooks/useMacro"
import { InvestmentScenarioSlider } from "./InvestmentScenarioSlider"

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

function formatValue(indicator: string, value: string): string {
  const n = Number(value)
  if (indicator === "gdp_per_capita") {
    return `$${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
  }
  return `${n.toFixed(2)}%`
}

function formatRupees(value: number): string {
  return `₹${Math.round(value).toLocaleString("en-IN")}`
}

export function MacroPanel() {
  const { indicators, facts, explanation, balances, isLoading, isError } = useMacro()

  const hasBalanceInfo = balances.accounts.length > 0 || balances.accounts_without_data > 0

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b bg-background px-6 py-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold">Macro Context</h2>
          <p className="text-xs text-muted-foreground">
            RBI and World Bank indicators, with distilled context from your history
          </p>
        </div>
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
            {hasBalanceInfo && (
              <div className="rounded-xl border bg-card p-5 space-y-3">
                <p className="text-sm font-semibold text-slate-700">Cash across your accounts</p>

                {balances.state !== "not_blended" && balances.combined_balance != null && (
                  <div className="space-y-2">
                    <p className="text-2xl font-semibold text-slate-800">
                      {formatRupees(balances.combined_balance)}
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
                          {formatRupees(a.closing_balance)} · as of {a.as_of_month}
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

            {indicators.length === 0 ? (
              <div className="flex flex-col h-48 items-center justify-center gap-2 text-center">
                <p className="text-3xl">🌐</p>
                <p className="font-semibold text-slate-700">No macro data yet</p>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Macro-economic indicators haven&apos;t been ingested yet. Run the macro ingestion
                  job to populate RBI and World Bank data.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {indicators.map((i) => (
                    <div key={i.indicator} className="rounded-xl border bg-card p-4 space-y-1">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{INDICATOR_EMOJI[i.indicator] ?? "📌"}</span>
                        {INDICATOR_LABELS[i.indicator] ?? i.indicator}
                      </div>
                      <p className="text-xl font-semibold text-slate-800">
                        {formatValue(i.indicator, i.value)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {i.period} · {i.source}
                      </p>
                    </div>
                  ))}
                </div>

                {explanation && (
                  <div className="rounded-xl border bg-slate-50 p-5">
                    <p className="text-sm font-semibold text-slate-700 mb-2">What this means for you</p>
                    <p className="text-sm text-slate-600 leading-relaxed">{explanation}</p>
                  </div>
                )}

                {(() => {
                  const inflation = indicators.find((i) => i.indicator === "inflation")
                  if (!inflation) return null
                  return (
                    <InvestmentScenarioSlider
                      defaultAmount={balances.combined_balance ?? 0}
                      inflationRate={Number(inflation.value)}
                    />
                  )
                })()}

                {facts.length > 0 && (
                  <div className="rounded-xl border bg-card p-5 space-y-3">
                    <p className="text-sm font-semibold text-slate-700">Remembered from your history</p>
                    <div className="space-y-2">
                      {facts.map((f) => (
                        <div key={f.id} className="flex items-start gap-2 text-xs">
                          <span className="text-muted-foreground shrink-0">
                            {f.confidence_status === "confirmed" ? "✅" : "🤔"}
                          </span>
                          <span className="text-slate-600">{f.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
