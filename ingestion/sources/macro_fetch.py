# Fetches macro-economic indicators (inflation, interest rates, GDP) from World Bank and RBI APIs and upserts to CockroachDB

import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import httpx
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session

from ingestion.models.macro import MacroEconomicData, MacroIndicator

log = logging.getLogger(__name__)

COUNTRY_CODE = "IN"          # ISO 3166-1 alpha-2 — matches macro_economic_data.country_code
WORLD_BANK_COUNTRY = "IND"   # World Bank uses ISO 3166-1 alpha-3
WORLD_BANK_BASE_URL = "https://api.worldbank.org/v2"

# World Bank indicator codes with a confirmed, reliable annual series for India.
# food_inflation is intentionally left unmapped — the World Bank does not publish a
# standard food-CPI series for India, and guessing a code would silently store the
# wrong data under that indicator.
WORLD_BANK_INDICATORS: dict[MacroIndicator, str] = {
    MacroIndicator.gdp_growth: "NY.GDP.MKTP.KD.ZG",
    MacroIndicator.gdp_per_capita: "NY.GDP.PCAP.CD",
    MacroIndicator.inflation: "FP.CPI.TOTL.ZG",
}

# RBI has no stable public JSON/REST API for the policy repo rate — data.rbi.org.in (DBIE) is an
# interactive portal, not a machine-readable feed. The repo rate only changes at MPC meetings
# (~6/year), so it's tracked here as a manually-curated series sourced from official RBI MPC
# announcements. Append a row after each bi-monthly MPC decision.
RBI_REPO_RATE_SEED: list[tuple[str, str]] = [
    ("2023-02", "6.50"),
    ("2025-02", "6.25"),
    ("2025-04", "6.00"),
    ("2025-06", "5.50"),
    ("2025-12", "5.25"),
]

# World Bank's inflation and GDP growth figures are annual and ~18 months stale by the time
# they're published. MoSPI publishes CPI monthly (~5-6 week lag via PIB press releases) and GDP
# growth quarterly via NSO — far more current — but, like the RBI repo rate, has no stable public
# JSON/REST API. Manually curated from official MoSPI/PIB press releases; append a row after each
# monthly CPI release or quarterly GDP release.
#
# CPI base-year transition — deliberately NOT spliced into one continuous series: the 2012=100
# series ended with the December 2025 release; the 2024=100 series began with the January 2026
# release (new item basket, weighted on the 2023-24 Household Consumption Expenditure Survey).
# Each row's `source` records which base-year series it came from, rather than presenting both
# as one uninterrupted series.
MOSPI_CPI_SEED: list[tuple[str, str, str]] = [
    # (period, value, source)
    ("2025-11", "2.95", "mospi (2012=100)"),
    ("2025-12", "2.86", "mospi (2012=100)"),
    ("2026-01", "2.75", "mospi (2024=100)"),
    # Feb 2026 intentionally omitted — figure not confirmed at seed time, left as a gap rather
    # than guessed.
    ("2026-03", "3.40", "mospi (2024=100)"),
    ("2026-04", "3.48", "mospi (2024=100)"),
    ("2026-05", "3.93", "mospi (2024=100)"),
]

# NSO/MoSPI quarterly real GDP growth (year-on-year), stored at the quarter's end month.
MOSPI_GDP_GROWTH_SEED: list[tuple[str, str, str]] = [
    # Q4 FY2025-26 (Jan-Mar 2026) provisional estimate, released 2026-06-05.
    ("2026-03", "7.8", "mospi_quarterly"),
]


def fetch_world_bank_indicator(indicator: MacroIndicator, per_page: int = 20) -> list[dict[str, Any]]:
    """Fetch an annual time series for one World Bank indicator for India.

    Returns raw API rows (most recent first), skipping periods with no reported value.
    """
    code = WORLD_BANK_INDICATORS[indicator]
    url = f"{WORLD_BANK_BASE_URL}/country/{WORLD_BANK_COUNTRY}/indicator/{code}"
    response = httpx.get(url, params={"format": "json", "per_page": per_page}, timeout=10.0)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list) or len(payload) < 2 or payload[1] is None:
        return []
    return [row for row in payload[1] if row.get("value") is not None]


def fetch_rbi_repo_rate() -> list[dict[str, str]]:
    """Return the manually-curated RBI policy repo rate series (see RBI_REPO_RATE_SEED)."""
    return [{"period": period, "value": value} for period, value in RBI_REPO_RATE_SEED]


def fetch_mospi_cpi() -> list[dict[str, str]]:
    """Return the manually-curated MoSPI CPI inflation series (see MOSPI_CPI_SEED)."""
    return [
        {"period": period, "value": value, "source": source}
        for period, value, source in MOSPI_CPI_SEED
    ]


def fetch_mospi_gdp_growth() -> list[dict[str, str]]:
    """Return the manually-curated NSO/MoSPI quarterly GDP growth series (see MOSPI_GDP_GROWTH_SEED)."""
    return [
        {"period": period, "value": value, "source": source}
        for period, value, source in MOSPI_GDP_GROWTH_SEED
    ]


def upsert_macro_indicator(
    session: Session,
    indicator: MacroIndicator,
    period: str,
    value: Decimal,
    source: str,
    country_code: str = COUNTRY_CODE,
) -> None:
    """Upsert one (country, indicator, period) row — safe to call repeatedly."""
    now = datetime.now(timezone.utc)
    stmt = pg_insert(MacroEconomicData).values(
        country_code=country_code,
        indicator=indicator,
        period=period,
        value=value,
        source=source,
        fetched_at=now,
    ).on_conflict_do_update(
        index_elements=["country_code", "indicator", "period"],
        set_={"value": value, "source": source, "fetched_at": now},
    )
    session.execute(stmt)


def run_macro_ingestion() -> dict[str, int]:
    """Fetch all configured indicators and upsert into macro_economic_data.

    Standalone entry point — invoked on its own schedule, not tied to the Macro page's
    request/response cycle, since these are external API calls that shouldn't block a page load.
    """
    from ingestion.db.client import get_session

    counts: dict[str, int] = {}

    with get_session() as session:
        for indicator in WORLD_BANK_INDICATORS:
            try:
                rows = fetch_world_bank_indicator(indicator)
            except httpx.HTTPError as exc:
                log.warning("World Bank fetch failed for %s: %s", indicator.value, exc)
                continue
            for row in rows:
                # World Bank returns a bare year (e.g. "2024") for annual indicators —
                # stored at month 01 to fit the YYYY-MM period format.
                period = f"{row['date']}-01"
                upsert_macro_indicator(
                    session, indicator, period, Decimal(str(row["value"])), source="world_bank",
                )
            counts[indicator.value] = len(rows)
            log.info("Fetched %s rows for %s from World Bank", len(rows), indicator.value)

        repo_rows = fetch_rbi_repo_rate()
        for row in repo_rows:
            upsert_macro_indicator(
                session, MacroIndicator.repo_rate, row["period"], Decimal(row["value"]), source="rbi",
            )
        counts[MacroIndicator.repo_rate.value] = len(repo_rows)
        log.info("Fetched %s rows for repo_rate from RBI seed", len(repo_rows))

        # MoSPI seed data — see MOSPI_CPI_SEED / MOSPI_GDP_GROWTH_SEED. Separate count keys
        # (not overwriting the World Bank counts above) since both sources write the same
        # indicators; the read side in app/lib/db/queries/macro.ts prefers whichever MoSPI row
        # is present over World Bank's.
        mospi_cpi_rows = fetch_mospi_cpi()
        for row in mospi_cpi_rows:
            upsert_macro_indicator(
                session, MacroIndicator.inflation, row["period"], Decimal(row["value"]), source=row["source"],
            )
        counts["inflation_mospi"] = len(mospi_cpi_rows)
        log.info("Fetched %s rows for inflation from MoSPI seed", len(mospi_cpi_rows))

        mospi_gdp_rows = fetch_mospi_gdp_growth()
        for row in mospi_gdp_rows:
            upsert_macro_indicator(
                session, MacroIndicator.gdp_growth, row["period"], Decimal(row["value"]), source=row["source"],
            )
        counts["gdp_growth_mospi"] = len(mospi_gdp_rows)
        log.info("Fetched %s rows for gdp_growth from MoSPI seed", len(mospi_gdp_rows))

    return counts


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run_macro_ingestion())
