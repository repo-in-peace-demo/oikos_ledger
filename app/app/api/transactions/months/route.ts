import { auth } from "@/auth"
import { and, desc, eq, lte, sql } from "drizzle-orm"
import { db } from "@/lib/db/client"
import { transactions } from "@/lib/db/schema"

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const account_id = searchParams.get("account_id")

  if (!account_id) {
    return Response.json({ error: "account_id is required" }, { status: 400 })
  }

  const monthKeyExpr = sql<string>`TO_CHAR(${transactions.transaction_date}, 'YYYY-MM')`

  // Excludes future-dated rows — TransactionsPanel defaults to availableMonths[0] (the most
  // recent entry here) whenever nothing is explicitly selected yet, so without this bound a fresh
  // session would land straight on a future month from seed/demo data extending past today (e.g.
  // seeded through Sep 15 to cover an uncertain judging window) instead of the real current month.
  const rows = await db
    .selectDistinct({ month_key: monthKeyExpr })
    .from(transactions)
    .where(
      and(
        eq(transactions.user_id, session.user.id),
        eq(transactions.account_id, account_id),
        lte(transactions.transaction_date, sql`CURRENT_DATE`),
      ),
    )
    .orderBy(desc(monthKeyExpr))
    .limit(3)

  const months = rows.map(({ month_key }) => {
    const [year, month] = month_key.split("-")
    return {
      key: month_key,
      label: `${MONTH_NAMES[parseInt(month) - 1]} ${year}`,
    }
  })

  return Response.json(months)
}
