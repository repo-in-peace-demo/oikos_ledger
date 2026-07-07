# ADR 014 — Migrating from Aurora PostgreSQL to CockroachDB for the Agentic Memory Extension

**Status:** Accepted — Supersedes ADR 001, ADR 008

## Context

Oikos Ledger's original database evaluation (ADR 001) was scoped to AWS-native
options because the AWS + Vercel Hackathon required an AWS-native database —
the choice was between Aurora DSQL, DynamoDB, and Aurora PostgreSQL by rule,
not a survey of every database on the market. Aurora PostgreSQL won that
three-way comparison because Aurora DSQL's distributed architecture forgoes
the Postgres extension mechanism entirely, and pgvector/PostGIS — both
central to the architecture — are extensions.

Oikos Recall extends Oikos Ledger for the CockroachDB × AWS Hackathon, which
requires building against CockroachDB. That reasoning needs to be reconciled
now that a second distributed database is on the table.

## Why ADR 001's objection to DSQL doesn't transfer to CockroachDB

ADR 001 didn't reject distributed databases in general — it rejected DSQL
specifically because its architecture forgoes the extension mechanism
pgvector/PostGIS depend on. CockroachDB is a different distributed SQL
architecture with different tradeoffs: vector similarity search (Distributed
Vector Indexing) and spatial types (PostGIS-compatible GEOMETRY/GEOGRAPHY)
are built natively into CockroachDB's engine, not dependent on the extension
mechanism DSQL lacks. The specific gap that disqualified DSQL does not exist
here.

## Honest caveat, not glossed over

CockroachDB's spatial support is compatible with, not identical to, PostGIS —
it covers a subset of the function catalog and uses space-filling-curve
indexing rather than R-tree/GIST. Oikos Ledger's actual usage (radius-style
queries on single `Point` geometries) falls within that supported subset,
but this should be verified against the live queries before treating the
swap as zero-risk.

## Honest driver, stated plainly

This migration is substantially motivated by the hackathon's requirement to
build against CockroachDB — it is not a claim that Aurora was failing Oikos
Ledger. Aurora was working correctly. The decision is: given an external
requirement to use CockroachDB, does its architecture genuinely support the
existing workload without regression? Yes — which is a different, and more
honest, claim than "we re-evaluated and Aurora was wrong."

## Decision

Migrate the full schema — all 13 existing tables plus new `episodic_events`
and `semantic_facts` tables — to CockroachDB Cloud (Basic tier, Mumbai /
ap-south-1). Source bank statements are re-ingested through the existing
pipeline rather than data-migrated, so no export/import step is needed.

## Consequences

- All Aurora references in current-state docs (architecture.md,
  deployment.md, security.md, data_model.md, api.md, ui.md) update to
  CockroachDB — connection strings, extension setup, environment variables.
- RDS Proxy (an ADR 001 consequence) becomes moot — CockroachDB Cloud
  handles connection pooling itself.
- SQLModel and Drizzle schema definitions repoint at CockroachDB's
  connection string — Postgres wire-compatible, so the ORM layer itself
  shouldn't need rewriting, though GEOMETRY/VECTOR column type syntax needs
  verification against CockroachDB's exact grammar.
- ADR 001 and ADR 008 remain unedited apart from their status lines,
  preserving why Aurora was the right call at the time.
