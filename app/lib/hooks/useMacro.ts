import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"

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
  const { data, error, isLoading } = useSWR<MacroResponse>("/api/macro", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  })

  return {
    indicators: data?.indicators ?? [],
    facts: data?.facts ?? [],
    explanation: data?.explanation ?? null,
    balances: data?.balances ?? EMPTY_BALANCES,
    isLoading,
    isError: !!error,
  }
}
