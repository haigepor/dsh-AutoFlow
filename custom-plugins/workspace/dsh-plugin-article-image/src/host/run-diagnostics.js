/** Persist bounded, allowlisted diagnostics without remote content or credentials. */
import { runEventSchema, errorCode } from '../shared/contracts.js'

const systemErrors = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'EEXIST'])
const networkErrors = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])
const errorTypes = new Map([['Error', 'error'], ['TypeError', 'type-error'], ['RangeError', 'range-error'], ['SyntaxError', 'syntax-error'], ['AbortError', 'abort-error'], ['TimeoutError', 'timeout-error'], ['AggregateError', 'aggregate-error']])

/** Classify nested causes without copying upstream text, paths or arbitrary error properties. @param {unknown} error Original failure. @param {string} operation Owned phase. @returns {object} Allowlisted diagnostic fields. */
export function failureDetails(error, operation) {
  let current = error, causeCode = errorCode(error)
  const causes = [], visited = new Set()
  for (let depth = 0; current instanceof Error && depth < 5 && !visited.has(current); depth++) {
    visited.add(current)
    const code = systemErrors.has(current.code) ? `fs-${current.code.toLowerCase()}`
      : networkErrors.has(current.code) ? `network-${current.code.toLowerCase().replaceAll('_', '-')}`
      : current.message.startsWith('atomic-write: timed out waiting for the writer lock at ') ? 'storage-lock-timeout' : errorCode(current)
    if (code !== 'operation-failed') { causeCode = code; if (!causes.includes(code)) causes.push(code) }
    current = current.cause
  }
  return { operation, causeCode, errorType: errorTypes.get(error?.name) ?? 'error', ...(causes.length ? { causes } : {}) }
}

/** Append an event with its occurrence time and discard oldest entries at the configured limit. @param {object} run Persisted attempt. @param {number} limit Retained event limit. @param {string} event Owned event code. @param {object} details Diagnostic measurements. @param {string} at Occurrence time before batched publication. */
export function appendRunEvent(run, limit, event, details = {}, at = new Date().toISOString()) {
  const fields = runEventSchema.shape.details.shape, safe = {}
  for (const [key, schema] of Object.entries(fields)) {
    const parsed = schema.safeParse(details[key])
    if (parsed.success && parsed.data !== undefined) safe[key] = parsed.data
  }
  const events = run.events ??= [], dropped = run.eventsDropped ??= 0
  const parsed = runEventSchema.safeParse({ seq: (events.at(-1)?.seq ?? dropped) + 1, at, stage: run.stage, event, details: safe })
  if (!parsed.success) return
  events.push(parsed.data)
  const excess = Math.max(0, events.length - limit)
  if (excess) { events.splice(0, excess); run.eventsDropped += excess }
}
