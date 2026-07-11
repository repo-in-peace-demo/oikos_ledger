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

# Account-pair spending comparison (see app/components/analytics/ComparePanel.tsx and
# app/app/api/accounts/compare/route.ts). account_id/compared_account_id are real columns on
# semantic_facts — see ingestion/models/memory.py — not string-encoded, same reasoning that
# already replaced the old `category_baseline::<account_id>` convention.
COMPARISON_SNAPSHOT_FACT_TYPE = "trend:comparison_snapshot"

# (user_id, account_id, compared_account_id, fact_type, category). compared_account_id is None
# for every fact_type except trend:comparison_snapshot.
FactKey = tuple[str, str | None, str | None, str, str | None]


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
    compared_account_id: str | None = None,
) -> SemanticFact | None:
    """Look up the current active fact for this key. This lookup-then-decide step is also what
    protects the account_id IS NULL case: the partial unique index on semantic_facts cannot catch
    duplicate NULL-account_id rows (Postgres/CockroachDB never treat two NULLs as equal for
    uniqueness), so this application-level check is the only thing preventing user-level facts
    from silently duplicating. See ingestion/models/memory.py for the full explanation of why a
    sentinel "no account" UUID isn't used instead. Same NULL-safe pattern applied to
    compared_account_id, which is only ever non-None for trend:comparison_snapshot facts.
    """
    account_filter = SemanticFact.account_id.is_(None) if account_id is None else SemanticFact.account_id == account_id
    compared_filter = (
        SemanticFact.compared_account_id.is_(None) if compared_account_id is None
        else SemanticFact.compared_account_id == compared_account_id
    )
    stmt = select(SemanticFact).where(
        SemanticFact.user_id == user_id,
        account_filter,
        compared_filter,
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
    compared_account_id: str | None = None,
) -> SemanticFact:
    """Write a trend/percentile fact. Identical values are bumped in place (cheap); a materially
    different value supersedes the old row instead of overwriting it, per the memory design.
    """
    now = datetime.now(timezone.utc)
    confidence_status = "confirmed" if occurrence_count >= settings.min_occurrences_for_trend else "tentative"
    existing = _get_active_fact(session, user_id, account_id, fact_type, category, compared_account_id)

    if existing is None:
        fact = SemanticFact(
            user_id=user_id,
            account_id=account_id,
            compared_account_id=compared_account_id,
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
        compared_account_id=compared_account_id,
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

    # The partial unique index (uq_semantic_facts_user_fact_category_active) only applies WHERE
    # superseded_by IS NULL — inserting superseding_fact (same user/account/compared_account/
    # fact_type/category key) while `existing` still has superseded_by NULL means both rows would
    # briefly satisfy that predicate at once, which CockroachDB rejects synchronously (not
    # deferred to commit): "duplicate key value violates unique constraint". So `existing` has to
    # stop being active *before* the new row is inserted, not after. It doesn't have
    # superseding_fact's id yet at this point — self-reference temporarily (a valid FK target,
    # since the row already exists) purely to clear the NULL and free the slot, then overwrite
    # with the real forward pointer once superseding_fact has an id.
    existing.superseded_by = existing.id
    session.add(existing)
    session.flush()

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
        touched.add((user_id, account_id, None, fact_type, category))

    return touched


def _extract_balance_snapshots(
    events: list[EpisodicEvent],
) -> list[tuple[datetime, float, frozenset[str] | None]]:
    """Chronological (created_at, combined_balance, account_ids) triples from one user's
    macro_explanation events — only events whose metadata actually carried a usable numeric
    balance. account_ids is the frozenset of account_ids that contributed to combined_balance at
    that snapshot (see app/app/api/macro/route.ts), or None if the event predates that field —
    used to detect a genuine change in which accounts are being combined (e.g. a second account
    added), separately from a change in the resulting balance number. See
    _classify_balance_steps/describe_balance_trend.
    """
    dated: list[tuple[datetime, float, frozenset[str] | None]] = []
    for e in events:
        metadata = e.metadata_ or {}
        balance = metadata.get("combined_balance")
        if not isinstance(balance, (int, float)):
            continue
        raw_account_ids = metadata.get("account_ids")
        account_ids = (
            frozenset(str(a) for a in raw_account_ids)
            if isinstance(raw_account_ids, list)
            else None
        )
        dated.append((e.created_at, float(balance), account_ids))
    return sorted(dated, key=lambda triple: triple[0])


def _classify_balance_steps(
    snapshots: list[tuple[datetime, float, frozenset[str] | None]],
) -> list[str]:
    """One "flat" | "down" | "up" | "account_set_changed" label per consecutive pair of
    snapshots. "account_set_changed" wins over the numeric comparison entirely — a jump caused by
    a newly-tracked account isn't a balance trend step at all, so no percentage is computed for
    it. Only fires when BOTH snapshots have a known account_ids set and they actually differ — an
    unknown set (an event recorded before this field existed) is treated as unchanged, the same
    conservative default as before this field existed, rather than risk masking a genuine trend
    off incomplete old data.
    """
    steps = []
    for (_, prev, prev_accounts), (_, curr, curr_accounts) in zip(snapshots, snapshots[1:]):
        if prev_accounts is not None and curr_accounts is not None and prev_accounts != curr_accounts:
            steps.append("account_set_changed")
            continue
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


def describe_balance_trend(
    snapshots: list[tuple[datetime, float, frozenset[str] | None]],
) -> tuple[str, int] | None:
    """Describe the trailing run of agreeing steps (flat/down/up) at the end of the snapshot
    history. A single reversal ends the run, so this never confirms a trend off one data point —
    the run naturally requires at least two snapshots (one step) to exist at all, and the
    resulting occurrence_count feeds the same confirmed/tentative threshold as every other fact.
    Returns (description, occurrence_count), or None if there's no direction to report yet.

    If the account set changed between the two most recent snapshots (e.g. a second account
    added), that's not a trend step — no percentage is computed, and the prior run is not
    continued. The latest snapshot becomes occurrence 1 of a fresh trend instead, same as a
    genuinely first-ever snapshot would be, with a description naming what actually happened
    rather than a misleading "balance jumped/declined by X%" narration.
    """
    steps = _classify_balance_steps(snapshots)
    if not steps:
        return None  # fewer than 2 snapshots — nothing to compare yet

    if steps[-1] == "account_set_changed":
        latest_balance = snapshots[-1][1]
        description = (
            "Started tracking a new account — balance trend will resume from here "
            f"(combined balance now ₹{round(latest_balance):,})."
        )
        return description, 1

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
        touched.add((user_id, None, None, BALANCE_TREND_FACT_TYPE, None))

    return touched


def fetch_comparison_run_events(session: Session, since: datetime) -> list[EpisodicEvent]:
    stmt = select(EpisodicEvent).where(
        EpisodicEvent.event_type == "comparison_run",
        EpisodicEvent.created_at >= since,
    )
    return list(session.exec(stmt))


def _extract_comparison_pairs(
    comparison_events: list[EpisodicEvent],
) -> dict[tuple[str, str, str], dict[str, str]]:
    """Distinct (user_id, account_a, account_b) pairs actually compared via the Compare feature —
    account_a < account_b (string comparison) so the pair key is stable regardless of which order
    the user selected the two accounts in, sourced from comparison_run events' metadata
    (account_ids, account_labels — see app/app/api/accounts/compare/route.ts), not synthesized
    from every possible pair of a user's accounts. Returns pair -> {account_id: label}, merging
    labels across every event that carried them — an event from before account_labels was added
    to that route won't have any, so later events fill the gap.
    """
    pairs: dict[tuple[str, str, str], dict[str, str]] = {}
    for event in comparison_events:
        metadata = event.metadata_ or {}
        account_ids = metadata.get("account_ids")
        labels = metadata.get("account_labels") or {}
        if not isinstance(account_ids, list) or len(account_ids) < 2:
            continue
        user_id = str(event.user_id)
        for i in range(len(account_ids)):
            for j in range(i + 1, len(account_ids)):
                a, b = sorted([str(account_ids[i]), str(account_ids[j])])
                merged = pairs.setdefault((user_id, a, b), {})
                for account_id in (a, b):
                    if account_id in labels:
                        merged[account_id] = labels[account_id]
    return pairs


def _get_confirmed_category_baselines(
    session: Session, user_id: str, account_id: str,
) -> dict[str, SemanticFact]:
    """Active, confirmed category_baseline facts for one account, keyed by category. Only
    confirmed facts participate in a comparison — an unconfirmed baseline isn't solid enough
    evidence to compare against another account's yet.
    """
    stmt = select(SemanticFact).where(
        SemanticFact.user_id == user_id,
        SemanticFact.account_id == account_id,
        SemanticFact.fact_type == ACCOUNT_CATEGORY_BASELINE_FACT_TYPE,
        SemanticFact.confidence_status == "confirmed",
        SemanticFact.superseded_by.is_(None),
    )
    return {fact.category: fact for fact in session.exec(stmt) if fact.category}


def describe_comparison_snapshot(
    account_label: str,
    compared_label: str,
    category: str,
    delta: float,
    prior_delta: float | None,
    prior_run_length: int,
) -> tuple[str, int]:
    """delta = account_id's category mean minus compared_account_id's category mean, always
    computed in that fixed order regardless of who's currently higher — account_id/
    compared_account_id are a stable, canonical pair key (see _extract_comparison_pairs), never
    reassigned to whoever's winning, so the same fact row can be superseded across a flip instead
    of silently keying to a brand new row that the old one never gets linked to.

    Run length increments only if the *sign* of delta agrees with the previous check's delta
    (same account still higher) — a sign flip means the relationship reversed, so the run resets
    to 1 rather than continuing to count through a reversal. Mirrors describe_balance_trend's
    same-direction run-length logic, applied to "which account is higher" instead of "balance
    direction". Returns (description, occurrence_count).
    """
    if prior_delta is not None and prior_delta != 0 and (delta > 0) == (prior_delta > 0):
        run_length = prior_run_length + 1
    else:
        run_length = 1

    higher_label, lower_label = (
        (account_label, compared_label) if delta >= 0 else (compared_label, account_label)
    )
    check_word = "check" if run_length == 1 else "checks"
    description = (
        f"{higher_label} has run higher than {lower_label} in {category} spending "
        f"for {run_length} consecutive {check_word}."
    )
    return description, run_length


def run_comparison_snapshot_pass(
    session: Session,
    comparison_events: list[EpisodicEvent],
) -> set[FactKey]:
    """Per (user, account pair) actually compared via the Compare feature (not every possible pair
    of a user's accounts — only ones evidenced by a comparison_run event), compare confirmed
    category_baseline facts shared by both accounts and track which account has run higher in
    that category across consecutive distillation checks. Skips a category entirely if either
    account doesn't have a confirmed baseline for it yet — nothing solid enough to compare.
    """
    touched: set[FactKey] = set()
    pairs = _extract_comparison_pairs(comparison_events)

    for (user_id, account_a, account_b), labels in pairs.items():
        label_a = labels.get(account_a, account_a)
        label_b = labels.get(account_b, account_b)

        baselines_a = _get_confirmed_category_baselines(session, user_id, account_a)
        baselines_b = _get_confirmed_category_baselines(session, user_id, account_b)
        shared_categories = set(baselines_a) & set(baselines_b)

        for category in shared_categories:
            fact_a = baselines_a[category]
            fact_b = baselines_b[category]
            if fact_a.running_mean is None or fact_b.running_mean is None:
                continue  # confirmed but no mean recorded — shouldn't happen, nothing to compare

            delta = fact_a.running_mean - fact_b.running_mean

            existing = _get_active_fact(
                session, user_id, account_a, COMPARISON_SNAPSHOT_FACT_TYPE, category,
                compared_account_id=account_b,
            )
            prior_delta = existing.running_mean if existing else None
            prior_run_length = existing.occurrence_count if existing else 0

            description, run_length = describe_comparison_snapshot(
                label_a, label_b, category, delta, prior_delta, prior_run_length,
            )

            upsert_or_supersede_fact(
                session,
                user_id=user_id,
                account_id=account_a,
                fact_type=COMPARISON_SNAPSHOT_FACT_TYPE,
                category=category,
                description=description,
                running_mean=delta,
                occurrence_count=run_length,
                compared_account_id=account_b,
            )
            touched.add((user_id, account_a, account_b, COMPARISON_SNAPSHOT_FACT_TYPE, category))

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
            str(fact.compared_account_id) if fact.compared_account_id else None,
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
    """Entry point — fetch recent episodic_events, distill trends/percentiles/balance snapshots/
    comparison snapshots, then decay.
    """
    from distillation.db.client import get_session

    since = datetime.now(timezone.utc) - timedelta(days=settings.distill_lookback_days)
    balance_since = datetime.now(timezone.utc) - timedelta(days=settings.balance_trend_lookback_days)

    with get_session() as session:
        events = fetch_recent_events(session, since)
        touched = run_trend_and_percentile_pass(session, events)

        macro_events = fetch_macro_explanation_events(session, balance_since)
        touched |= run_balance_trend_pass(session, macro_events)

        # comparison_run events happen whenever a user visits Compare — occasional/on-demand, same
        # cadence concern as macro_explanation, so this reuses the same long lookback rather than
        # the generic 7-day distill_lookback_days (which would miss most runs).
        comparison_events = fetch_comparison_run_events(session, balance_since)
        touched |= run_comparison_snapshot_pass(session, comparison_events)

        decayed_count = run_decay_pass(session, touched)

    summary = {
        "events_scanned": len(events) + len(macro_events) + len(comparison_events),
        "facts_touched": len(touched),
        "facts_decayed": decayed_count,
    }
    log.info("Distillation run complete", extra=summary)
    return summary
