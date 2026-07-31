// Shared nominal/real point-building logic for the Macro page's balance-trend charts
// (BalanceTrendChart.tsx, PurchasingPowerGapChart.tsx) — a single source of truth so the gap
// chart's series (gap = nominal - real) is always derived from the exact same real-value
// calculation the combined chart uses, never a second formula that could drift out of sync.
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"

export interface BalanceHistoryPoint {
  timestamp: string
  nominal_balance: number
  account_ids: string[]
  account_set_changed: boolean
}

export interface ChartPoint {
  timestamp: string
  label: string
  nominal: number
  real: number
  gap: number
  accountSetChanged: boolean
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

export function formatPointLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

// real_value = nominal_value - (baseline_value × inflation_rate/100 × elapsed_years_since_baseline)
// — baseline is the earliest snapshot, elapsed time is the actual gap in real days/years between
// snapshots (real timestamps, not calendar-label counting), deliberately not compounded — the
// same simple approximation already disclosed to the user elsewhere on this page, not a more
// sophisticated one invented for this chart. gap = nominal - real = erosion, which depends only
// on the baseline value, inflation rate, and elapsed time since baseline — never on the current
// point's own nominal_balance — so it trends independently of whatever the nominal line itself
// does (e.g. a jump from an account being added).
export function buildChartPoints(points: BalanceHistoryPoint[], inflationRatePct: number | null): ChartPoint[] {
  if (points.length === 0) return []
  const baseline = points[0]
  const baselineMs = new Date(baseline.timestamp).getTime()

  return points.map((p) => {
    const elapsedYears = (new Date(p.timestamp).getTime() - baselineMs) / MS_PER_YEAR
    const erosion = inflationRatePct != null
      ? baseline.nominal_balance * (inflationRatePct / 100) * elapsedYears
      : 0
    return {
      timestamp: p.timestamp,
      label: formatPointLabel(p.timestamp),
      nominal: Math.round(p.nominal_balance),
      real: Math.round(p.nominal_balance - erosion),
      // Computed directly from erosion, not nominal - real — subtracting two independently
      // rounded values could be off by a rupee from the true erosion amount.
      gap: Math.round(erosion),
      accountSetChanged: p.account_set_changed,
    }
  })
}

interface BalanceHistoryResponse {
  points: BalanceHistoryPoint[]
}

const BALANCE_HISTORY_URL = "/api/macro/balance-history"

// Shared SWR key for both trend charts — mounting both on the same page (BalanceTrendChart and
// PurchasingPowerGapChart) triggers exactly one network request between them, not two
// independent fetches of the same underlying snapshot data (SWR dedupes by key/caches the result).
export function useBalanceHistory() {
  return useSWR<BalanceHistoryResponse>(BALANCE_HISTORY_URL, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  })
}
