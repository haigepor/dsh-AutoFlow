/** Authenticated client metadata cannot replace subscription identity or cross account affinity. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexResponsesTransport } from '../src/host/relay/transport.ts'
import type { AccountLease, AccountRequest } from '../src/host/accounts/types.ts'

test('gateway keys isolate cache identity and turn state follows the selected credential generation', async () => {
  let account = 'a', access = 'token-a'
  const seen: { headers: Headers; body: Record<string, unknown> }[] = []
  const transport = new CodexResponsesTransport({ sessionStateLimit: 8,
    endpoint: 'https://chatgpt.com/backend-api/codex/responses', originator: 'autoflow', userAgent: 'fixture', clientVersion: 'fixture',
    accounts: { withAccount: async <T>(_request: AccountRequest, run: (lease: AccountLease) => Promise<T>) => run({ accountKey: account, accountId: account, accessToken: access, headers: {}, signal: _request.signal! }) },
    fetch: async (_input, init) => {
      seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return new Response('data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': `state-${account}` } })
    },
  })
  const body = { model: 'fixture', input: [], prompt_cache_key: 'same-external-session', client_metadata: { 'x-codex-turn-state': 'injected' } }
  const signal = new AbortController().signal
  const context = { keyId: 'one', headers: new Headers({ 'x-codex-turn-state': 'state-a', 'x-codex-turn-metadata': '{"source":"fixture"}', 'authorization': 'Bearer malicious', 'chatgpt-account-id': 'malicious', 'x-openai-codex-luna-reserve': 'true' }) }
  try {
    await (await transport.request(body, signal, context)).text()
    await (await transport.request(body, signal, context)).text()
    account = 'b'; access = 'token-b'; await (await transport.request({ ...body, input: [{ type: 'reasoning', encrypted_content: 'account-a-secret', summary: [] }, { role: 'user', content: 'ordinary history' }] }, signal,
      { ...context, replayAccountKey: 'a' })).text()
    await (await transport.request(body, signal, { ...context, keyId: 'two' })).text()
    assert.equal(seen[0]?.headers.get('x-codex-turn-state'), null)
    assert.equal(seen[1]?.headers.get('x-codex-turn-state'), 'state-a')
    assert.equal(seen[2]?.headers.get('x-codex-turn-state'), null)
    assert.equal(seen[3]?.headers.get('x-codex-turn-state'), null)
    assert.notEqual(seen[0]?.body.prompt_cache_key, seen[3]?.body.prompt_cache_key)
    assert.equal(seen[0]?.headers.get('authorization'), 'Bearer token-a')
    assert.equal(seen[0]?.headers.get('chatgpt-account-id'), 'a')
    assert.equal(seen[0]?.headers.get('x-codex-turn-metadata'), '{"source":"fixture"}')
    assert.equal(seen[0]?.headers.get('x-openai-codex-luna-reserve'), null)
    assert.deepEqual(seen[0]?.body.client_metadata, {})
    assert.deepEqual(seen[2]?.body.input, [{ role: 'user', content: 'ordinary history' }])
  } finally { await transport.dispose() }
})
