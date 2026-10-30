/** Auxiliary native-search inputs remain auditable without becoming the main assistant reply. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

function isNativeSearchAudit(value: unknown): value is { type: 'web/native-search-llm-request' } {
  return value !== null && typeof value === 'object' && 'type' in value
    && value.type === 'web/native-search-llm-request'
}

it('preserves native-search audit events separately from the main SDK response', async () => {
  const expected = JSON.parse(await readFile(new URL('./expected/native-web-search-projection.json', import.meta.url), 'utf8')) as {
    finalResponse: string
    auditEvents: readonly unknown[]
  }
  const harness = createProcessDeepSeekHarness({ command: process.execPath,
    args: [fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))],
    environment: () => ({ ...process.env, FAKE_TEXT: expected.finalResponse, FAKE_SESSION_EVENTS: JSON.stringify(expected.auditEvents) }),
    description: 'scripted native-search audit projection', initializeTimeoutMs: 5000 })
  try {
    const result = await harness.run('Keep the main response.')
    const projection = {
      finalResponse: result.finalResponse,
      auditEvents: result.events.filter(isNativeSearchAudit),
      auditNotifications: result.notifications.filter(notification => notification.method === 'session.event'
        && isNativeSearchAudit(notification.params.event)).map((notification) => {
        if (notification.method !== 'session.event') throw new Error('Expected a Session event notification')
        expect(notification.params.sessionId).toBe(result.sessionId)
        return { method: notification.method, event: notification.params.event }
      }),
      assistantTexts: result.events.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
    }
    expect(projection).toEqual(expected)
  } finally { await harness.close() }
})
