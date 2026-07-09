"""SQLModel table definitions for macro_economic_data."""

import uuid
from datetime import datetime
from decimal import Decimal
from enum import Enum

import sqlalchemy as sa
from sqlalchemy import Column, Numeric, UniqueConstraint, text
from sqlmodel import Field, SQLModel


class MacroIndicator(str, Enum):
    gdp_growth = "gdp_growth"
    inflation = "inflation"
    food_inflation = "food_inflation"
    gdp_per_capita = "gdp_per_capita"
    repo_rate = "repo_rate"


class MacroEconomicData(SQLModel, table=True):
    __tablename__ = "macro_economic_data"
    __table_args__ = (
        UniqueConstraint("country_code", "indicator", "period", name="uq_macro_country_indicator_period"),
    )

    id: uuid.UUID = Field(
        default=None,
        sa_column=Column(sa.UUID, primary_key=True, server_default=text("gen_random_uuid()")),
    )
    country_code: str
    indicator: MacroIndicator
    period: str  # YYYY-MM
    value: Decimal = Field(sa_column=Column("value", Numeric(12, 4), nullable=False))
    # world_bank | rbi | mospi — "mospi" values may carry a suffix identifying a sub-series,
    # e.g. "mospi (2012=100)" / "mospi (2024=100)" for the CPI base-year transition, or
    # "mospi_quarterly" for NSO quarterly GDP growth. All mospi-family values start with the
    # literal prefix "mospi" — see the read-side preference query in app/lib/db/queries/macro.ts.
    source: str
    fetched_at: datetime = Field(
        default=None,
        sa_column=Column(
            sa.TIMESTAMP(timezone=True),
            server_default=text("timezone('utc', now())"),
            nullable=False,
        ),
    )
