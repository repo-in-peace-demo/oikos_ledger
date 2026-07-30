// Single source of truth for how a Macro indicator's raw value is displayed — shared between the
// visual card (MacroPanel.tsx) and the voice assistant's prompt content (macro/query/route.ts),
// so the two can never drift out of sync on currency/unit. GDP per capita is a USD-denominated
// World Bank figure, unconnected to the user's own account currency — it must always render with
// $, never the user's balance currency (₹ for an INR account), regardless of what "currency"
// field happens to be sitting elsewhere in the same payload. Every other indicator here
// (GDP growth, inflation, food inflation, repo rate) is a percentage, not a monetary figure at all.
export function formatIndicatorValue(indicator: string, value: string): string {
  const n = Number(value)
  if (indicator === "gdp_per_capita") {
    return `$${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
  }
  return `${n.toFixed(2)}%`
}
