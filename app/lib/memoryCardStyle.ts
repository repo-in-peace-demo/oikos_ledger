// Shared confirmed/tentative visual treatment for memory-fact cards — used identically by
// Compare's and Macro's memory panels (ComparePanel.tsx, MemoryPanel.tsx) so the two pages read
// consistently rather than each inventing its own colors. Confirmed gets the strongest treatment
// (colored left border + subtle tint); tentative gets its own distinct but visually lesser
// treatment — same border weight so cards don't jitter between the two states, but a muted amber
// (this app's existing "uncertain/caveat" color, already used for Macro's blend-mismatch
// warnings) instead of confirmed's vivid emerald — so the confirmed/tentative hierarchy is still
// visible even when every card on screen happens to be tentative (e.g. right after bootstrapping,
// before anything has crossed the confirmation threshold), not just when both appear together.
export function confidenceCardClassName(confidenceStatus: string): string {
  const base = "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
  if (confidenceStatus === "confirmed") {
    return `${base} border-l-4 border-l-emerald-500 bg-emerald-50/40`
  }
  return `${base} border-l-4 border-l-amber-300 bg-amber-50/40`
}
