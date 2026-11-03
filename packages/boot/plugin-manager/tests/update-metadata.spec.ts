/** Public metadata sharing, persisted cooldowns and strict index identities. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { cacheBundleUpdate, discoverBundleUpdate } from '../src/github-updates.ts'
import { UpdateMetadata, officialUpdateIndexUrl, type UpdateMetadataConfig } from '../src/update-metadata.ts'
import { githubFixture, limits, source } from './update-fixture.ts'

const indexUrl = 'https://example.github.io/plugins/plugins/stable/index.json'
const api = 'https://api.github.com/repos/example/plugins/releases?per_page=100&page=1'

function fixture(indexes: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-metadata-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const config: UpdateMetadataConfig = { indexes, cacheMs: 900000, cacheEntries: 64, failureBackoffMs: 1000,
    timeoutMs: 1000, jsonBytes: limits.jsonBytes }
  const file = join(root, 'metadata.json')
  const create = () => new UpdateMetadata(file, config, new AbortController().signal)
  return { root, create, reader: create() }
}

it('shares one Pages request across five release families and all fresh repeated checks', async () => {
  const f = fixture({ [source.repository]: indexUrl })
  const g = githubFixture()
  let now = 1800000000000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const families = ['extra', 'second', 'third', 'fourth', 'fifth']
  const plugins = families.map(name => ({ ...g.release.metadata, package: name, tag: `${name}-v1.1.0`,
    asset: { ...g.release.metadata.asset, name: `${name}-1.1.0.tgz`,
      url: `https://github.com/example/plugins/releases/download/${name}-v1.1.0/${name}-1.1.0.tgz` } }))
  g.fetchMock.mockImplementation(async (input) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe(indexUrl)
    return Response.json({ schemaVersion: 1, repository: source.repository, generatedAt: '2026-11-03T10:00:00Z', plugins })
  })
  const checks = () => Promise.all(families.map(name => discoverBundleUpdate(name, '1.0.0',
    { ...source, tagPrefix: `${name}-v` }, limits, new AbortController().signal, f.reader)))
  expect((await checks()).map(item => item?.metadata.package)).toEqual(families)
  expect((await checks()).map(item => item?.metadata.version)).toEqual(['1.1.0', '1.1.0', '1.1.0', '1.1.0', '1.1.0'])
  expect(g.fetchMock).toHaveBeenCalledOnce()
  now += 900001
  await checks()
  expect(g.fetchMock).toHaveBeenCalledTimes(2)
  const restarted = f.create()
  expect(restarted.previous(source.repository, 'fifth')).toEqual({ checkedAt: now, version: '1.1.0' })
})

it('shares a REST list across simultaneous callers without account headers', async () => {
  const f = fixture()
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect(init?.credentials).toBe('omit')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(new Headers(init?.headers).has('cookie')).toBe(false)
    return Response.json([])
  })
  const values = await Promise.all(Array.from({ length: 5 }, () => f.reader.read(api)))
  expect(values.every(item => item.bytes.toString('utf8') === '[]')).toBe(true)
  expect(request).toHaveBeenCalledOnce()
})

it('persists API cooldowns, stops already queued requests and resumes one shared check after reset', async () => {
  const f = fixture()
  let now = 1800000000000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const reset = now + 60000
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ message: 'API rate limit exceeded' }, {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset / 1000) },
  })).mockImplementation(async () => Response.json([]))
  const results = await Promise.allSettled([f.reader.read(api), f.reader.read('https://api.github.com/repos/other/repository/releases')])
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
  await expect(f.reader.read(api)).rejects.toMatchObject({ kind: 'rate-limited', retryAt: reset })
  const restarted = f.create()
  await expect(restarted.read(api)).rejects.toMatchObject({ kind: 'rate-limited', retryAt: reset })
  expect(request).toHaveBeenCalledOnce()
  now = reset + 1
  await Promise.all([restarted.read(api), restarted.read(api), restarted.read(api)])
  expect(request).toHaveBeenCalledTimes(2)
})

it.each(['120', 'Tue, 03 Nov 2026 10:02:00 GMT'])('honors Retry-After %s without misclassifying ordinary access refusal', async (retryAfter) => {
  const f = fixture()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T10:00:00Z'))
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ message: 'wait' }, {
    status: 429, headers: { 'retry-after': retryAfter },
  }))
  await expect(f.reader.read(api)).rejects.toMatchObject({ kind: 'rate-limited', retryAt: Date.parse('2026-11-03T10:02:00Z') })
  const separate = fixture()
  request.mockResolvedValueOnce(Response.json({ message: 'Resource not accessible' }, { status: 403 }))
  await expect(separate.reader.read(api)).rejects.toMatchObject({ kind: 'forbidden' })
})

it('retains the previous successful version across an index outage and process restart without REST fallback', async () => {
  const f = fixture({ [source.repository]: indexUrl })
  const g = githubFixture()
  let now = 1800000000000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  g.fetchMock.mockResolvedValueOnce(Response.json({ schemaVersion: 1, repository: source.repository,
    generatedAt: '2026-11-03T10:00:00Z', plugins: [g.release.metadata] }))
  await discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal, f.reader)
  const previous = f.reader.previous(source.repository, 'extra')
  now += 900001
  g.fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
  await expect(discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal, f.reader)).rejects.toMatchObject({ kind: 'network' })
  await expect(f.reader.read(indexUrl)).rejects.toMatchObject({ kind: 'network' })
  expect(f.create().previous(source.repository, 'extra')).toEqual(previous)
  expect(g.fetchMock).toHaveBeenCalledTimes(2)
  expect(g.fetchMock.mock.calls.every(([url]) => (url instanceof Request ? url.url : url.toString()) === indexUrl)).toBe(true)
})

it.each(['package', 'repository', 'tag', 'size', 'sha256', 'url', 'duplicate'] as const)('rejects an index with mismatched %s before offering an archive', async (field) => {
  const f = fixture({ [source.repository]: indexUrl })
  const g = githubFixture()
  const entry = { ...g.release.metadata, asset: { ...g.release.metadata.asset } }
  if (field === 'package') entry.package = 'different'
  if (field === 'repository') entry.repository = 'other/repository'
  if (field === 'tag') entry.tag = 'another-v1.1.0'
  if (field === 'size') entry.asset.size = limits.archiveBytes + 1
  if (field === 'sha256') entry.asset.sha256 = 'invalid'
  if (field === 'url') entry.asset.url = 'https://mirror.example/archive.tgz'
  g.fetchMock.mockResolvedValueOnce(Response.json({ schemaVersion: 1, repository: source.repository,
    generatedAt: '2026-11-03T10:00:00Z', plugins: field === 'duplicate' ? [entry, entry] : [entry] }))
  await expect(discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal, f.reader)).rejects.toMatchObject({ kind: 'invalid-metadata' })
  expect(f.reader.previous(source.repository, 'extra')).toBeUndefined()
  expect(g.fetchMock).toHaveBeenCalledOnce()
})

it('rejects a complete archive whose bytes differ from the index SHA256', async () => {
  const f = fixture({ [source.repository]: indexUrl })
  const g = githubFixture()
  g.fetchMock.mockResolvedValueOnce(Response.json({ schemaVersion: 1, repository: source.repository,
    generatedAt: '2026-11-03T10:00:00Z', plugins: [{ ...g.release.metadata, asset: { ...g.release.metadata.asset, sha256: 'f'.repeat(64) } }] }))
  const release = await discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal, f.reader)
  expect(release).toBeDefined()
  await expect(cacheBundleUpdate(f.root, release!, limits, new AbortController().signal)).rejects.toThrow(/SHA-?256|hash/i)
})

it('rejects unrelated index origins and cross-origin redirects without requesting their destination', async () => {
  expect(() => officialUpdateIndexUrl(source.repository, 'https://attacker.github.io/plugins/index.json')).toThrow('project Pages')
  const f = fixture({ [source.repository]: indexUrl })
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://mirror.example/index.json' } }))
  await expect(f.reader.read(indexUrl)).rejects.toThrow('official Pages origin')
  expect(request).toHaveBeenCalledOnce()
})

it('enforces a saved cooldown in a separate Node process before any HTTP request', async () => {
  const f = fixture()
  const reset = Math.ceil(Date.now() / 1000) * 1000 + 60000
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({}, { status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset / 1000) } }))
  await expect(f.reader.read(api)).rejects.toMatchObject({ kind: 'rate-limited' })
  const script = `import { UpdateMetadata } from ${JSON.stringify(new URL('../src/update-metadata.ts', import.meta.url).href)};
    let requested = false;
    const reader = new UpdateMetadata(process.argv[1], { indexes: {}, cacheMs: 900000, cacheEntries: 64,
      failureBackoffMs: 1000, timeoutMs: 1000, jsonBytes: 65536 }, new AbortController().signal,
      async () => { requested = true; throw new Error('Unexpected HTTP request'); });
    try { await reader.read(${JSON.stringify(api)}); process.exitCode = 1; }
    catch (error) { process.stdout.write(JSON.stringify({ kind: error.kind, requested, retryAt: error.retryAt })); }`
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|systemroot|windir|comspec|pathext|temp|tmp)$/iu.test(name)))
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script, join(f.root, 'metadata.json')], {
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)), encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...environment, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)) },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ kind: 'rate-limited', requested: false, retryAt: reset })
})

it('evicts invalid index data and permits a corrected document after bounded backoff', async () => {
  const f = fixture({ [source.repository]: indexUrl })
  const g = githubFixture()
  let now = 1800000000000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  g.fetchMock.mockResolvedValueOnce(Response.json({ schemaVersion: 1, repository: 'wrong/repository',
    generatedAt: '2026-11-03T10:00:00Z', plugins: [g.release.metadata] }))
  await expect(discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal, f.reader)).rejects.toMatchObject({ kind: 'invalid-metadata' })
  await expect(f.reader.read(indexUrl)).rejects.toMatchObject({ kind: 'invalid-metadata' })
  expect(g.fetchMock).toHaveBeenCalledOnce()
  now += 1001
  g.fetchMock.mockResolvedValueOnce(Response.json({ schemaVersion: 1, repository: source.repository,
    generatedAt: '2026-11-03T10:00:00Z', plugins: [g.release.metadata] }))
  expect(await discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal, f.reader)).toEqual(g.release)
  expect(g.fetchMock).toHaveBeenCalledTimes(2)
})
