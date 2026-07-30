// Shared confirmed/tentative visual treatment for memory-fact cards — used identically by
// Compare's and Macro's memory panels (ComparePanel.tsx, MemoryPanel.tsx) so the two pages read
// consistently rather than each inventing its own colors. Confirmed gets a colored left border +
// subtle tint; tentative stays the plain neutral treatment both panels already used for every
// entry before this.
export function confidenceCardClassName(confidenceStatus: string): string {
  const base = "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
  return confidenceStatus === "confirmed"
    ? `${base} border-l-4 border-l-emerald-500 bg-emerald-50/40`
    : `${base} bg-slate-50`
}
