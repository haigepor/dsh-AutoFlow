import { expect, it } from 'vitest'
import { configurationJson, McpJsonError, parseConfigurationJson, type McpJsonSnapshot } from '../src/client/configuration-json.ts'
import type { McpServerDraft, McpServerDetail } from '../src/types.ts'

const defaults: McpServerDraft = {
  serverName: '', transport: 'stdio', command: '', args: [], cwd: '', url: '', env: {}, headers: {}, toolCallTimeoutMs: 60000,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
}
const server: McpServerDetail = {
  id: 'demo' as McpServerDetail['id'], serverName: 'demo', enabled: true, transport: 'streamable-http', phase: 'connected',
  tools: [], readOnly: false, revision: 'original',
  config: { ...defaults, serverName: 'demo', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: null } },
}
const snapshot: McpJsonSnapshot = { defaults, servers: [server] }

it('roundtrips redacted settings without rewriting existing servers or hidden values', () => {
  const text = configurationJson(snapshot)
  expect(text).toContain('"Authorization": null')
  expect(parseConfigurationJson(text, snapshot)).toEqual([])
  expect(parseConfigurationJson('{"mcpServers":{}}', snapshot)).toEqual([])
})

it('merges edits and new common MCP declarations and retains editor-open revisions', () => {
  const changes = parseConfigurationJson(JSON.stringify({ mcpServers: {
    demo: { url: server.config.url, headers: { Authorization: null }, toolCallTimeoutMs: 12000, disabled: true },
    local: { command: 'npx', args: ['-y', 'example-server'], env: { KEY: 'replacement' }, disabled: true },
  } }), snapshot)
  expect(changes).toHaveLength(2)
  expect(changes[0]).toMatchObject({ previous: { revision: 'original' }, enabled: false,
    draft: { headers: { Authorization: null }, toolCallTimeoutMs: 12000, editedFields: ['toolCallTimeoutMs'] } })
  expect(changes[1]).toMatchObject({ enabled: false, draft: { transport: 'stdio', command: 'npx', args: ['-y', 'example-server'] } })
})

it.each([
  '{', '{"mcpServers":[]}', '{"mcpServers":{"new":{"command":3}}}',
  '{"mcpServers":{"new":{"url":"file:///secret"}}}',
  '{"mcpServers":{"new":{"url":"https://demo:fixture-secret@example.invalid/mcp"}}}',
  '{"mcpServers":{"new":{"url":"https://demo@example.invalid/mcp"}}}',
  '{"mcpServers":{"new":{"url":"https://:fixture-secret@example.invalid/mcp"}}}',
  '{"mcpServers":{"new":{"command":"node","env":{"KEY":null}}}}',
])('rejects invalid import %s before producing mutations', (source) => {
  expect(() => parseConfigurationJson(source, snapshot)).toThrow(McpJsonError)
})

it('allows unchanged read-only declarations but rejects their edits', () => {
  const locked = { ...snapshot, servers: [{ ...server, readOnly: true }] }
  expect(parseConfigurationJson(configurationJson(locked), locked)).toEqual([])
  expect(() => parseConfigurationJson('{"mcpServers":{"demo":{"url":"https://changed.test"}}}', locked)).toThrow('read-only')
})
