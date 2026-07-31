"use client"

// Nominal-vs-real combined-balance trend, sourced from /api/macro/balance-history (which mirrors
// distillation/pipeline/distiller.py's _extract_balance_snapshots — see that route's own header
// comment). The real (inflation-adjusted) line uses the exact same simple, non-compounded
// approximation already disclosed elsewhere on this page (composeMacroExplanation's erosion
// sentence, InvestmentScenarioSlider) — deliberately not a more sophisticated formula than what's
// already stated to the user. Point-building (buildChartPoints) lives in
// lib/macro/balanceTrendPoints.ts, shared with PurchasingPowerGapChart.tsx so the two charts can
// never compute "real" two different ways.
import {
  LineChart, Line, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts"
import { formatCurrency } from "@/lib/currency"
import { buildChartPoints, formatPointLabel, useBalanceHistory } from "@/lib/macro/balanceTrendPoints"

interface Props {
  currencyCode: string
  // The current inflation indicator value (%), already fetched by the page — null if not
  // available, in which case only the nominal line is shown (no real-value line without a rate
  // to apply).
  inflationRatePct: number | null
}

export function BalanceTrendChart({ currencyCode, inflationRatePct }: Props) {
  const { data, error } = useBalanceHistory()

  if (error) return null // best-effort chart — degrade to nothing rather than an error card

  if (!data) {
    return (
      <div className="h-40 rounded-lg border bg-slate-50 animate-pulse" />
    )
  }

  const points = data.points

  // Honest about sparse history — never interpolate/smooth to imply more data exists than it
  // does. A single point (or none) can't show a trend line at all (recharts renders a one-point
  // line invisibly anyway — see InsightsChart.tsx's own note on this), so say so plainly instead.
  if (points.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Still learning — this chart appears once at least two balance snapshots have been
        recorded (one from each of two separate visits to this page).
      </p>
    )
  }
  if (points.length === 1) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Only one balance snapshot recorded so far ({formatPointLabel(points[0].timestamp)}) —
        the trend line appears from your next visit onward.
      </p>
    )
  }

  const chartPoints = buildChartPoints(points, inflationRatePct)
  const changeMarkers = chartPoints.filter((p) => p.accountSetChanged)

  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartPoints} margin={{ top: 5, right: 12, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis
            tickFormatter={(v) => formatCurrency(Number(v), currencyCode)}
            tick={{ fontSize: 11 }}
            width={72}
          />
          <Tooltip formatter={(v) => formatCurrency(Number(v), currencyCode)} />
          <Legend />
          {/* "Real" is dashed and drawn on top deliberately — the erosion adjustment is often
              small relative to a balance jump caused by adding an account, so at typical zoom
              the two lines can sit almost exactly on top of each other. A same-style solid line
              drawn later would fully mask the one underneath even though their values genuinely
              differ; the dash pattern keeps both visually distinguishable regardless of how
              closely they track. See PurchasingPowerGapChart for the gap itself at its own scale. */}
          <Line type="linear" dataKey="nominal" name="Nominal" stroke="#6366f1" strokeWidth={2} dot connectNulls />
          {inflationRatePct != null && (
            <Line
              type="linear"
              dataKey="real"
              name="Real (inflation-adjusted)"
              stroke="#ef4444"
              strokeWidth={2}
              strokeDasharray="6 3"
              dot={{ r: 3 }}
              connectNulls
            />
          )}
          {/* Every account-set change gets its own marker — a sharp jump in the nominal line is
              never left to be misread as organic balance growth. Mirrors
              _classify_balance_steps' "account_set_changed" detection (distiller.py): only
              flagged when both snapshots have a known account set and it actually differs. */}
          {changeMarkers.map((m) => (
            <ReferenceLine
              key={m.timestamp}
              x={m.label}
              stroke="#f59e0b"
              strokeDasharray="4 4"
              label={{ value: "Account added", position: "insideTopLeft", fontSize: 10, fill: "#b45309" }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p className="text-[11px] text-muted-foreground">
        &quot;Real&quot; approximates today&apos;s purchasing power the same simple way as the
        erosion estimate above: your earliest recorded balance losing value at the current
        inflation rate every year since then, assuming it stayed in a low-interest account —
        not compounded, and not a forecast.
      </p>
    </div>
  )
}
