// Structured error logging for server-side code — every catch block that degrades to a generic
// fallback response should call this instead of a bare console.error (or, worse, nothing), so the
// real cause survives in server logs even though the user only ever sees a generic message.
// Deliberately dependency-free: one JSON line per error, greppable/parseable in whatever log
// viewer is watching stdout (Vercel, etc.), without introducing a logging library.
export interface ErrorLogContext {
  // Short label identifying which function/code path this occurred in, e.g.
  // "runAgentLoop.parseToolCall" — this is what makes a log line findable later.
  context: string
  error: unknown
  // Any additional request context worth keeping for after-the-fact debugging: user_id,
  // account_id, question, sql, etc. Passed through as-is.
  [key: string]: unknown
}

export function logError({ context, error, ...extra }: ErrorLogContext): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  console.error(JSON.stringify({
    level: "error",
    timestamp: new Date().toISOString(),
    context,
    message,
    stack,
    ...extra,
  }))
}
