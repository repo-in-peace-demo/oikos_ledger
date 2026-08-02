// Single source of truth for "what day is it" across every query that needs to exclude
// future-dated transactions (demo/seed data can legitimately extend past today, e.g. seeded
// through Sep 15 to cover an uncertain judging window). Deliberately NOT the SQL engine's own
// CURRENT_DATE — the app server and the database can disagree on what "today" is (session
// timezone, connection pooling, clock skew), and trusting two independently-evaluated clocks for
// the same boundary is exactly what silently excludes today's own transactions on some days but
// not others. Callers interpolate the returned string directly as a SQL date literal.
// Accepts an already-computed Date so a caller that also needs `now` for other purposes (e.g.
// day-of-month/elapsed-fraction math) reads the clock exactly once and derives everything from
// that single instant — calling `new Date()` a second time inside this function would reintroduce
// a (vanishingly rare, but real) two-clock-reads risk right at the boundary this function exists
// to eliminate.
export function todayDateString(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}
