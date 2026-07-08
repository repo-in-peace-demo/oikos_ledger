"""Create all SQLModel tables in Aurora/Supabase using the direct connection string."""

import sys

from sqlalchemy import create_engine, inspect, text
from sqlmodel import Session, SQLModel

from ingestion.config import settings

# Import all models so SQLModel registers them in metadata before create_all
import ingestion.models  # noqa: F401


def main() -> None:
    print(f"Creating tables on {settings.db_provider} …\n")

    engine = create_engine(settings.database_url_direct)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        # Macro indicator enum: repo_rate added for the RBI repo rate series (see
        # ingestion/models/macro.py). create_all() only creates missing tables/types, it never
        # adds a missing enum value to an already-existing type, so this must be done explicitly.
        # SQLModel/SQLAlchemy's default enum type name is the lowercased Python class name with
        # no separator — MacroIndicator -> "macroindicator", not "macro_indicator".
        session.exec(text("""
            ALTER TYPE macroindicator ADD VALUE IF NOT EXISTS 'repo_rate'
        """))
        session.commit()

        # Unique constraint 1: reference number (partial — only when not null)
        session.exec(text("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_ref
            ON transactions (user_id, account_id, reference_number)
            WHERE reference_number IS NOT NULL
        """))

        # Unique constraint 2: composite for transactions without reference numbers
        # closing_balance added as tiebreaker for same-merchant sequential transactions
        session.exec(text("""
            DROP INDEX IF EXISTS uq_transactions_composite
        """))

        session.exec(text("""
            CREATE UNIQUE INDEX uq_transactions_composite
            ON transactions (
                user_id, account_id, transaction_date,
                amount, "transaction_type", "raw_description",
                "closing_balance"
            )
        """))

        # Semantic facts: account_id (nullable — NULL means user-level, e.g. Macro facts;
        # non-NULL scopes a fact to one account, e.g. Compare per-account baselines). Replaces
        # the old `category_baseline::<account_id>` string-encoding convention with a real column.
        #
        # The FK is added as a separate, explicitly-named, existence-checked step — ADD COLUMN
        # IF NOT EXISTS only guards the column itself, not an inline REFERENCES clause, so
        # combining them here previously added a second FK constraint
        # (semantic_facts_account_id_fkey_1) every time this script was re-run after the column
        # already existed.
        session.exec(text("""
            ALTER TABLE semantic_facts ADD COLUMN IF NOT EXISTS account_id UUID
        """))

        existing_fk = session.exec(text("""
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_name = 'semantic_facts'
              AND constraint_type = 'FOREIGN KEY'
              AND constraint_name = 'semantic_facts_account_id_fkey'
        """)).first()

        if existing_fk is None:
            session.exec(text("""
                ALTER TABLE semantic_facts
                ADD CONSTRAINT semantic_facts_account_id_fkey
                FOREIGN KEY (account_id) REFERENCES bank_accounts(id)
            """))

        # Only one *active* fact per (user_id, account_id, fact_type, category). The distillation
        # job supersedes a fact by inserting a new row and pointing the old row's superseded_by
        # at it, rather than updating in place — so the uniqueness constraint must be partial
        # (superseded_by IS NULL), not a plain unique index.
        #
        # NULL-uniqueness caveat: two user-level rows (account_id IS NULL) with the same
        # user_id/fact_type/category will NOT collide on this index — Postgres/CockroachDB never
        # treat two NULLs as equal for uniqueness. This is handled at the application level in
        # distillation/pipeline/distiller.py (upsert_or_supersede_fact looks up the existing
        # active row, matching NULL account_id with `.is_(None)`, before deciding to insert),
        # not with a sentinel "no account" value — see ingestion/models/memory.py for why a
        # sentinel doesn't work here (it would break the account_id foreign key).
        # Drop both possible prior names: the original plain index (still live as of this
        # writing) and the intermediate partial-without-account_id name, in case that
        # intermediate migration was ever applied elsewhere.
        session.exec(text("""
            DROP INDEX IF EXISTS uq_semantic_facts_user_fact_category CASCADE
        """))
        session.exec(text("""
            DROP INDEX IF EXISTS uq_semantic_facts_user_fact_category_active CASCADE
        """))

        session.exec(text("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_semantic_facts_user_fact_category_active
            ON semantic_facts (user_id, account_id, fact_type, category)
            WHERE superseded_by IS NULL
        """))

        # Insights query cache: simple key-value cache keyed by account+user+question
        # The SQLModel QueryCache uses embeddings (different purpose); this table
        # supports the /api/insights/query 1-hour response cache.
        session.exec(text("""
            DROP TABLE IF EXISTS query_cache CASCADE
        """))
        
        session.exec(text("""
            CREATE TABLE query_cache (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                account_id UUID NOT NULL REFERENCES bank_accounts(id),
                user_id UUID NOT NULL REFERENCES users(id),
                query_hash TEXT NOT NULL,
                query_text TEXT NOT NULL,
                query_embedding VECTOR(1536),
                result JSONB NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (user_id, account_id, query_hash)
            )   
        """))

        session.commit()

    inspector = inspect(engine)
    tables = sorted(inspector.get_table_names())
    for table in tables:
        print(f"  ✓ {table}")

    print(f"\nDone — {len(tables)} tables ready.")


if __name__ == "__main__":
    main()
