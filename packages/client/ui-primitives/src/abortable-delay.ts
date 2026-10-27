/** Browser timer shared by owner-cancelled UI recovery loops. */

/**
 * Wait for one timer interval while releasing the timer and listener on cancellation.
 * @param milliseconds - delay passed to the browser timer.
 * @param signal - caller lifetime or recovery deadline; existing Error reasons are preserved.
 * @returns fulfillment after the interval, or rejection with the abort Error or an AbortError.
 */
export function waitForAbortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new DOMException('Operation cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
