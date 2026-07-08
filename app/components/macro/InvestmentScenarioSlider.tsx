"use client"

// Client-side "what if" tool — pure arithmetic on values already returned by /api/macro. No API
// call, and deliberately not logged as an episodic_events row: this is a hypothetical the user is
// exploring, not a fact about them.
import { useState } from "react"

const MIN_RETURN = 3
const MAX_RETURN = 9
const DEFAULT_RETURN = 6
const RETURN_STEP = 0.5

interface Props {
  defaultAmount: number
  inflationRate: number
}

function formatRupees(value: number): string {
  return `₹${Math.round(Math.abs(value)).toLocaleString("en-IN")}`
}

export function InvestmentScenarioSlider({ defaultAmount, inflationRate }: Props) {
  const [amount, setAmount] = useState(Math.max(0, Math.round(defaultAmount)))
  const [assumedReturn, setAssumedReturn] = useState(DEFAULT_RETURN)

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
          <span className="font-medium text-slate-700">Amount (₹)</span>
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(Math.max(0, Math.round(Number(e.target.value) || 0)))}
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
            onChange={(e) => setAssumedReturn(Number(e.target.value))}
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
              If you moved {formatRupees(amount)} into something earning {assumedReturn.toFixed(1)}%,
              you&apos;d gain {formatRupees(netAnnualBenefit)}/year in purchasing power vs. leaving it idle.
            </>
          ) : (
            <>
              If you moved {formatRupees(amount)} into something earning {assumedReturn.toFixed(1)}%,
              you&apos;d still lose {formatRupees(netAnnualBenefit)}/year in purchasing power — less
              than leaving it idle, but still behind inflation.
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
