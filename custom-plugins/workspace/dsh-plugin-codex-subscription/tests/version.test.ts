/** Version negotiation reads metadata only and never needs a Codex subprocess or auth.json. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { CodexVersion, newerCodexVersion } from '../src/host/version.ts'

test('client hints can raise a configured version but never lower it or accept unrelated user agents', async () => {
  const version = new CodexVersion({ minimum: '0.159.0', discoverLocal: false, probeIntervalMs: 1000, maxCacheBytes: 4096 })
  try {
    assert.equal(await version.current(), '0.159.0')
    assert.equal(version.observeClient(new Headers({ version: '9.0.0', 'user-agent': 'unrelated' })), false)
    assert.equal(version.observeClient(new Headers({ 'user-agent': 'codex_cli_rs/0.164.0-alpha.3 (Windows)' })), true)
    assert.equal(await version.current(), '0.164.0')
    version.observeClient(new Headers({ originator: 'codex_cli_rs', version: '0.160.0' }))
    assert.equal(await version.current(), '0.164.0')
    assert.equal(newerCodexVersion('0.159.0', 'invalid'), '0.159.0')
  } finally { await version.dispose() }
})

test('installed package and models cache participate in a bounded cached probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-version-'))
  let now = 0
  const cachePath = join(dir, 'models_cache.json'), packagePath = join(dir, 'package.json')
  const version = new CodexVersion({ minimum: '0.159.0', discoverLocal: true, probeIntervalMs: 1000, maxCacheBytes: 4096, cachePath, packagePaths: [packagePath], now: () => now })
  try {
    await writeFile(cachePath, JSON.stringify({ client_version: '0.165.0', models: [] }), 'utf8')
    await writeFile(packagePath, JSON.stringify({ name: '@openai/codex', version: '0.170.0', bin: 'never-execute.js' }), 'utf8')
    assert.deepEqual(await Promise.all([version.current(), version.current()]), ['0.170.0', '0.170.0'])
    await writeFile(packagePath, JSON.stringify({ name: '@openai/codex', version: '0.180.0' }), 'utf8')
    assert.equal(await version.current(), '0.170.0')
    now = 1001
    assert.equal(await version.current(), '0.180.0')
    assert.equal(version.status().installed, '0.180.0')
    await writeFile(cachePath, 'x'.repeat(8192), 'utf8')
    now = 2002
    assert.equal(await version.current(), '0.180.0')
    await writeFile(cachePath, JSON.stringify({ client_version: '0.130.0' }), 'utf8')
    await writeFile(packagePath, JSON.stringify({ name: '@openai/codex', version: '0.140.0' }), 'utf8')
    const older = new CodexVersion({ minimum: '0.159.0', discoverLocal: true, probeIntervalMs: 1000, maxCacheBytes: 4096, cachePath, packagePaths: [packagePath] })
    try {
      assert.equal(await older.current(), '0.159.0')
      assert.equal(older.status().installed, '0.140.0')
      assert.equal(older.status().cached, '0.130.0')
    } finally { await older.dispose() }
  } finally { await version.dispose(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }) }
})
