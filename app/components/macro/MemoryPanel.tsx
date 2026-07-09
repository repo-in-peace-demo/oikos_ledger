"use client"

import type { MacroSemanticFact } from "@/lib/hooks/useMacro"

interface Props {
  facts: MacroSemanticFact[]
  lastDistilledAt: string | null
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

export function MemoryPanel({ facts, lastDistilledAt }: Props) {
  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <p className="text-sm font-semibold text-slate-700">What Oikos Recall has learned</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Oikos Recall builds up patterns about your finances over time — here&apos;s what it&apos;s
          noticed so far. This is different from the synthesis above: that combines today&apos;s
          national indicators with your balance; this is what the app has learned about{" "}
          <em>your</em> activity over time.
        </p>
      </div>

      {facts.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          Still learning — patterns show up here after enough activity to confirm them.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {facts.map((f) => (
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
          {lastDistilledAt && (
            <p className="text-[11px] text-muted-foreground pt-1 border-t">
              Last updated by Oikos Recall&apos;s background distillation on {formatDate(lastDistilledAt)} —
              this refreshes on its own schedule, not on every visit.
            </p>
          )}
        </>
      )}
    </div>
  )
}
