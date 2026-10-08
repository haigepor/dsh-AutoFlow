/** Deterministic public GitHub metadata and in-memory npm archives for update tests. */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Header } from 'tar'
import { onTestFinished, vi } from 'vitest'
import type { BundleUpdateRelease, UpdateLimits } from '../src/github-updates.ts'
import type { DshBundleUpdateSource } from '@deepseek-ai/dsh-package-manifest'

/** Small bounded responses for deterministic update fixtures. */
export const limits: UpdateLimits = { timeoutMs: 1000, jsonBytes: 65536, archiveBytes: 1048576, expandedBytes: 2097152, releasePages: 2 }
/** One plugin family sharing its repository with desktop releases. */
export const source: DshBundleUpdateSource = { provider: 'github', repository: 'example/plugins', tagPrefix: 'extra-v', metadataAsset: 'extra-update.json' }

/** Build archive entries without acquiring symlinks or platform-specific file permissions.
 * @param entries Paths and bodies, optionally a non-regular tar type.
 * @returns Gzipped npm archive.
 */
export function archive(entries: Array<{ path: string; body?: string; type?: 'SymbolicLink' | 'File' }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = new Header({ path: entry.path, size: body.length, type: entry.type ?? 'File', mode: 0o644, linkpath: entry.type === 'SymbolicLink' ? '/outside' : '' })
    const bytes = Buffer.alloc(512)
    header.encode(bytes)
    chunks.push(bytes, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

/** Intercept only this fixture's exact public API and release URLs.
 * @param files Installed package content by npm archive path.
 * @returns Verified-release facts and the observed fetch mock.
 */
export function githubFixture(files?: Array<{ path: string; body?: string; type?: 'SymbolicLink' | 'File' }>) {
  const bytes = archive(files ?? [
    { path: 'package/package.json', body: JSON.stringify({ name: 'extra', version: '1.1.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml', update: source } } }) },
    { path: 'package/cordis.patch.yml', body: '[{"insert":[{"id":"managed","name":"./plugin.mjs"}]}]' },
    { path: 'package/plugin.mjs', body: 'export function apply(ctx) { ctx.provide("managedProbe", "updated") }\n' },
  ])
  const hash = createHash('sha256').update(bytes).digest('hex')
  const url = `https://github.com/${source.repository}/releases/download/extra-v1.1.0/extra-1.1.0.tgz`
  const release: BundleUpdateRelease = { releaseUrl: `https://github.com/${source.repository}/releases/tag/extra-v1.1.0`, metadata: {
    schemaVersion: 1, package: 'extra', version: '1.1.0', repository: source.repository, channel: 'stable', tag: 'extra-v1.1.0',
    sourceCommit: 'a'.repeat(40), sourceDirty: false, asset: { name: 'extra-1.1.0.tgz', url, sha256: hash, size: bytes.length },
  } }
  const metadata = Buffer.from(JSON.stringify(release.metadata))
  const metadataUrl = `https://github.com/${source.repository}/releases/download/extra-v1.1.0/extra-update.json`
  const releaseRow = { tag_name: 'extra-v1.1.0', draft: false, prerelease: false, html_url: release.releaseUrl, assets: [
    { name: 'extra-update.json', browser_download_url: metadataUrl, size: metadata.length, digest: `sha256:${createHash('sha256').update(metadata).digest('hex')}` },
    { name: release.metadata.asset.name, browser_download_url: url, size: bytes.length, digest: `sha256:${hash}` },
  ] }
  const original = globalThis.fetch
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = input instanceof Request ? input.url : String(input)
    if (target === `https://api.github.com/repos/${source.repository}/releases?per_page=100&page=1`) return Response.json([
      { ...releaseRow, tag_name: 'desktop-v99.0.0', assets: [] },
      { ...releaseRow, tag_name: 'extra-v99.0.0', prerelease: true }, releaseRow,
    ])
    if (target === `https://api.github.com/repos/${source.repository}/git/ref/tags/extra-v1.1.0`) return Response.json({ object: { type: 'commit', sha: release.metadata.sourceCommit } })
    if (target === metadataUrl) return new Response(new Uint8Array(metadata))
    if (target === url) return new Response(new Uint8Array(bytes))
    return original(input, init)
  })
  onTestFinished(() => { fetchMock.mockRestore() })
  return { bytes, release, fetchMock, releaseRow, metadataUrl }
}
