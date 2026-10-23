/** Stable business failures; callers localize codes and never parse upstream text. */
export type CuratorErrorCode = 'invalid-input' | 'constraint-conflict' | 'revision-conflict' | 'operation-conflict' | 'reference-unavailable' | 'configuration-required' | 'capability-unavailable' | 'source-protocol-error' | 'source-continuation-invalid' | 'vision-invalid-output' | 'budget-exhausted' | 'storage-commit-failed' | 'cancelled' | 'owner-denied' | 'writer-occupied'

/** A failure whose safe fields may cross the Host/Client interface. */
export class CuratorError extends Error {
  readonly retryable: boolean
  readonly safeMessage: string
  readonly suggestedAction: string
  /** @param code Stable identity. @param stage Owning operation. @param safeMessage Safe diagnostic. @param options Recovery information and private cause. */
  constructor(readonly code: CuratorErrorCode, readonly stage: string, safeMessage: string, options: { retryable?: boolean; suggestedAction?: string; cause?: unknown; attemptId?: string } = {}) {
    super(safeMessage, { cause: options.cause })
    this.name = 'CuratorError'
    this.retryable = options.retryable ?? false
    this.safeMessage = safeMessage
    this.suggestedAction = options.suggestedAction ?? 'Review the operation and retry with current records.'
    this.attemptId = options.attemptId
  }
  readonly attemptId: string | undefined
}
