import type { ReactNode } from "react"

export interface TextHighlight {
  text: string
  className: string
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Wraps each occurrence of any highlight's `text` within `source` in a span carrying its
// className, leaving everything else as plain text. Needed because comparison_snapshot facts
// (e.g. "Axis Bank has run higher than HDFC Bank in Shopping...") arrive as a single opaque
// description string from the backend — there's no structured per-account field to key a color
// off directly, so the bank names have to be found and wrapped within the sentence itself.
// Longest highlight matched first, so one bank's name being a substring of another's (not the
// case today, but not guaranteed going forward) can't fragment the longer match.
export function highlightText(source: string, highlights: TextHighlight[]): ReactNode {
  const active = highlights.filter((h) => h.text.trim().length > 0)
  if (active.length === 0) return source

  const pattern = active
    .slice()
    .sort((a, b) => b.text.length - a.text.length)
    .map((h) => escapeRegExp(h.text))
    .join("|")

  const parts = source.split(new RegExp(`(${pattern})`, "g"))
  return parts.map((part, i) => {
    const match = active.find((h) => h.text === part)
    return match
      ? <span key={i} className={`font-medium ${match.className}`}>{part}</span>
      : <span key={i}>{part}</span>
  })
}
