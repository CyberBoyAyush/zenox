/**
 * Races `promise` against a timeout, resolving to `fallback` if the timeout
 * wins. The original promise is never cancelled or awaited further by this
 * function once the race settles — if it eventually does resolve for real
 * after the fact, nothing here reacts to it a second time.
 *
 * Use for operations that could hang instead of ever resolving/rejecting
 * (e.g. a network call to an unresponsive server), where treating "hung" the
 * same as "failed" after a bound is preferable to waiting forever.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timedOut = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer))
}
