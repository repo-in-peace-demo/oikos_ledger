"""Centralised, validated settings for the distillation Lambda.

Import the shared `settings` instance — never instantiate Settings() directly:

    from distillation.config import settings
"""

from urllib.parse import urlsplit, urlunsplit

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env.local",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Database ──────────────────────────────────────────────────────────────
    # database_url_direct supplies the shared host/port/database/sslmode — only the
    # user and password are swapped out below for the oikos_recall_distill_rw SQL role
    # (SELECT on episodic_events; SELECT/INSERT/UPDATE on semantic_facts).
    database_url_direct: str
    distill_rw_password: str
    db_provider: str = "cockroach"

    # ── AWS ───────────────────────────────────────────────────────────────────
    aws_region: str = "ap-south-1"

    # ── LLM APIs ─────────────────────────────────────────────────────────────
    openai_api_key: str   # text-embedding-3-small — semantic_facts.embedding

    # ── Distillation ──────────────────────────────────────────────────────────
    distill_lookback_days: int = 7        # how far back to scan episodic_events on each run
    decay_stale_after_days: int = 30      # facts not accessed/reinforced in this window start decaying
    decay_factor: float = 0.9             # relevance_score multiplier applied per stale run
    min_occurrences_for_trend: int = 3    # minimum grouped events before promoting a trend fact

    # balance_snapshot trend detection is monthly-cadence (macro_explanation events fire roughly
    # once per macro indicator period, not daily), so it needs a much longer lookback than the
    # generic 7-day window above — otherwise most runs would only ever see a single snapshot.
    balance_trend_lookback_days: int = 365
    balance_flat_tolerance_pct: float = 0.02  # step changes within +/-2% count as "flat", not noise

    @property
    def distill_database_url(self) -> str:
        """database_url_direct with the user/password swapped for oikos_recall_distill_rw."""
        parts = urlsplit(self.database_url_direct)
        netloc = f"oikos_recall_distill_rw:{self.distill_rw_password}@{parts.hostname}"
        if parts.port:
            netloc += f":{parts.port}"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


settings = Settings()
