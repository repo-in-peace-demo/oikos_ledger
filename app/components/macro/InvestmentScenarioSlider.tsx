"use client"

// Client-side "what if" tool — pure arithmetic on values already returned by /api/macro. No API
// call, and deliberately not logged as an episodic_events row: this is a hypothetical the user is
// exploring, not a fact about them.
//
// Amount/assumedReturn are controlled (lifted to MacroPanel), not local state — MacroVoiceButton
// needs read access to whatever the user currently has the slider set to, so a voice question
// like "what if I invested it at 8%" answers against what's actually on screen right now, not a
// component-local default it can't see.
import { formatCurrency, getCurrencySymbol } from "@/lib/currency"

export const MIN_RETURN = 3
export const MAX_RETURN = 9
export const DEFAULT_RETURN = 6
const RETURN_STEP = 0.5

interface Props {
  amount: number
  onAmountChange: (amount: number) => void
  assumedReturn: number
  onAssumedReturnChange: (assumedReturn: number) => void
  inflationRate: number
  currencyCode: string
}

export function InvestmentScenarioSlider({
  amount, onAmountChange, assumedReturn, onAssumedReturnChange, inflationRate, currencyCode,
}: Props) {
  const netAnnualBenefit = amount * (assumedReturn / 100) - amount * (inflationRate / 100)
  const isGain = netAnnualBenefit >= 0

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <div>
        <p className="text-sm font-semibold text-slate-700">What if you invested it instead?</p>
        <p className="text-xs text-muted-foreground">
          A hypothetical you control — your amount, your assumed rate, not a recommendation.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5 text-xs">
          <span className="font-medium text-slate-700">Amount ({getCurrencySymbol(currencyCode)})</span>
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => onAmountChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm
              focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>

        <label className="block space-y-1.5 text-xs">
          <span className="font-medium text-slate-700">
            Assumed Return — not guaranteed ({assumedReturn.toFixed(1)}%)
          </span>
          <input
            type="range"
            min={MIN_RETURN}
            max={MAX_RETURN}
            step={RETURN_STEP}
            value={assumedReturn}
            onChange={(e) => onAssumedReturnChange(Number(e.target.value))}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{MIN_RETURN}%</span>
            <span>{MAX_RETURN}%</span>
          </div>
        </label>
      </div>

      <div className="rounded-lg border bg-slate-50 px-4 py-3">
        <p className="text-sm text-slate-700 leading-relaxed">
          {isGain ? (
            <>
              If you moved {formatCurrency(amount, currencyCode)} into something earning {assumedReturn.toFixed(1)}%,
              your real wealth (purchasing power) would increase by ~{formatCurrency(netAnnualBenefit, currencyCode)}/year
              compared to leaving it in your current account.
            </>
          ) : (
            <>
              If you moved {formatCurrency(amount, currencyCode)} into something earning {assumedReturn.toFixed(1)}%,
              your real wealth (purchasing power) would still decrease by ~{formatCurrency(netAnnualBenefit, currencyCode)}/year
              — less than leaving it idle, but still behind inflation.
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Breakeven return: {inflationRate.toFixed(2)}% — any return above this beats inflation;
          exactly at it merely offsets erosion rather than growing real value.
        </p>
      </div>
    </div>
  )
}
