import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { releaseMetadata, verifyPackedEntries } from '../scripts/prepare-release.mjs'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const config = JSON.parse(readFileSync(new URL('../release.config.json', import.meta.url), 'utf8'))
const asset = { tag: 'article-image-v0.1.0', sourceCommit: '1'.repeat(40), sha256: '2'.repeat(64), size: 123, sourceDirty: false }
test('release identity uses the plugin tag family and exact bytes', () => {
  const metadata = releaseMetadata(manifest, config, asset)
  expect(metadata.asset.name).toBe('dsh-plugin-article-image-0.1.0.tgz')
  expect(metadata.sourceDirty).toBe(false)
  expect(() => releaseMetadata(manifest, config, { ...asset, tag: 'afp-v0.1.0' })).toThrow()
  expect(() => releaseMetadata({ ...manifest, name: 'dsh-plugin-afp' }, config, asset)).toThrow()
  expect(() => releaseMetadata(manifest, config, { ...asset, sha256: 'bad' })).toThrow()
})
test('packed entries reject missing modules and private state', () => {
  expect(() => verifyPackedEntries(manifest, ['package/package.json'])).toThrow()
  expect(() => verifyPackedEntries(manifest, ['package/.env'])).toThrow()
  expect(() => verifyPackedEntries(manifest, ['package/state.json'])).toThrow()
})
