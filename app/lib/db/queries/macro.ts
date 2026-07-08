// Drizzle queries for the macro_economic_data table — latest indicators fetch and historical series retrieval
import { desc, eq, and } from "drizzle-orm"
import { dbReadonly } from "@/lib/db/client"
import { macro_economic_data } from "@/lib/db/schema"

type MacroIndicator = (typeof macro_economic_data.indicator.enumValues)[number]

const DEFAULT_COUNTRY_CODE = "IN"

// Latest value per indicator (most recent period), for the default country.
export async function getLatestMacroIndicators(countryCode = DEFAULT_COUNTRY_CODE) {
  const rows = await dbReadonly
    .selectDistinctOn([macro_economic_data.indicator], {
      id: macro_economic_data.id,
      country_code: macro_economic_data.country_code,
      indicator: macro_economic_data.indicator,
      period: macro_economic_data.period,
      value: macro_economic_data.value,
      source: macro_economic_data.source,
      fetched_at: macro_economic_data.fetched_at,
    })
    .from(macro_economic_data)
    .where(eq(macro_economic_data.country_code, countryCode))
    .orderBy(macro_economic_data.indicator, desc(macro_economic_data.period))

  return rows
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
