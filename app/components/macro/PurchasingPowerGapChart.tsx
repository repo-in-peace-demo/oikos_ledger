"use client"

// Purchasing-power gap (nominal - real) alone, at its own scale — split out from
// BalanceTrendChart because a large structural jump there (an account being added) dominates
// that chart's Y-axis, crushing the actual erosion gap (often just hundreds to low thousands of
// rupees against a balance in the lakhs) to imperceptibility. That's a scale conflict, not
// something line styling can fix, so this gets its own appropriately-scaled axis instead.
//
// Reuses buildChartPoints from lib/macro/balanceTrendPoints.ts — the exact same real-value
// calculation BalanceTrendChart uses, never a second formula — and the same shared SWR key
// (useBalanceHistory), so mounting both charts costs one network request, not two.
import {
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts"
import { formatCurrency } from "@/lib/currency"
import { buildChartPoints, useBalanceHistory } from "@/lib/macro/balanceTrendPoints"

interface Props {
  currencyCode: string
  inflationRatePct: number | null
}

export function PurchasingPowerGapChart({ currencyCode, inflationRatePct }: Props) {
  const { data, error } = useBalanceHistory()

  if (error) return null // best-effort chart — degrade to nothing rather than an error card
  if (inflationRatePct == null) return null // nothing to compute a gap from

  if (!data) {
    return <div className="h-32 rounded-lg border bg-slate-50 animate-pulse" />
  }

  const points = data.points

  // Same sparse-data honesty as BalanceTrendChart — no trend to show yet, don't force one.
  if (points.length < 2) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Still learning — this appears once at least two balance snapshots have been recorded.
      </p>
    )
  }

  const chartPoints = buildChartPoints(points, inflationRatePct)

  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={chartPoints} margin={{ top: 5, right: 12, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          {/* Deliberately no shared domain with BalanceTrendChart — auto-scaled to the gap's own
              (much smaller) range instead of being forced onto the ₹0–balance scale, which is
              exactly the crushing-to-imperceptibility problem this chart exists to avoid. */}
          <YAxis
            tickFormatter={(v) => formatCurrency(Number(v), currencyCode)}
            tick={{ fontSize: 11 }}
            width={72}
          />
          <Tooltip formatter={(v) => formatCurrency(Number(v), currencyCode)} />
          <Line type="linear" dataKey="gap" name="Purchasing power lost" stroke="#ef4444" strokeWidth={2} dot connectNulls />
        </LineChart>
      </ResponsiveContainer>
      <p className="text-[11px] text-muted-foreground">
        Purchasing power lost to inflation over time — your earliest recorded balance losing
        value at the current inflation rate every year since then, assuming it stayed in a
        low-interest account. Simple, non-compounded, not a forecast — the same approximation as
        the chart above. Unlike that chart, an account being added doesn&apos;t show up here: this
        line tracks erosion of your original starting balance only, not your current total.
      </p>
    </div>
  )
}
