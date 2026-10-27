import { expect, it } from 'vitest'
import { draftOf, rawConfig, validateConfig } from '../src/host/configuration.ts'

it('redacts credentials and preserves untouched raw expressions and secret values', () => {
  const original = { serverName: 'demo', transport: 'stdio', command: 'node', args: ['server.mjs'], cwd: { __jsExpr: 'process.cwd()' }, env: { TOKEN: 'private', FROM_ENV: { __jsExpr: 'process.env.TOKEN' } } }
  const resolved = validateConfig({ ...original, cwd: 'D:/workspace', env: { TOKEN: 'private', FROM_ENV: 'resolved-private' } })
  const draft = draftOf(resolved)
  expect(draft.env).toEqual({ TOKEN: null, FROM_ENV: null })
  const edited = rawConfig({ ...draft, args: ['next.mjs'] }, original, resolved)
  expect(edited.cwd).toEqual(original.cwd)
  expect(edited.env).toEqual(original.env)
  expect(edited.args).toEqual(['next.mjs'])
  expect(JSON.stringify(draft)).not.toContain('private')
  const later = { ...resolved, cwd: 'D:/changed-context' }
  expect(rawConfig({ ...draft, args: ['changed.mjs'], editedFields: ['args'] }, original, later).cwd).toEqual(original.cwd)
})

it('rejects invalid endpoints, empty commands, invalid timeouts, and missing retained secrets', () => {
  expect(() => validateConfig({ transport: 'streamable-http', serverName: 'web', url: 'file:///tmp/mcp' })).toThrow()
  expect(() => validateConfig({ transport: 'stdio', serverName: 'local', command: '  ' })).toThrow()
  expect(() => validateConfig({ transport: 'stdio', serverName: 'local', command: 'node', toolCallTimeoutMs: -1 })).toThrow()
  const draft = draftOf(validateConfig({ transport: 'stdio', serverName: 'local', command: 'node' }))
  expect(() => rawConfig({ ...draft, env: { TOKEN: null } })).toThrow()
})

it.each(['https://demo:fixture-secret@example.invalid/mcp', 'https://demo@example.invalid/mcp', 'https://:fixture-secret@example.invalid/mcp'])('rejects embedded HTTP credentials without echoing them: %s', (url) => {
  expect(() => validateConfig({ transport: 'streamable-http', serverName: 'web', url })).toThrow('invalid-config')
})

it('keeps HTTP authorization in redacted headers rather than the endpoint', () => {
  const config = validateConfig({ transport: 'streamable-http', serverName: 'web', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer fixture-secret' } })
  const draft = draftOf(config)
  expect(draft.headers).toEqual({ Authorization: null })
  expect(JSON.stringify(draft)).not.toContain('fixture-secret')
})
