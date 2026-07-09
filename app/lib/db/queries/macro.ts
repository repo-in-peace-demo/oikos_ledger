// Drizzle queries for the macro_economic_data table — latest indicators fetch and historical series retrieval
import { desc, eq, and, ilike, inArray } from "drizzle-orm"
import { dbReadonly } from "@/lib/db/client"
import { macro_economic_data } from "@/lib/db/schema"

type MacroIndicator = (typeof macro_economic_data.indicator.enumValues)[number]

const DEFAULT_COUNTRY_CODE = "IN"

// For these indicators, prefer the most recent MoSPI-sourced row (monthly CPI / quarterly GDP
// growth — both far more current than World Bank's ~18-month-stale annual figures) whenever one
// exists, falling back to the plain latest-by-period row (effectively World Bank) only when no
// MoSPI row exists yet. Not just "whichever has the later period" — MoSPI's own seed data can go
// stale between manual updates while World Bank's does not, and a later World Bank period should
// not silently displace an intentionally-preferred MoSPI figure. gdp_per_capita and repo_rate are
// unaffected: MoSPI doesn't publish gdp_per_capita, and repo_rate already has its own RBI seed.
const PREFER_MOSPI_INDICATORS: MacroIndicator[] = ["inflation", "gdp_growth"]

const MACRO_FIELDS = {
  id: macro_economic_data.id,
  country_code: macro_economic_data.country_code,
  indicator: macro_economic_data.indicator,
  period: macro_economic_data.period,
  value: macro_economic_data.value,
  source: macro_economic_data.source,
  fetched_at: macro_economic_data.fetched_at,
}

// Latest value per indicator (most recent period), for the default country. For inflation and
// gdp_growth specifically, prefers the most recent MoSPI row over World Bank's — see
// PREFER_MOSPI_INDICATORS.
export async function getLatestMacroIndicators(countryCode = DEFAULT_COUNTRY_CODE) {
  const latestOverall = await dbReadonly
    .selectDistinctOn([macro_economic_data.indicator], MACRO_FIELDS)
    .from(macro_economic_data)
    .where(eq(macro_economic_data.country_code, countryCode))
    .orderBy(macro_economic_data.indicator, desc(macro_economic_data.period))

  const latestMospi = await dbReadonly
    .selectDistinctOn([macro_economic_data.indicator], MACRO_FIELDS)
    .from(macro_economic_data)
    .where(and(
      eq(macro_economic_data.country_code, countryCode),
      inArray(macro_economic_data.indicator, PREFER_MOSPI_INDICATORS),
      ilike(macro_economic_data.source, "mospi%"),
    ))
    .orderBy(macro_economic_data.indicator, desc(macro_economic_data.period))

  const mospiByIndicator = new Map(latestMospi.map((row) => [row.indicator, row]))
  const preferMospiSet = new Set<string>(PREFER_MOSPI_INDICATORS)

  return latestOverall.map((row) =>
    preferMospiSet.has(row.indicator) ? (mospiByIndicator.get(row.indicator) ?? row) : row,
  )
}

export async function getMacroIndicatorHistory(
  indicator: MacroIndicator,
  countryCode = DEFAULT_COUNTRY_CODE,
  limit = 24,
) {
  return dbReadonly
    .select()
    .from(macro_economic_data)
    .where(and(
      eq(macro_economic_data.country_code, countryCode),
      eq(macro_economic_data.indicator, indicator),
    ))
    .orderBy(desc(macro_economic_data.period))
    .limit(limit)
}
