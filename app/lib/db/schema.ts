// Drizzle ORM schema definitions for all 13 Aurora PostgreSQL tables — mirrors SQLModel models in ingestion/models/

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  customType,
  date,
  doublePrecision,
  integer,
  json,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// ── Custom column type for PostGIS GEOMETRY(Point, 4326) ─────────────────────

const geometry = customType<{ data: string }>({
  dataType() {
    return "geometry(Point,4326)";
  },
});

// ── Enums ─────────────────────────────────────────────────────────────────────

export const accountTypeEnum = pgEnum("account_type", [
  "checking",
  "savings",
  "credit",
]);

export const uploadStatusEnum = pgEnum("upload_status", [
  "pending",
  "processing",
  "complete",
  "failed",
  "cancelled",
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "debit",
  "credit",
]);

export const amendedByEnum = pgEnum("amended_by", ["user", "system"]);

export const macroIndicatorEnum = pgEnum("macro_indicator", [
  "gdp_growth",
  "inflation",
  "food_inflation",
  "gdp_per_capita",
  "repo_rate",
]);

export const recommendationTypeEnum = pgEnum("recommendation_type", [
  "reduce_spending",
  "shift_category",
  "macro_alert",
]);

export const priorityEnum = pgEnum("priority", ["high", "medium", "low"]);

export const voiceRoleEnum = pgEnum("voice_role", ["user", "assistant"]);

// ── Tables ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  first_name: text("first_name"),
  last_name: text("last_name"),
  country_code: text("country_code").notNull(),
  currency: text("currency").notNull(),
  income_bracket: text("income_bracket"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bank_accounts = pgTable("bank_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  bank_name: text("bank_name").notNull(),
  account_type: accountTypeEnum("account_type").notNull(),
  account_nickname: text("account_nickname"),
  currency: text("currency").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  global_merchant_id: text("global_merchant_id"),
  canonical_name: text("canonical_name").notNull(),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  location: geometry("location"),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uqCanonicalName: uniqueIndex("uq_merchants_canonical_name").on(table.canonical_name),
}));

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  parent_id: uuid("parent_id").references((): AnyPgColumn => categories.id),
  icon: text("icon"),
  color: text("color"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const uploads = pgTable("uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  account_id: uuid("account_id").notNull().references(() => bank_accounts.id),
  filename: text("filename").notNull(),
  file_hash: text("file_hash"),
  s3_key: text("s3_key").notNull(),
  status: uploadStatusEnum("status").notNull(),
  row_count: integer("row_count"),
  error_message: text("error_message"),
  uploaded_at: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
  opening_balance: numeric("opening_balance", { precision: 15, scale: 2 }),
  closing_balance: numeric("closing_balance", { precision: 15, scale: 2 }),
  balance_verified: boolean("balance_verified"),
  balance_discrepancy: numeric("balance_discrepancy", { precision: 15, scale: 2 }),
  dropped_rows: json("dropped_rows").$type<import("@/types").DroppedRow[]>(),
}, (table) => ({
  uqUserAccountHash: uniqueIndex("uq_uploads_user_account_hash").on(table.user_id, table.account_id, table.file_hash),
}));

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  account_id: uuid("account_id").notNull().references(() => bank_accounts.id),
  merchant_id: uuid("merchant_id").references(() => merchants.id),
  upload_id: uuid("upload_id").notNull().references(() => uploads.id),
  row_number: integer("row_number"),
  transaction_date: date("transaction_date").notNull(),
  raw_description: text("raw_description").notNull(),
  normalized_merchant: text("normalized_merchant").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  closing_balance: numeric("closing_balance", { precision: 15, scale: 2 }),
  currency: text("currency").notNull(),
  transaction_type: transactionTypeEnum("transaction_type").notNull(),
  reference_number: text("reference_number"),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  payment_method: text("payment_method"),
  location: geometry("location"),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // no updated_at — append-only table
}, (table) => ({
  uqRefNumber: uniqueIndex("uq_transactions_ref_number")
    .on(table.user_id, table.account_id, table.reference_number)
    .where(sql`${table.reference_number} IS NOT NULL`),
  uqComposite: uniqueIndex("uq_transactions_composite")
    .on(table.user_id, table.account_id, table.transaction_date, table.amount, table.normalized_merchant),
}));

export const transaction_amendments = pgTable("transaction_amendments", {
  id: uuid("id").primaryKey().defaultRandom(),
  transaction_id: uuid("transaction_id").notNull().references(() => transactions.id),
  amendment_group_id: uuid("amendment_group_id").notNull(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  field_name: text("field_name").notNull(),
  old_value: text("old_value").notNull(),
  new_value: text("new_value").notNull(),
  amended_by: amendedByEnum("amended_by").notNull(),
  reason: text("reason"),
  amended_at: timestamp("amended_at", { withTimezone: true }).notNull().defaultNow(),
  // no updated_at — append-only table
});

export const macro_economic_data = pgTable("macro_economic_data", {
  id: uuid("id").primaryKey().defaultRandom(),
  country_code: text("country_code").notNull(),
  indicator: macroIndicatorEnum("indicator").notNull(),
  period: text("period").notNull(),
  value: numeric("value", { precision: 12, scale: 4 }).notNull(),
  source: text("source").notNull(),
  fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uqCountryIndicatorPeriod: uniqueIndex("uq_macro_country_indicator_period")
    .on(table.country_code, table.indicator, table.period),
}));

export const episodic_events = pgTable("episodic_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  account_id: uuid("account_id").references(() => bank_accounts.id),
  event_type: text("event_type").notNull(), // macro_explanation | insight_shown | comparison_run | category_spend_snapshot | ...
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // no updated_at — append-only/immutable table, never updated after insert
});

export const semantic_facts = pgTable("semantic_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  // NULL = user-level fact (e.g. Macro-feature facts, not tied to one account).
  // Non-NULL = account-specific fact (e.g. Compare-feature per-account category baselines).
  // Deliberately kept nullable rather than a sentinel "no account" UUID — see the NULL-uniqueness
  // caveat on the index below, and ingestion/models/memory.py for the full explanation.
  account_id: uuid("account_id").references(() => bank_accounts.id),
  // Populated only for trend:comparison_snapshot facts — the other account in the pair being
  // compared. NULL for every other fact_type, same nullable-FK pattern as account_id above. A
  // real column, not string-encoded into category — same reasoning that already replaced the old
  // `category_baseline::<account_id>` convention.
  compared_account_id: uuid("compared_account_id").references(() => bank_accounts.id),
  fact_type: text("fact_type").notNull(),
  category: text("category"),
  description: text("description").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  occurrence_count: integer("occurrence_count").notNull().default(0),
  opportunity_count: integer("opportunity_count").notNull().default(0),
  running_mean: doublePrecision("running_mean"),
  confidence_status: text("confidence_status").notNull().default("tentative"),
  relevance_score: doublePrecision("relevance_score").notNull().default(1.0),
  last_accessed_at: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
  superseded_by: uuid("superseded_by").references((): AnyPgColumn => semantic_facts.id),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Partial unique index — only one *active* fact per (user, account, fact_type, category);
  // superseded rows keep the same key with superseded_by pointing at the new row.
  //
  // NULL-uniqueness caveat: Postgres/CockroachDB never treat two NULLs as equal for uniqueness,
  // so two user-level rows (account_id IS NULL) with the same user/fact_type/category would NOT
  // collide here. This is handled at the application level, not with a sentinel value — see the
  // detailed comment in ingestion/models/memory.py (the authoritative definition; create_tables.py
  // owns migrations).
  uqUserFactCategoryActive: uniqueIndex("uq_semantic_facts_user_fact_category_active")
    .on(table.user_id, table.account_id, table.compared_account_id, table.fact_type, table.category)
    .where(sql`superseded_by IS NULL`),
}));

export const insights = pgTable("insights", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  period: text("period").notNull(),
  category: text("category").notNull(),
  total_amount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  transaction_count: integer("transaction_count").notNull(),
  avg_amount: numeric("avg_amount", { precision: 12, scale: 2 }).notNull(),
  mom_delta: numeric("mom_delta", { precision: 12, scale: 2 }).notNull(),
  last_upload_id: uuid("last_upload_id").notNull().references(() => uploads.id),
  computed_at: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uqUserPeriodCategory: uniqueIndex("uq_insights_user_period_category")
    .on(table.user_id, table.period, table.category),
}));

export const recommendations = pgTable("recommendations", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  type: recommendationTypeEnum("type").notNull(),
  priority: priorityEnum("priority").notNull(),
  message: text("message").notNull(),
  supporting_data: jsonb("supporting_data").notNull(),
  category: text("category"),
  macro_indicator: text("macro_indicator"),
  is_dismissed: boolean("is_dismissed").notNull().default(false),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uqUserTypeCategory: uniqueIndex("uq_recommendations_user_type_category")
    .on(table.user_id, table.type, table.category),
}));

export const query_cache = pgTable("query_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  query_hash: text("query_hash").notNull(),
  query_text: text("query_text").notNull(),
  query_embedding: vector("query_embedding", { dimensions: 1536 }).notNull(),
  result: jsonb("result").notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uqUserQuery: uniqueIndex("uq_query_cache_user_query").on(table.user_id, table.query_hash),
}));

export const voice_sessions = pgTable("voice_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id").notNull().references(() => users.id),
  started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  ended_at: timestamp("ended_at", { withTimezone: true }),
});

export const voice_messages = pgTable("voice_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  session_id: uuid("session_id").notNull().references(() => voice_sessions.id),
  role: voiceRoleEnum("role").notNull(),
  content: text("content").notNull(),
  generated_query: text("generated_query"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
