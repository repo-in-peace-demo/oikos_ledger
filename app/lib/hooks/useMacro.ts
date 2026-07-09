import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { DEFAULT_CURRENCY } from "@/lib/constants/currencies"

export type MacroIndicator = {
  indicator: string
  period: string
  value: string
  source: string
}

export type MacroSemanticFact = {
  id: string
  fact_type: string
  category: string | null
  description: string
  relevance_score: number
  confidence_status: string
  occurrence_count: number
  updated_at: string
}

export type BlendState = "blended_clean" | "blended_with_caveat" | "not_blended"

export type AccountBalanceEntry = {
  account_id: string
  label: string
  closing_balance: number
  as_of_month: string
  excluded_from_blend: boolean
}

export type BalancesSummary = {
  state: BlendState
  combined_balance: number | null
  reference_month: string | null
  recency_mismatch: boolean
  accounts: AccountBalanceEntry[]
  accounts_without_data: number
}

type MacroResponse = {
  indicators: MacroIndicator[]
  facts: MacroSemanticFact[]
  explanation: string | null
  already_explained: boolean
  balances: BalancesSummary
  currency: string
  last_distilled_at: string | null
  gdp_per_capita_age_note: string | null
  repo_rate_unchanged_note: string | null
}

const EMPTY_BALANCES: BalancesSummary = {
  state: "not_blended",
  combined_balance: null,
  reference_month: null,
  recency_mismatch: false,
  accounts: [],
  accounts_without_data: 0,
}

export function useMacro() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<MacroResponse>(
    "/api/macro",
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
    },
  )

  return {
    indicators: data?.indicators ?? [],
    facts: data?.facts ?? [],
    explanation: data?.explanation ?? null,
    balances: data?.balances ?? EMPTY_BALANCES,
    currency: data?.currency ?? DEFAULT_CURRENCY,
    lastDistilledAt: data?.last_distilled_at ?? null,
    gdpPerCapitaAgeNote: data?.gdp_per_capita_age_note ?? null,
    repoRateUnchangedNote: data?.repo_rate_unchanged_note ?? null,
    isLoading,
    // isValidating covers a manual refresh too (mutate() re-triggers the fetcher), unlike
    // isLoading which is only true on the very first, cache-less load.
    isRefreshing: isValidating,
    isError: !!error,
    // Bound mutate — calling it revalidates immediately, bypassing dedupingInterval (that setting
    // only throttles automatic triggers like mount/focus, not an explicit manual call).
    refresh: () => mutate(),
  }
}
