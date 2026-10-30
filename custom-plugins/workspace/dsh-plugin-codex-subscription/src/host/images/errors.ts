/** Safe actionable errors shared by task, tool and relay callers. */
import type { ImageFailure } from './types.ts'
import { AccountError, AccountRejected } from '../accounts/record.ts'

/** Image errors contain only fixed safe messages; backend bodies are never copied. */
export class ImageServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); this.name = 'ImageServiceError' }
}

/** Project an arbitrary failure without leaking tokens, signed URLs or backend request bodies.
 * @param error Failure raised by image protocol, attachments, or infrastructure.
 * @returns A bounded safe task failure.
 */
export function imageFailure(error: unknown): ImageFailure {
  if (error instanceof AccountError && error.code === 'IMAGE_CREDITS_DISABLED') return { code: error.code, message: error.message }
  if (error instanceof AccountRejected) return { code: 'codex-image-http-error', message: error.message, status: error.status!,
    ...(error.details.retryAt === undefined ? {} : { retryAt: error.details.retryAt }), ...(error.details.requestId === undefined ? {} : { requestId: error.details.requestId }) }
  if (error instanceof ImageServiceError) return { code: error.code, message: error.message, ...(error.status === undefined ? {} : { status: error.status }) }
  return { code: 'image-operation-failed', message: 'The image operation failed. Check the account and Host diagnostics before starting a new task.' }
}
