/** Failures returned by media, source and vision adapters; upstream details stay private. */
export class MediaError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    readonly retryable: boolean,
    readonly safeMessage: string,
    readonly suggestedAction: string,
    readonly diagnostics?: { modelOutput: unknown; issues: string[] },
  ) {
    super(safeMessage)
    this.name = 'MediaError'
  }
}

/** Stop local processing before publishing a new blob when cancellation was requested.
 * @param signal Optional caller cancellation; absent means local processing may continue.
 */
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaError('cancelled', 'media', false, 'Operation cancelled.', 'Start or resume the operation explicitly.')
}

/** Reject an input or configuration without copying untrusted values into diagnostics.
 * @param message Safe explanation of the invalid value.
 * @returns A nonretryable input failure.
 */
export function invalidInput(message: string): MediaError {
  return new MediaError('invalid-input', 'media', false, message, 'Correct the input and try again.')
}
