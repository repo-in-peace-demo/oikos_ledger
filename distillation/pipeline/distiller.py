"""Distillation logic — trend detection, percentile facts, relevance decay, and fact supersession.

Cheap running updates (occurrence ratios, means, threshold-confirmation) happen inline in the
Next.js app at write time. This job only handles what requires scanning history: grouping many
episodic_events into trends, computing percentiles across a group, decaying stale facts, and
superseding a fact when a newly computed value contradicts the currently active one.
"""

import logging
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any

# from sqlalchemy import select
from sqlmodel import Session, select

from distillation.config import settings
from distillation.pipeline.embedder import generate_embedding
from ingestion.models.memory import EpisodicEvent, SemanticFact

log = logging.getLogger(__name__)

# fact_type used for account-scoped category spend baselines (see app/app/api/accounts/compare/
# route.ts). account_id is now a real column on semantic_facts — it used to be encoded into
# fact_type as `category_baseline::<account_id>`; that string convention is gone.
ACCOUNT_CATEGORY_BASELINE_FACT_TYPE = "category_baseline"

# User-level balance trend fact (see app/app/api/macro/route.ts, which reads this back). This
# job connects as oikos_recall_distill_rw, which only has SELECT on episodic_events and
# SELECT/INSERT/UPDATE on semantic_facts — no grant on bank_accounts or transactions — so it
# cannot independently recompute the combined balance the way /api/macro does. Instead,
# /api/macro writes its already-computed combined_balance into the metadata of each
# macro_explanation episodic_event, and this job reads that history back to detect trends.
BALANCE_TREND_FACT_TYPE = "trend:balance_snapshot"

FactKey = tuple[str, str | None, str, str | None]  # (user_id, account_id, fact_type, category)


def fetch_recent_events(session: Session, since: datetime) -> list[EpisodicEvent]:
    stmt = select(EpisodicEvent).where(EpisodicEvent.created_at >= since)
    return list(session.exec(stmt))


def fetch_macro_explanation_events(session: Session, since: datetime) -> list[EpisodicEvent]:
    stmt = select(EpisodicEvent).where(
        EpisodicEvent.event_type == "macro_explanation",
        EpisodicEvent.created_at >= since,
    )
    return list(session.exec(stmt))


def _group_key(event: EpisodicEvent) -> tuple[str, str | None, str, str | None] | None:
    """Group by (user_id, account_id, event_type, category) — only events carrying a numeric
    metadata["amount"] participate in trend/percentile detection; the rest are memory records
    with nothing to aggregate.
    """
    metadata = event.metadata_ or {}
    if not isinstance(metadata.get("amount"), (int, float)):
        return None
    category = metadata.get("category")
    return (str(event.user_id), str(event.account_id) if event.account_id else None, event.event_type, category)


def _fact_type_for_group(event_type: str, account_id: str | None) -> str:
    """Per-account groups become account-scoped category baselines (account_id is the real
    column, not string-encoded). User-wide groups (no account_id) are namespaced by event_type.
    """
    if account_id:
        return ACCOUNT_CATEGORY_BASELINE_FACT_TYPE
    return f"trend:{event_type}"


def group_events_for_trends(events: list[EpisodicEvent]) -> dict[tuple, list[EpisodicEvent]]:
    groups: dict[tuple, list[EpisodicEvent]] = {}
    for event in events:
        key = _group_key(event)
        if key is None:
            continue
        groups.setdefault(key, []).append(event)
    return groups


def compute_group_stats(events: list[EpisodicEvent]) -> dict[str, Any]:
    amounts = sorted(float(e.metadata_["amount"]) for e in events)  # type: ignore[index]
    return {
        "occurrence_count": len(amounts),
        "mean": statistics.fmean(amounts),
        "p50": statistics.median(amounts),
        "p90": amounts[min(len(amounts) - 1, int(len(amounts) * 0.9))],
    }


def _get_active_fact(
    session: Session,
    user_id: str,
    account_id: str | None,
    fact_type: str,
    category: str | None,
) -> SemanticFact | None:
    """Look up the current active fact for this key. This lookup-then-decide step is also what
    protects the account_id IS NULL case: the partial unique index on semantic_facts cannot catch
    duplicate NULL-account_id rows (Postgres/CockroachDB never treat two NULLs as equal for
    uniqueness), so this application-level check is the only thing preventing user-level facts
    from silently duplicating. See ingestion/models/memory.py for the full explanation of why a
    sentinel "no account" UUID isn't used instead.
    """
    account_filter = SemanticFact.account_id.is_(None) if account_id is None else SemanticFact.account_id == account_id
    stmt = select(SemanticFact).where(
        SemanticFact.user_id == user_id,
        account_filter,
        SemanticFact.fact_type == fact_type,
        SemanticFact.category == category,
        SemanticFact.superseded_by.is_(None),
    )
    return session.exec(stmt).first()


def upsert_or_supersede_fact(
    session: Session,
    user_id: str,
    account_id: str | None,
    fact_type: str,
    category: str | None,
    description: str,
    running_mean: float,
    occurrence_count: int,
) -> SemanticFact:
    """Write a trend/percentile fact. Identical values are bumped in place (cheap); a materially
    different value supersedes the old row instead of overwriting it, per the memory design.
    """
    now = datetime.now(timezone.utc)
    confidence_status = "confirmed" if occurrence_count >= settings.min_occurrences_for_trend else "tentative"
    existing = _get_active_fact(session, user_id, account_id, fact_type, category)

    if existing is None:
        fact = SemanticFact(
            user_id=user_id,
            account_id=account_id,
            fact_type=fact_type,
            category=category,
            description=description,
            embedding=generate_embedding(description),
            occurrence_count=occurrence_count,
            running_mean=running_mean,
            confidence_status=confidence_status,
            relevance_score=1.0,
            last_accessed_at=now,
        )
        session.add(fact)
        session.flush()
        return fact

    materially_changed = (
        existing.description != description
        or existing.running_mean is None
        or abs(existing.running_mean - running_mean) / max(abs(existing.running_mean), 1e-9) > 0.10
    )

    if not materially_changed:
        existing.confidence_status = confidence_status
        existing.occurrence_count = occurrence_count
        existing.last_accessed_at = now
        existing.relevance_score = min(1.0, existing.relevance_score + 0.05)
        session.add(existing)
        return existing

    superseding_fact = SemanticFact(
        user_id=user_id,
        account_id=account_id,
        fact_type=fact_type,
        category=category,
        description=description,
        embedding=generate_embedding(description),
        occurrence_count=occurrence_count,
        running_mean=running_mean,
        confidence_status=confidence_status,
        relevance_score=1.0,
        last_accessed_at=now,
    )
    session.add(superseding_fact)
    session.flush()  # need superseding_fact.id before pointing the old row at it

    existing.superseded_by = superseding_fact.id
    session.add(existing)
    return superseding_fact


def run_trend_and_percentile_pass(session: Session, events: list[EpisodicEvent]) -> set[FactKey]:
    """Trend detection + percentile facts. Returns the set of (user_id, account_id, fact_type,
    category) keys touched this run, so the decay pass below leaves them alone.
    """
    touched: set[FactKey] = set()
    groups = group_events_for_trends(events)

    for group_key, group_events in groups.items():
        if len(group_events) < settings.min_occurrences_for_trend:
            continue  # not enough data points to call this a trend yet

        user_id, account_id, event_type, category = group_key
        fact_type = _fact_type_for_group(event_type, account_id)
        stats = compute_group_stats(group_events)

        category_label = category or "this"
        description = (
            f"{category_label} averages ₹{stats['mean']:,.0f} "
            f"(p50 ₹{stats['p50']:,.0f}, p90 ₹{stats['p90']:,.0f}) "
            f"across {stats['occurrence_count']} occurrences."
        )

        upsert_or_supersede_fact(
            session,
            user_id=user_id,
            account_id=account_id,
            fact_type=fact_type,
            category=category,
            description=description,
            running_mean=stats["mean"],
            occurrence_count=stats["occurrence_count"],
        )
        touched.add((user_id, account_id, fact_type, category))

    return touched


def _extract_balance_snapshots(events: list[EpisodicEvent]) -> list[tuple[datetime, float]]:
    """Chronological (created_at, combined_balance) pairs from one user's macro_explanation
    events — only events whose metadata actually carried a usable numeric balance.
    """
    dated = [
        (e.created_at, float(e.metadata_["combined_balance"]))  # type: ignore[index]
        for e in events
        if isinstance((e.metadata_ or {}).get("combined_balance"), (int, float))
    ]
    return sorted(dated, key=lambda pair: pair[0])


def _classify_balance_steps(snapshots: list[tuple[datetime, float]]) -> list[str]:
    """One "flat" | "down" | "up" label per consecutive pair of snapshots."""
    steps = []
    for (_, prev), (_, curr) in zip(snapshots, snapshots[1:]):
        if prev == 0:
            steps.append("flat")
            continue
        pct_change = (curr - prev) / abs(prev)
        if abs(pct_change) <= settings.balance_flat_tolerance_pct:
            steps.append("flat")
        else:
            steps.append("down" if pct_change < 0 else "up")
    return steps


def _format_elapsed_duration(elapsed: timedelta) -> str:
    """Phrase an elapsed timedelta for the trend description — measured from the run's first to
    last snapshot, not a count of distinct calendar month labels. Counting labels conflates
    "spans a month boundary" with "spans a month": two snapshots a day apart straddling midnight
    on the 1st would count as 2 distinct "%Y-%m" labels and misreport as "about 2 months".
    """
    days = elapsed.total_seconds() / 86400
    if days < 1:
        return "less than a day"
    if days < 60:
        whole_days = max(1, round(days))
        return f"{whole_days} day{'' if whole_days == 1 else 's'}"
    months = round(days / 30)
    return f"about {months} month{'' if months == 1 else 's'}"


def describe_balance_trend(snapshots: list[tuple[datetime, float]]) -> tuple[str, int] | None:
    """Describe the trailing run of agreeing steps (flat/down/up) at the end of the snapshot
    history. A single reversal ends the run, so this never confirms a trend off one data point —
    the run naturally requires at least two snapshots (one step) to exist at all, and the
    resulting occurrence_count feeds the same confirmed/tentative threshold as every other fact.
    Returns (description, occurrence_count), or None if there's no direction to report yet.
    """
    steps = _classify_balance_steps(snapshots)
    if not steps:
        return None  # fewer than 2 snapshots — nothing to compare yet

    direction = steps[-1]
    run_length = 1
    for step in reversed(steps[:-1]):
        if step != direction:
            break
        run_length += 1

    occurrence_count = run_length + 1  # steps in the run, plus the anchor snapshot they started from
    run_snapshots = snapshots[-occurrence_count:]
    latest_balance = run_snapshots[-1][1]
    first_balance = run_snapshots[0][1]
    elapsed = run_snapshots[-1][0] - run_snapshots[0][0]
    duration_phrase = _format_elapsed_duration(elapsed)

    if direction == "flat":
        description = (
            f"Combined balance has stayed roughly flat around ₹{round(latest_balance):,} "
            f"for {duration_phrase}."
        )
    else:
        pct = abs((latest_balance - first_balance) / first_balance) * 100 if first_balance else 0.0
        verb = "declined" if direction == "down" else "increased"
        description = (
            f"Combined balance has {verb} about {pct:.0f}% (to ₹{round(latest_balance):,}) "
            f"over {duration_phrase}."
        )

    return description, occurrence_count


def run_balance_trend_pass(session: Session, macro_events: list[EpisodicEvent]) -> set[FactKey]:
    """Per user, compare their combined-balance history (carried in macro_explanation metadata)
    and, once a consistent direction holds across multiple checks, write/update a
    trend:balance_snapshot fact via the standard supersede-don't-overwrite pattern.
    """
    touched: set[FactKey] = set()

    by_user: dict[str, list[EpisodicEvent]] = {}
    for event in macro_events:
        by_user.setdefault(str(event.user_id), []).append(event)

    for user_id, user_events in by_user.items():
        snapshots = _extract_balance_snapshots(user_events)
        result = describe_balance_trend(snapshots)
        if result is None:
            continue
        description, occurrence_count = result

        upsert_or_supersede_fact(
            session,
            user_id=user_id,
            account_id=None,
            fact_type=BALANCE_TREND_FACT_TYPE,
            category=None,
            description=description,
            running_mean=snapshots[-1][1],
            occurrence_count=occurrence_count,
        )
        touched.add((user_id, None, BALANCE_TREND_FACT_TYPE, None))

    return touched


def run_decay_pass(session: Session, touched: set[FactKey]) -> int:
    """Lower relevance_score on active facts that weren't reinforced this run and haven't been
    accessed recently — so infrequently-relevant facts fade rather than being deleted outright.
    """
    stale_cutoff = datetime.now(timezone.utc) - timedelta(days=settings.decay_stale_after_days)
    stmt = select(SemanticFact).where(
        SemanticFact.superseded_by.is_(None),
        SemanticFact.last_accessed_at < stale_cutoff,
    )

    decayed = 0
    for fact in session.exec(stmt):
        key: FactKey = (
            str(fact.user_id),
            str(fact.account_id) if fact.account_id else None,
            fact.fact_type,
            fact.category,
        )
        if key in touched:
            continue
        fact.relevance_score = max(0.05, fact.relevance_score * settings.decay_factor)
        session.add(fact)
        decayed += 1

    return decayed


def run_distillation() -> dict[str, int]:
    """Entry point — fetch recent episodic_events, distill trends/percentiles/balance snapshots,
    then decay.
    """
    from distillation.db.client import get_session

    since = datetime.now(timezone.utc) - timedelta(days=settings.distill_lookback_days)
    balance_since = datetime.now(timezone.utc) - timedelta(days=settings.balance_trend_lookback_days)

    with get_session() as session:
        events = fetch_recent_events(session, since)
        touched = run_trend_and_percentile_pass(session, events)

        macro_events = fetch_macro_explanation_events(session, balance_since)
        touched |= run_balance_trend_pass(session, macro_events)

        decayed_count = run_decay_pass(session, touched)

    summary = {
        "events_scanned": len(events) + len(macro_events),
        "facts_touched": len(touched),
        "facts_decayed": decayed_count,
    }
    log.info("Distillation run complete", extra=summary)
    return summary
