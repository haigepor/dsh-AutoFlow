/** Safe actionable errors shared by task, tool and relay callers. */
import type { ImageFailure } from './types.ts'
import { AccountError, AccountRejected } from '../accounts/record.ts'

/** Image errors contain only fixed safe messages; backend bodies are never copied. */
export class ImageServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); this.name = 'ImageServiceError' }
}

const networkFailures = new Set(['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])

/** @param error The original interruption or local cancellation reason.
 * @param status HTTP status when response headers arrived.
 * @param requestId Validated response correlation ID when available.
 * @returns An unconfirmed outcome with safe transport details for the saved receipt.
 */
export function unknownImageOutcome(error: unknown, status: number | undefined, requestId: string | undefined): ImageFailure {
  const stage = status === undefined
    ? 'The image operation stopped after recording dispatch, before response headers arrived.'
    : `The image operation received HTTP ${status} headers, but the response body could not be read in full.`
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
  const causeCode = cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
  const detail = error instanceof ImageServiceError && ['image-deadline', 'image-response-too-large', 'invalid-image-response', 'image-service-stopped'].includes(error.code)
    ? error.message
    : causeCode && networkFailures.has(causeCode) ? `Transport error ${causeCode}.` : ''
  return { code: 'image-outcome-unknown', message: [stage, detail, 'The remote outcome is unknown. Keep the saved receipt for confirmation.'].filter(Boolean).join(' '),
    ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }) }
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
