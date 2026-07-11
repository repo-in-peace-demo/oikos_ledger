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

interface ComparisonSnapshot {
  id: string
  category: string
  description: string
  occurrence_count: number
  confidence_status: string
  updated_at: string
}

interface CompareResponse {
  accounts: AccountResult[]
  category_deltas: CategoryDelta[]
  category_baseline_window_days: number
  shared_categories: string[]
  unique_categories: { account_id: string; categories: string[] }[]
  comparison_snapshots: ComparisonSnapshot[]
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

interface ComparePanelProps {
  accounts: BankAccount[]
}

function accountLabel(a: BankAccount): string {
  return `${a.bank_name} · ${a.account_nickname ?? a.account_type}`
}

// Fixed by column order (first selected = A, second = B), not by bank name — a user could
// compare two accounts at the same bank, so the color has to track "which column" rather than
// anything derived from the account's own identity. Both the semantic_facts schema
// (account_id/compared_account_id) and this table are built for exactly two accounts, so a
// two-entry palette is all Compare will ever need — see the MAX_COMPARE_ACCOUNTS enforcement
// below.
const ACCOUNT_COLORS = ["text-indigo-600", "text-pink-600"]

const MAX_COMPARE_ACCOUNTS = 2

// Index within data.accounts, not accounts (the full account list) — data.accounts preserves
// selection order (see compare/route.ts: accountMemories is built from validIds, which preserves
// the order account_ids arrived in), so accounts[0] is always whichever the user selected first.
function colorForAccount(compareAccounts: AccountResult[], accountId: string): string {
  const index = compareAccounts.findIndex((a) => a.account_id === accountId)
  return ACCOUNT_COLORS[index] ?? "text-slate-700"
}

// Which account_id has the higher value for this category row — used to color the Delta cell
// with the same account color, so the sign of the gap reads visually, not just numerically.
// null when there's nothing to compare (fewer than two real values — buildCategoryDeltas already
// guarantees row.delta itself is null in that case, so callers should check that first).
function higherAccountId(row: CategoryDelta): string | null {
  let best: { accountId: string; value: number } | null = null
  for (const [accountId, value] of Object.entries(row.values)) {
    if (value == null) continue
    if (best === null || value > best.value) best = { accountId, value }
  }
  return best?.accountId ?? null
}

export function ComparePanel({ accounts }: ComparePanelProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(
    accounts.slice(0, MAX_COMPARE_ACCOUNTS).map((a) => a.id),
  )
  const [data, setData] = useState<CompareResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleAccount(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      // Belt-and-suspenders alongside the disabled checkboxes below — the schema/table only
      // support a pair, so a 3rd selection is refused here too, not just hidden in the UI.
      if (prev.length >= MAX_COMPARE_ACCOUNTS) return prev
      return [...prev, id]
    })
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
          {accounts.map((a) => {
            const isSelected = selectedIds.includes(a.id)
            const atLimit = selectedIds.length >= MAX_COMPARE_ACCOUNTS
            const disabled = !isSelected && atLimit
            return (
              <label
                key={a.id}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors
                  ${isSelected
                    ? "border-primary bg-primary/5 text-primary cursor-pointer"
                    : disabled
                    ? "border-input text-muted-foreground/40 cursor-not-allowed"
                    : "border-input text-muted-foreground hover:text-foreground cursor-pointer"
                  }`}
              >
                <input
                  type="checkbox"
                  className="accent-current"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => toggleAccount(a.id)}
                />
                {accountLabel(a)}
              </label>
            )
          })}
        </div>
        {selectedIds.length >= MAX_COMPARE_ACCOUNTS && (
          <p className="text-xs text-muted-foreground">
            Compare works with {MAX_COMPARE_ACCOUNTS} accounts at a time — deselect one to choose a different account.
          </p>
        )}
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
            <div>
              <p className="text-sm font-semibold text-slate-700">Category spend deltas</p>
              {data.category_deltas.length > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Each account&apos;s amount is a rolling {data.category_baseline_window_days}-day
                  spend total, averaged across your past Compare sessions for that category.
                </p>
              )}
            </div>
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
                        <th key={a.account_id} className="py-1.5 pr-3">
                          <span className={colorForAccount(data.accounts, a.account_id)}>
                            {labelFor(a.account_id)}
                          </span>
                        </th>
                      ))}
                      <th className="py-1.5">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.category_deltas.map((row) => {
                      const winner = row.delta != null ? higherAccountId(row) : null
                      return (
                        <tr key={row.category} className="border-b last:border-0">
                          <td className="py-1.5 pr-3 font-medium text-slate-700">{row.category}</td>
                          {data.accounts.map((a) => (
                            <td key={a.account_id} className="py-1.5 pr-3">
                              {row.values[a.account_id] != null
                                ? `₹${row.values[a.account_id]!.toLocaleString("en-IN")}`
                                : "—"}
                            </td>
                          ))}
                          <td className={`py-1.5 ${winner ? colorForAccount(data.accounts, winner) : ""}`}>
                            {row.delta != null ? `₹${row.delta.toLocaleString("en-IN")}` : "—"}
                          </td>
                        </tr>
                      )
                    })}
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
                    <span className={`font-medium ${colorForAccount(data.accounts, u.account_id)}`}>
                      {labelFor(u.account_id)}:{" "}
                    </span>
                    <span className="text-muted-foreground">
                      {u.categories.length > 0 ? u.categories.join(", ") : "none"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-5 space-y-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">What Oikos Recall has noticed</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Once both accounts have a confirmed spending baseline for the same category,
                Oikos Recall tracks which one has consistently run higher across repeated
                comparisons — same pattern as the Macro page&apos;s memory, applied to a pair of
                accounts instead of one.
              </p>
            </div>
            {data.comparison_snapshots.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Still learning — this shows up once both accounts have a confirmed baseline for a
                shared category and have been compared more than once.
              </p>
            ) : (
              <div className="space-y-2">
                {data.comparison_snapshots.map((f) => (
                  <div key={f.id} className="flex items-start gap-2 rounded-lg border bg-slate-50 px-3 py-2 text-xs">
                    <span className="shrink-0" title={f.confidence_status}>
                      {f.confidence_status === "confirmed" ? "✅" : "🤔"}
                    </span>
                    <div className="flex-1 space-y-1">
                      <p className="text-slate-700">{f.description}</p>
                      <p className="text-muted-foreground">
                        {f.confidence_status === "confirmed" ? "Confirmed" : "Tentative"}
                        {" · seen "}{f.occurrence_count} time{f.occurrence_count === 1 ? "" : "s"}
                        {" · updated "}{formatDate(f.updated_at)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
