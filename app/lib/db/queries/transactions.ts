import { and, desc, eq, inArray, lte } from "drizzle-orm"
import { db } from "@/lib/db/client"
import { merchants, transaction_amendments, transactions, uploads } from "@/lib/db/schema"
import { todayDateString } from "@/lib/today"
import type { UploadStatus } from "@/types"

export async function getTransactionsByAccount(
  userId: string,
  accountId: string,
  limit = 50,
  offset = 0,
) {
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), eq(transactions.account_id, accountId)))
    .orderBy(desc(transactions.transaction_date))
    .limit(limit)
    .offset(offset)
}

// Most recent closing balance for an account, and the YYYY-MM month it's from. Returns null if
// the account has no transactions at all (caller should exclude it, not treat it as a zero balance).
// Excludes future-dated rows (transaction_date > today) — demo/seed data can legitimately extend
// past today (e.g. to cover an uncertain judging window), and without this filter the "latest"
// balance would jump straight to that future date's figure instead of gradually catching up to it
// as real time passes, defeating the point of seeding ahead. Bounded at todayDateString() (the app
// server's own clock), not SQL's CURRENT_DATE — see that function's doc comment for why trusting
// two independently-evaluated clocks for the same boundary is itself a source of exactly this kind
// of off-by-one.
export async function getLatestAccountBalance(userId: string, accountId: string): Promise<{
  closing_balance: number
  as_of_month: string
} | null> {
  const [row] = await db
    .select({
      closing_balance: transactions.closing_balance,
      transaction_date: transactions.transaction_date,
    })
    .from(transactions)
    .where(and(
      eq(transactions.user_id, userId),
      eq(transactions.account_id, accountId),
      lte(transactions.transaction_date, todayDateString()),
    ))
    .orderBy(desc(transactions.transaction_date), desc(transactions.row_number))
    .limit(1)

  if (!row || row.closing_balance == null) return null

  return {
    closing_balance: Number(row.closing_balance),
    as_of_month: row.transaction_date.slice(0, 7), // "YYYY-MM-DD" -> "YYYY-MM"
  }
}

export async function getUploadByHash(userId: string, accountId: string, fileHash: string) {
  return db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.user_id, userId),
        eq(uploads.account_id, accountId),
        eq(uploads.file_hash, fileHash),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

export async function createUpload(data: {
  user_id: string
  account_id: string
  filename: string
  file_hash: string
  s3_key: string
  status: UploadStatus
}) {
  const [upload] = await db.insert(uploads).values(data).returning()
  return upload
}

export async function getUploadById(uploadId: string) {
  return db
    .select()
    .from(uploads)
    .where(eq(uploads.id, uploadId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

export async function cancelUpload(uploadId: string): Promise<boolean> {
  const [current] = await db
    .select({ status: uploads.status })
    .from(uploads)
    .where(eq(uploads.id, uploadId))
    .limit(1)

  if (!current || current.status === "complete") {
    return false
  }

  await db.delete(transactions).where(eq(transactions.upload_id, uploadId))
  await db.update(uploads).set({ status: "cancelled" }).where(eq(uploads.id, uploadId))

  return true
}

export async function deleteUpload(uploadId: string) {
  const txns = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.upload_id, uploadId))

  const txnIds = txns.map((t) => t.id)

  if (txnIds.length > 0) {
    await db
      .delete(transaction_amendments)
      .where(inArray(transaction_amendments.transaction_id, txnIds))
  }

  await db.delete(transactions).where(eq(transactions.upload_id, uploadId))
  await db.delete(uploads).where(eq(uploads.id, uploadId))
}

export async function getLatestAmendments(transactionIds: string[]) {
  if (transactionIds.length === 0) return []
  const rows = await db
    .select()
    .from(transaction_amendments)
    .where(inArray(transaction_amendments.transaction_id, transactionIds))
    .orderBy(
      transaction_amendments.transaction_id,
      transaction_amendments.field_name,
      desc(transaction_amendments.amended_at),
    )
  // Deduplicate in JS: keep first seen per (transaction_id, field_name) — already sorted desc
  const seen = new Set<string>()
  return rows.filter((a) => {
    const key = `${a.transaction_id}:${a.field_name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function createAmendments(
  transactionId: string,
  userId: string,
  amendments: { field_name: string; old_value: string; new_value: string }[],
  amendmentGroupId: string,
  reason?: string,
) {
  const values = amendments.map((a) => ({
    transaction_id: transactionId,
    amendment_group_id: amendmentGroupId,
    user_id: userId,
    field_name: a.field_name,
    old_value: a.old_value,
    new_value: a.new_value,
    amended_by: "user" as const,
    reason: reason ?? null,
  }))
  return db.insert(transaction_amendments).values(values).returning()
}

export async function upsertMerchantFromAmendment(
  oldCanonicalName: string,
  newCanonicalName: string,
  category: string,
) {
  // Best-effort update of merchant record so future normalizations use the corrected name.
  // Silent no-op if the old name isn't in the registry or the new name already exists.
  try {
    await db
      .update(merchants)
      .set({ canonical_name: newCanonicalName, category })
      .where(eq(merchants.canonical_name, oldCanonicalName))
  } catch {
    // Ignore unique-constraint violations if new canonical_name already exists
  }
}
