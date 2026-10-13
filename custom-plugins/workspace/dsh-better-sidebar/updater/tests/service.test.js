import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { SidebarUpdater } from '../src/host/service.js'

test('preserves profile preferences before npm installation and does not install again before restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidebar-update-'))
  const bytes = Buffer.from('verified package fixture')
  const calls = []
  let version = '0.25.0'
  const service = new SidebarUpdater({
    profileContext: { dir: directory, runtimeVersion: '0.2.0-rc.2' },
    preservePreferences: async () => { calls.push('preferences') },
    pluginManager: {
      managedUpdateStatus: () => undefined,
      listBundles: async () => [{ name: 'dsh-better-sidebar', version }],
      installManagedUpdate: async (_manager, _name, next, file) => {
        calls.push('install')
        assert.deepEqual(await readFile(file), bytes)
        version = next
        return { application: 'restart-required' }
      },
    },
  }, { timeoutMs: 1000, jsonBytes: 65536, archiveBytes: 1048576, pollIntervalMs: 1000 })
  t.after(async () => {
    await service.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  })
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/releases/latest')) return Response.json({
      tag_name: 'v0.26.0', draft: false, prerelease: false,
      html_url: 'https://github.com/omdsh-dev/DSH-better-sidebar/releases/tag/v0.26.0',
    })
    if (url.endsWith('/0.26.0')) return Response.json({
      name: 'dsh-better-sidebar', version: '0.26.0', repository: { type: 'git', url: 'https://github.com/omdsh-dev/DSH-better-sidebar' },
      dist: { tarball: 'https://registry.npmjs.org/dsh-better-sidebar/-/dsh-better-sidebar-0.26.0.tgz',
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
    })
    assert.equal(url, 'https://registry.npmjs.org/dsh-better-sidebar/-/dsh-better-sidebar-0.26.0.tgz')
    return new Response(bytes)
  })
  assert.equal((await service.run('check')).status, 'available')
  assert.deepEqual(calls, [])
  assert.deepEqual(await service.run('install'), {
    status: 'restart-required', currentVersion: '0.25.0', installedVersion: '0.26.0', latestVersion: '0.26.0',
    releaseUrl: 'https://github.com/omdsh-dev/DSH-better-sidebar/releases/tag/v0.26.0',
    restartRequired: true, pollIntervalMs: 1000, errorCode: undefined,
  })
  await service.run('install')
  assert.deepEqual(calls, ['preferences', 'install'])
})

test('retains the active version and restart requirement when the updater is reactivated', async t => {
  const service = new SidebarUpdater({ pluginManager: {
    listBundles: async () => [{ name: 'dsh-better-sidebar', version: '0.26.0' }],
    managedUpdateStatus: () => ({ currentVersion: '0.25.0', installedVersion: '0.26.0', restartRequired: true }),
  } }, { pollIntervalMs: 1000 })
  t.after(() => service.dispose())
  t.mock.method(globalThis, 'fetch', () => { throw new Error('A pending restart must not check or download again') })
  assert.deepEqual(await service.run('install'), {
    status: 'restart-required', currentVersion: '0.25.0', installedVersion: '0.26.0', latestVersion: undefined,
    restartRequired: true, pollIntervalMs: 1000,
  })
})

test('does not download or install when configuration preservation fails', async t => {
  const service = new SidebarUpdater({
    profileContext: { runtimeVersion: '0.2.0-rc.2' },
    preservePreferences: async () => { throw new Error('Sidebar configuration is unavailable') },
    pluginManager: {
      managedUpdateStatus: () => undefined,
      listBundles: async () => [{ name: 'dsh-better-sidebar', version: '0.25.0' }],
      installManagedUpdate: async () => assert.fail('installation must not start'),
    },
  }, { timeoutMs: 1000, jsonBytes: 65536, pollIntervalMs: 1000 })
  t.after(() => service.dispose())
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v0.26.0', draft: false, prerelease: false, html_url: 'https://github.com/omdsh-dev/DSH-better-sidebar/releases/tag/v0.26.0' })
    if (url.endsWith('/0.26.0')) return Response.json({ name: 'dsh-better-sidebar', version: '0.26.0', repository: { type: 'git', url: 'https://github.com/omdsh-dev/DSH-better-sidebar' }, dist: { tarball: 'https://registry.npmjs.org/dsh-better-sidebar/-/dsh-better-sidebar-0.26.0.tgz', integrity: 'sha512-' + createHash('sha512').update('fixture').digest('base64') } })
    assert.fail('archive download must not start')
  })
  const result = await service.run('install')
  assert.equal(result.status, 'error')
  assert.equal(result.restartRequired, false)
})
