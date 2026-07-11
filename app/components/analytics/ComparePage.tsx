"use client"

import { useAccounts } from "@/components/accounts/AccountsContext"
import { ComparePanel } from "./ComparePanel"

export function ComparePage() {
  const { accounts } = useAccounts()

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="border-b px-6 py-4 shrink-0">
        <h2 className="text-base font-semibold">Compare Accounts</h2>
        <p className="text-xs text-muted-foreground">
          Category spend deltas and shared patterns across accounts
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <ComparePanel accounts={accounts} />
      </div>
    </div>
  )
}
