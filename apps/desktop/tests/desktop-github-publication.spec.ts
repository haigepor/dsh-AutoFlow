import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDesktopGithubPublication, type DesktopGithubPublication } from '../scripts/desktop-github-publication.ts'
import { publishDesktopGithub } from '../scripts/publish-github.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
const version = '0.2.0-rc.2.20261010.1'
const environment = { DSH_DESKTOP_UPDATE_PROVIDER: 'github', DSH_DESKTOP_GITHUB_REPOSITORY: 'owner/repository',
  DSH_DESKTOP_GITHUB_PAGES_URL: 'https://owner.github.io/repository/desktop/unsigned/', DSH_DESKTOP_UNSIGNED_UPDATES: '1' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-github-'))
  directories.push(root)
  const name = `deepseek-harness-${version}-win-x64-unsigned.exe`
  const bytes = Buffer.from('test installer payload')
  const metadata = { version, files: [{ url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }], path: name }
  await writeFile(join(root, name), bytes)
  await writeFile(join(root, `${name}.blockmap`), 'blockmap')
  await writeFile(join(root, 'nightly.yml'), dump(metadata))
  const record = { schemaVersion: 1, provider: 'github', repository: 'owner/repository', target: 'win-x64', version,
    pagesUrl: environment.DSH_DESKTOP_GITHUB_PAGES_URL, publicUrl: `${environment.DSH_DESKTOP_GITHUB_PAGES_URL}feeds/win-x64/`,
    signing: 'unsigned', commit: 'a'.repeat(40), dirty: false }
  await writeFile(join(root, 'win-x64-release.json'), JSON.stringify(record))
  const options = { environment, artifactsRoot: root, productVersion: '0.2.0-rc.2' }
  return { root, name, record, metadata, options, plan: await prepareDesktopGithubPublication('win-x64', options) }
}

it('builds a platform feed with explicit desktop Release URLs and retains the preceding minimum', async () => {
  const { options, plan } = await fixture()
  expect(plan.tag).toBe(`desktop-v${version}-unsigned`)
  expect(load(plan.feed)).toMatchObject({ version, files: [{ url: `https://github.com/owner/repository/releases/download/${plan.tag}/${plan.assets[0]!.name}` }] })
  const previous = { ...plan.policy, targets: { ...plan.policy.targets,
    'win-x64': { ...plan.policy.targets['win-x64'], latestVersion: '0.2.0-rc.2', minimumSupportedVersion: '0.2.0-rc.1' } } }
  const next = await prepareDesktopGithubPublication('win-x64', { ...options, previousPolicy: previous })
  expect(next.policy.targets['win-x64']?.minimumSupportedVersion).toBe('0.2.0-rc.1')
  await expect(prepareDesktopGithubPublication('win-x64', { ...options, previousPolicy: previous,
    minimumSupportedVersion: '0.2.0-rc.0' })).rejects.toThrow('lower the minimum')
  await expect(prepareDesktopGithubPublication('win-x64', { ...options, minimumSupportedVersion: '1.0.0' })).rejects.toThrow('exceeds latest')
})

it('rejects altered payloads, signing mismatches and foreign asset filenames before publication', async () => {
  const { root, name, metadata, record, options } = await fixture()
  await writeFile(join(root, name), 'tampered')
  await expect(prepareDesktopGithubPublication('win-x64', options)).rejects.toThrow('SHA-512')
  await writeFile(join(root, 'win-x64-release.json'), JSON.stringify({ ...record, signing: 'signed' }))
  await expect(prepareDesktopGithubPublication('win-x64', options)).rejects.toThrow('completion record')
  await writeFile(join(root, 'win-x64-release.json'), JSON.stringify(record))
  await writeFile(join(root, 'nightly.yml'), dump({ ...metadata, files: [{ ...metadata.files[0], url: '../foreign.exe' }] }))
  await expect(prepareDesktopGithubPublication('win-x64', options)).rejects.toThrow('filename')
})

function network(plan: DesktopGithubPublication) {
  const calls: string[] = []
  const request = vi.fn(async (path: string, method = 'GET', _body?: unknown): Promise<unknown> => {
    calls.push(`${method} ${path}`)
    if (path === '/repos/owner/repository') return { private: false }
    if (method === 'GET' && (path.includes('/git/refs/') || path.endsWith('/pages') || path.includes('/releases/tags/'))) return undefined
    if (path.includes('uploads.github.com')) {
      const asset = plan.assets.find(asset => asset.name === new URL(path).searchParams.get('name'))!
      return { size: asset.size, digest: `sha256:${asset.sha256}` }
    }
    if (path.endsWith('/releases') || path.endsWith('/releases/1')) return { id: 1, assets: [], draft: method !== 'PATCH', html_url: 'https://github.com/owner/repository/releases/tag/desktop-v1' }
    return { sha: 'b'.repeat(40) }
  })
  const publicRequest = vi.fn<typeof fetch>(async (url) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    calls.push(`HEAD ${href}`)
    const asset = plan.assets.find(asset => href.endsWith(asset.name))!
    return new Response(null, { headers: { 'content-length': String(asset.size) } })
  })
  return { calls, request, publicRequest }
}

it('publishes and verifies attachments before advancing the policy branch', async () => {
  const { plan } = await fixture()
  const { calls, request, publicRequest } = network(plan)
  await expect(publishDesktopGithub(plan, undefined, request, publicRequest)).resolves.toMatchObject({ policy: `${plan.pagesUrl}policy.json` })
  const firstPolicyWrite = calls.findIndex(call => call.includes('/git/blobs'))
  const lastAvailabilityCheck = calls.findLastIndex(call => call.startsWith('HEAD '))
  expect(firstPolicyWrite).toBeGreaterThan(lastAvailabilityCheck)
  const body = request.mock.calls.find(call => call[0].endsWith('/git/trees'))?.[2]
  const entries = typeof body === 'object' && body !== null && 'tree' in body && Array.isArray(body.tree) ? body.tree : []
  const paths = entries.map((item: unknown) => typeof item === 'object' && item !== null && 'path' in item ? item.path : undefined)
  expect(paths).toContain('desktop/unsigned/policy.json')
  expect(calls.some(call => call.includes('/releases/latest'))).toBe(false)
})

it('never writes Pages content when downloads are unavailable or the checkout is dirty', async () => {
  const { plan } = await fixture()
  const { calls, request, publicRequest } = network(plan)
  publicRequest.mockResolvedValue(new Response(null, { status: 404 }))
  await expect(publishDesktopGithub(plan, undefined, request, publicRequest)).rejects.toThrow('publicly downloadable')
  expect(calls.some(call => call.includes('/git/blobs'))).toBe(false)
  request.mockClear()
  await expect(publishDesktopGithub({ ...plan, dirty: true }, undefined, request)).rejects.toThrow('clean')
  expect(request).not.toHaveBeenCalled()
})

it('refuses to replace an existing documentation Pages site or a concurrently advanced branch', async () => {
  const { plan } = await fixture()
  const docs = network(plan)
  docs.request.mockImplementation(async path => path.endsWith('/pages') ? { source: { branch: 'gh-pages', path: '/' } } : { private: false })
  await expect(publishDesktopGithub(plan, undefined, docs.request)).rejects.toThrow('existing Pages site')
  const moved = network(plan)
  moved.request.mockImplementation(async path => path.endsWith('/pages') ? undefined : path.includes('/git/refs/') ? { object: { sha: 'c'.repeat(40) } } : { private: false })
  await expect(publishDesktopGithub(plan, undefined, moved.request)).rejects.toThrow('branch moved')
})
