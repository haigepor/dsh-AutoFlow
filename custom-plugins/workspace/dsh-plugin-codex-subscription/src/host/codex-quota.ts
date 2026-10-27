/** Read Codex quota hints without buffering or rewriting the model's SSE bytes. */
import { createParser } from 'eventsource-parser'
import { z } from 'zod'
import type { AccountUsage } from './accounts/types.ts'

type Window = NonNullable<AccountUsage['primary']>
type Windows = Pick<AccountUsage, 'primary' | 'secondary'>
const windowSchema = z.object({ used_percent: z.number().finite(), window_minutes: z.number().positive(), reset_at: z.number().finite().optional(), reset_after_seconds: z.number().finite().optional() })
const eventSchema = z.object({ type: z.literal('codex.rate_limits'), metered_limit_name: z.string().optional(), rate_limits: z.object({ primary: windowSchema.optional(), secondary: windowSchema.optional() }) })
const SCAN_BYTES = 64 * 1024

function windowOf(value: z.infer<typeof windowSchema>, now: number): Window {
  const resetAt = value.reset_at === undefined ? value.reset_after_seconds === undefined ? undefined : now + value.reset_after_seconds * 1000 : value.reset_at * 1000
  return { usedPercent: value.used_percent, windowSeconds: value.window_minutes * 60, ...(resetAt === undefined ? {} : { resetAt }) }
}

function headerWindows(headers: Headers, now: number): Windows {
  const windows: Windows = {}
  for (const name of ['primary', 'secondary'] as const) {
    const prefix = `x-codex-${name}-`
    const numeric = (key: string): number | undefined => { const value = headers.get(prefix + key); return value === null || value.trim() === '' ? undefined : Number(value) }
    const candidate = windowSchema.safeParse({ used_percent: numeric('used-percent'), window_minutes: numeric('window-minutes'),
      reset_at: numeric('reset-at'), reset_after_seconds: numeric('reset-after-seconds') })
    if (candidate.success) windows[name] = windowOf(candidate.data, now)
  }
  return windows
}

/** Observe account-wide quota headers and the bounded SSE prelude; model-specific limits are ignored.
 * @param response Owned fetch response; the returned response owns its reader.
 * @param now Current clock value used for relative resets.
 * @param note Synchronous account-cache update, called only for validated quota hints.
 * @returns Original JSON response or an SSE response forwarding the exact original chunks.
 */
export function observeCodexQuota(response: Response, now: number, note: (windows: Windows) => void): Response {
  const headers = headerWindows(response.headers, now)
  if (headers.primary !== undefined || headers.secondary !== undefined) note(headers)
  const type = response.headers.get('content-type') ?? ''
  if (!response.ok || response.body === null || type !== '' && !type.includes('text/event-stream')) return response
  let scanning = true, remaining = SCAN_BYTES, released = false
  const decoder = new TextDecoder()
  const parser = createParser({ onError: () => { scanning = false }, onEvent: event => {
    let raw: unknown
    try { raw = JSON.parse(event.data) } catch (_error) { return /* 非 JSON 心跳不提供额度元数据。 */ }
    const parsed = eventSchema.safeParse(raw)
    if (!parsed.success) return
    const metered = parsed.data.metered_limit_name?.trim().toLowerCase().replaceAll('-', '_') ?? ''
    if (metered !== '' && metered !== 'codex') return
    const windows: Windows = {}
    for (const name of ['primary', 'secondary'] as const) {
      const value = parsed.data.rate_limits[name]
      if (value !== undefined) windows[name] = windowOf(value, now)
    }
    if (windows.primary !== undefined || windows.secondary !== undefined) note(windows)
  } })
  const reader = response.body.getReader()
  const release = () => { if (!released) { released = true; reader.releaseLock() } }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { release(); controller.close(); return }
        if (scanning && remaining > 0) {
          const scan = next.value.subarray(0, remaining)
          remaining -= scan.byteLength
          parser.feed(decoder.decode(scan, { stream: true }))
          if (remaining === 0) scanning = false
        }
        controller.enqueue(next.value)
      } catch (error) { release(); controller.error(error) }
    },
    async cancel(reason) { try { await reader.cancel(reason) } finally { release() } },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
