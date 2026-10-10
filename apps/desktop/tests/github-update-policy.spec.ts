import { afterEach, expect, it, vi } from 'vitest'
import { DesktopMandatoryUpdatePolicy, resolveDesktopPolicyConfig } from '../src/mandatory-update-policy.ts'
import { parseDesktopStaticUpdatePolicy } from '../src/static-update-policy.ts'
import { resolveDesktopAutoUpdateConfig, resolveDesktopUploadConfig } from '../scripts/desktop-auto-update-environment.mjs'
import { resolveDesktopPolicyEnvironment } from '../scripts/desktop-policy-environment.mjs'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

const pages = 'https://owner.github.io/repository/desktop/unsigned/'
const environment = { DSH_DESKTOP_APP_ID: 'com.example.desktop', DSH_DESKTOP_UPDATE_PROVIDER: 'github',
  DSH_DESKTOP_GITHUB_REPOSITORY: 'owner/repository', DSH_DESKTOP_GITHUB_PAGES_URL: pages,
  DSH_DESKTOP_UNSIGNED_UPDATES: '1', DSH_DESKTOP_MANDATORY_UPDATE_SOURCE: 'static-json',
  DSH_DESKTOP_MANDATORY_UPDATE_URL: `${pages}policy.json` }
const manifest = { schemaVersion: 1, channel: 'nightly', targets: { 'win-x64': {
  latestVersion: '1.3.0', minimumSupportedVersion: '1.2.0',
  downloadPage: 'https://github.com/owner/repository/releases/tag/desktop-v1.3.0' } } }
const policies: DesktopMandatoryUpdatePolicy[] = []
afterEach(async () => { await Promise.all(policies.splice(0).map(policy => policy.dispose())) })

function fixture(version: string) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(manifest))
  const policy = new DesktopMandatoryUpdatePolicy(resolveDesktopPolicyConfig(resolveDesktopPolicyEnvironment(environment))!,
    { platform: 'win32', arch: 'x64', bundledDshVersion: '0.2.0' }, () => {}, request,
    () => ({ version, locale: 'zh-CN', timezoneOffsetSeconds: 28800 }))
  policies.push(policy)
  return { policy, request }
}

it.each([['1.1.9', true], ['1.2.0', false], ['1.2.8', false], ['1.4.0', false], ['1.2.0-rc.1', true]])(
  'uses the minimum threshold for installed version %s', async (version, blocking) => {
    const { policy, request } = fixture(version)
    expect((await policy.check('launch')).blocking).toBe(blocking)
    expect(request.mock.calls[0]![0]).toEqual(new URL(`${pages}policy.json`))
    expect(request.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(request.mock.calls[0]![1]?.headers).toBeUndefined()
  })

it('retains a known block on malformed, missing-target, disallowed-page, or HTTP failure responses', async () => {
  const { policy, request } = fixture('1.1.0')
  await policy.check('launch')
  for (const body of [{ ...manifest, targets: {} }, { ...manifest, targets: { 'mac-x64': manifest.targets['win-x64'] } },
    { ...manifest, targets: { 'win-x64': { ...manifest.targets['win-x64'], downloadPage: 'https://evil.example.com' } } }]) {
    request.mockResolvedValueOnce(Response.json(body))
    expect(await policy.check('manual', true)).toMatchObject({ blocking: true, error: 'unavailable' })
  }
  request.mockResolvedValueOnce(Response.json(manifest, { status: 500 }))
  expect(await policy.check('manual', true)).toMatchObject({ blocking: true, error: 'unavailable' })
  request.mockResolvedValueOnce(Response.json({ ...manifest, targets: { 'win-x64': {
    ...manifest.targets['win-x64'], minimumSupportedVersion: '1.0.0' } } }))
  expect(await policy.check('manual', true)).toEqual({ blocking: false, checking: false })
})

it.each([{ latestVersion: 'invalid' }, { minimumSupportedVersion: '2.0.0' }, { minimumSupportedVersion: '1.0.0+1' },
  { downloadPage: 'http://example.com' }, { downloadPage: 'https://user:pass@example.com' }, { title: 1 }])(
  'rejects malformed static policy fields %j', (change) => {
    expect(() => parseDesktopStaticUpdatePolicy({ ...manifest, targets: { 'win-x64': { ...manifest.targets['win-x64'], ...change } } })).toThrow()
  })

it('preserves Pages repository paths and isolates unsigned feeds', () => {
  expect(resolveDesktopAutoUpdateConfig(environment, 'win32', 'x64')).toMatchObject({
    provider: 'github', publicUrl: `${pages}feeds/win-x64/`, repository: 'owner/repository' })
  expect(() => { validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }, { unsigned: true }) }).not.toThrow()
  expect(() => { validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }) }).toThrow('unsigned')
  expect(() => resolveDesktopAutoUpdateConfig({ ...environment, DSH_DESKTOP_GITHUB_PAGES_URL: pages.replace('/unsigned/', '/') }, 'win32', 'x64')).toThrow('isolated')
  expect(() => resolveDesktopUploadConfig(environment, 'win32', 'x64')).toThrow('publish:github')
  expect(() => resolveDesktopPolicyEnvironment({ ...environment, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{"authentication":"feishu-test"}' })).toThrow('authentication')
  expect(() => resolveDesktopPolicyConfig({ ...resolveDesktopPolicyEnvironment(environment), authentication: 'feishu-test',
    allowedAuthOrigins: ['https://login.example.com'] })).toThrow('anonymous')
})
