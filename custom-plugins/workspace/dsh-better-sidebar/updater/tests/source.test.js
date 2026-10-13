import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverRelease, verifyArchiveIntegrity } from '../src/host/source.js'
import { createHash } from 'node:crypto'

const config = { timeoutMs: 1000, jsonBytes: 65536, archiveBytes: 1048576 }
const signal = new AbortController().signal
const release = { tag_name: 'v0.26.0', draft: false, prerelease: false, html_url: 'https://github.com/omdsh-dev/DSH-better-sidebar/releases/tag/v0.26.0' }
const metadata = { name: 'dsh-better-sidebar', version: '0.26.0', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.2.0-rc.2' },
  repository: { type: 'git', url: 'https://github.com/omdsh-dev/DSH-better-sidebar' },
  dist: { tarball: 'https://registry.npmjs.org/dsh-better-sidebar/-/dsh-better-sidebar-0.26.0.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64') } }

test('checks GitHub and resolves the exact npm version without installing', async () => {
  const urls = []
  const fetcher = async url => { urls.push(url); return Response.json(url.includes('api.github.com') ? release : metadata) }
  assert.equal((await discoverRelease('0.25.0', '0.2.0-rc.2', config, signal, fetcher)).status, 'available')
  assert.deepEqual(urls, ['https://api.github.com/repos/omdsh-dev/DSH-better-sidebar/releases/latest', 'https://registry.npmjs.org/dsh-better-sidebar/0.26.0'])
})

test('does not fetch npm for an installed or older release', async () => {
  let calls = 0
  assert.equal((await discoverRelease('0.26.0', '0.2.0-rc.2', config, signal, async () => { calls++; return Response.json(release) })).status, 'current')
  assert.equal(calls, 1)
})

test('reports a release awaiting its npm publication', async () => {
  assert.equal((await discoverRelease('0.25.0', '0.2.0-rc.2', config, signal, async url => url.includes('api.github.com') ? Response.json(release) : new Response('', { status: 404 }))).status, 'package-pending')
})

test('rejects substituted download hosts and incompatible DSH peers', async () => {
  await assert.rejects(discoverRelease('0.25.0', '0.2.0-rc.2', config, signal, async url => Response.json(url.includes('api.github.com') ? release : { ...metadata, dist: { ...metadata.dist, tarball: 'https://example.org/x.tgz' } })), /package-source/)
  const result = await discoverRelease('0.25.0', '0.2.0-rc.2', config, signal, async url => Response.json(url.includes('api.github.com') ? release : { ...metadata, peerDependencies: { '@deepseek-ai/dsh-agent': '^0.3.0' } }))
  assert.equal(result.status, 'incompatible')
})

test('verifies complete npm SHA-512 bytes', () => {
  const bytes = Buffer.from('npm package')
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  verifyArchiveIntegrity(bytes, integrity)
  assert.throws(() => verifyArchiveIntegrity(Buffer.from('changed'), integrity), /integrity/)
})
