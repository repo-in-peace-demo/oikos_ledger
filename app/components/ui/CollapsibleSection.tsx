"use client"

// Generic collapsed-by-default disclosure — collapsed so a "How this works" style explanation
// doesn't add permanent clutter to an already-dense page; expand on demand for anyone who wants
// the depth. Visual pattern (icon + label + chevron toggle) matches Recommendations' own existing
// "How this works" toggle (RecommendationsPanel.tsx) for a consistent feel across pages, adapted
// to nest inside a card-based section layout rather than a full-width header bar.
import { useState } from "react"
import { ChevronDown, ChevronUp, Info } from "lucide-react"
import type { ReactNode } from "react"

interface Props {
  label: string
  children: ReactNode
  className?: string
}

export function CollapsibleSection({ label, children, className }: Props) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className={className}>
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Info className="h-3.5 w-3.5" />
        {label}
        {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {isOpen && (
        <div className="mt-3 rounded-lg border bg-slate-50 px-4 py-3 text-xs text-slate-600 space-y-3">
          {children}
        </div>
      )}
    </div>
  )
}
