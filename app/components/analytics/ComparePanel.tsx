"use client"

import { useState } from "react"
import type { BankAccount } from "@/types"

interface CategoryDelta {
  category: string
  values: Record<string, number | null>
  delta: number | null
}

interface AccountResult {
  account_id: string
  label: string
  recent_events: { id: string; event_type: string; content: string; created_at: string }[]
}

interface CompareResponse {
  accounts: AccountResult[]
  category_deltas: CategoryDelta[]
  shared_categories: string[]
  unique_categories: { account_id: string; categories: string[] }[]
}

interface ComparePanelProps {
  accounts: BankAccount[]
}

function accountLabel(a: BankAccount): string {
  return `${a.bank_name} · ${a.account_nickname ?? a.account_type}`
}

export function ComparePanel({ accounts }: ComparePanelProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(
    accounts.slice(0, 2).map((a) => a.id),
  )
  const [data, setData] = useState<CompareResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleAccount(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  async function runCompare() {
    if (selectedIds.length < 2) {
      setError("Select at least two accounts to compare.")
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/accounts/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_ids: selectedIds }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to compare accounts")
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to compare accounts")
    } finally {
      setIsLoading(false)
    }
  }

  if (accounts.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground text-center">
        You need at least two accounts to use Compare.
      </div>
    )
  }

  const labelFor = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId)
    return account ? accountLabel(account) : accountId
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <p className="text-sm font-semibold text-slate-700">Select accounts to compare</p>
        <div className="flex flex-wrap gap-2">
          {accounts.map((a) => (
            <label
              key={a.id}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs cursor-pointer transition-colors
                ${selectedIds.includes(a.id)
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-input text-muted-foreground hover:text-foreground"
                }`}
            >
              <input
                type="checkbox"
                className="accent-current"
                checked={selectedIds.includes(a.id)}
                onChange={() => toggleAccount(a.id)}
              />
              {accountLabel(a)}
            </label>
          ))}
        </div>
        <button
          onClick={runCompare}
          disabled={isLoading}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground
            hover:bg-primary/90 disabled:opacity-50"
        >
          {isLoading ? "Comparing..." : "Compare"}
        </button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {data && (
        <>
          <div className="rounded-xl border bg-card p-5 space-y-3">
            <p className="text-sm font-semibold text-slate-700">Category spend deltas</p>
            {data.category_deltas.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No distilled category baselines yet for these accounts — deltas will appear
                once the distillation job has run.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1.5 pr-3">Category</th>
                      {data.accounts.map((a) => (
                        <th key={a.account_id} className="py-1.5 pr-3">{a.label}</th>
                      ))}
                      <th className="py-1.5">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.category_deltas.map((row) => (
                      <tr key={row.category} className="border-b last:border-0">
                        <td className="py-1.5 pr-3 font-medium text-slate-700">{row.category}</td>
                        {data.accounts.map((a) => (
                          <td key={a.account_id} className="py-1.5 pr-3">
                            {row.values[a.account_id] != null
                              ? `₹${row.values[a.account_id]!.toLocaleString("en-IN")}`
                              : "—"}
                          </td>
                        ))}
                        <td className="py-1.5">
                          {row.delta != null ? `₹${row.delta.toLocaleString("en-IN")}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border bg-card p-5 space-y-2">
              <p className="text-sm font-semibold text-slate-700">Shared categories</p>
              {data.shared_categories.length === 0 ? (
                <p className="text-xs text-muted-foreground">No shared distilled categories yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.shared_categories.map((c) => (
                    <span key={c} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-xl border bg-card p-5 space-y-2">
              <p className="text-sm font-semibold text-slate-700">Unique to each account</p>
              <div className="space-y-1.5">
                {data.unique_categories.map((u) => (
                  <div key={u.account_id} className="text-xs">
                    <span className="font-medium text-slate-700">{labelFor(u.account_id)}: </span>
                    <span className="text-muted-foreground">
                      {u.categories.length > 0 ? u.categories.join(", ") : "none"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
