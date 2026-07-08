"""SQLModel table definitions for episodic_events and semantic_facts."""

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Column, Index, text
from sqlmodel import Field, SQLModel


class EpisodicEvent(SQLModel, table=True):
    __tablename__ = "episodic_events"

    id: uuid.UUID = Field(
        default=None,
        sa_column=Column(sa.UUID, primary_key=True, server_default=text("gen_random_uuid()")),
    )
    user_id: uuid.UUID = Field(foreign_key="users.id")
    account_id: Optional[uuid.UUID] = Field(default=None, foreign_key="bank_accounts.id")
    event_type: str  # macro_explanation | insight_shown | comparison_run | ...
    content: str
    embedding: List[float] = Field(
        sa_column=Column("embedding", Vector(1536), nullable=False),
    )
    # Python attribute suffixed with "_" — "metadata" is reserved by SQLModel's
    # declarative base; the underlying column is still named "metadata".
    metadata_: Optional[Dict[str, Any]] = Field(
        default=None,
        sa_column=Column("metadata", JSON, nullable=True),
    )
    created_at: datetime = Field(
        default=None,
        sa_column=Column(
            sa.TIMESTAMP(timezone=True),
            server_default=text("timezone('utc', now())"),
            nullable=False,
        ),
    )
    # no updated_at — append-only/immutable table, never updated after insert


class SemanticFact(SQLModel, table=True):
    __tablename__ = "semantic_facts"
    __table_args__ = (
        # Partial unique index, not a plain UniqueConstraint — supersession (see the
        # distillation job) inserts a new row and points the old row's superseded_by
        # at it rather than updating in place, so multiple rows can share a
        # (user_id, account_id, fact_type, category) key as long as only one is still
        # active (superseded_by IS NULL).
        #
        # NULL-uniqueness caveat: Postgres/CockroachDB never treat two NULLs as equal for
        # uniqueness, so two user-level rows (account_id IS NULL, same user/fact_type/category)
        # would NOT collide on this index and could silently duplicate. We deliberately do NOT
        # work around this with a sentinel "no account" UUID, because account_id carries a real
        # foreign key to bank_accounts — a sentinel would either need a fake row seeded into
        # bank_accounts (which would then leak into every "list this user's accounts" query) or
        # drop the FK entirely. Instead, true NULL is kept and the distillation job's
        # upsert_or_supersede_fact() explicitly looks up the existing active row (matching NULL
        # account_id with `.is_(None)`) before deciding to insert — see
        # distillation/pipeline/distiller.py. That job is the only writer of semantic_facts and
        # runs as a single scheduled Lambda invocation, so the check-then-insert race this
        # implies is a deliberately accepted, low-probability residual risk, not an oversight.
        Index(
            "uq_semantic_facts_user_fact_category_active",
            "user_id", "account_id", "fact_type", "category",
            unique=True,
            postgresql_where=text("superseded_by IS NULL"),
        ),
    )

    id: uuid.UUID = Field(
        default=None,
        sa_column=Column(sa.UUID, primary_key=True, server_default=text("gen_random_uuid()")),
    )
    user_id: uuid.UUID = Field(foreign_key="users.id")
    # NULL = user-level fact (e.g. Macro-feature facts, not tied to one account).
    # Non-NULL = account-specific fact (e.g. Compare-feature per-account category baselines).
    # See the NULL-uniqueness caveat on __table_args__ above before changing this to a sentinel.
    account_id: Optional[uuid.UUID] = Field(default=None, foreign_key="bank_accounts.id")
    fact_type: str
    category: Optional[str] = Field(default=None)
    description: str
    embedding: List[float] = Field(
        sa_column=Column("embedding", Vector(1536), nullable=False),
    )
    occurrence_count: int = Field(default=0)
    opportunity_count: int = Field(default=0)
    running_mean: Optional[float] = Field(default=None)
    confidence_status: str = Field(default="tentative")
    relevance_score: float = Field(default=1.0)
    last_accessed_at: datetime = Field(
        default=None,
        sa_column=Column(
            sa.TIMESTAMP(timezone=True),
            server_default=text("timezone('utc', now())"),
            nullable=False,
        ),
    )
    superseded_by: Optional[uuid.UUID] = Field(default=None, foreign_key="semantic_facts.id")
    created_at: datetime = Field(
        default=None,
        sa_column=Column(
            sa.TIMESTAMP(timezone=True),
            server_default=text("timezone('utc', now())"),
            nullable=False,
        ),
    )
    updated_at: datetime = Field(
        default=None,
        sa_column=Column(
            sa.TIMESTAMP(timezone=True),
            server_default=text("timezone('utc', now())"),
            onupdate=text("timezone('utc', now())"),
            nullable=False,
        ),
    )
