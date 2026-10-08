import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { releaseMetadata, verifyPackedEntries } from '../scripts/prepare-release.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const config = JSON.parse(readFileSync(new URL('../release.config.json', import.meta.url), 'utf8'))
const asset = { tag: `${config.tagPrefix}${manifest.version}`, sourceCommit: 'a'.repeat(40), sha256: 'b'.repeat(64), size: 1024, sourceDirty: false }

test('AFP release metadata points to the exact tag asset and records rehearsal sources', () => {
  const metadata = releaseMetadata(manifest, config, asset)
  assert.equal(metadata.asset.url, `https://github.com/${config.repository}/releases/download/${asset.tag}/dsh-plugin-afp-${manifest.version}.tgz`)
  assert.equal(metadata.sourceDirty, false)
  assert.equal(releaseMetadata(manifest, config, { ...asset, sourceDirty: true }).sourceDirty, true)
})

test('AFP publication rejects another package, mismatched tags and unstable versions', () => {
  assert.throws(() => releaseMetadata({ ...manifest, name: 'another-plugin' }, config, asset), /Unexpected package/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, tag: 'autoflow-v0.1.0' }), /Tag and package version/)
  assert.throws(() => releaseMetadata({ ...manifest, version: '0.1.0-beta.1' }, config, asset), /stable package version/)
})

test('AFP publication rejects invalid repository, digest, size and source commit', () => {
  assert.throws(() => releaseMetadata(manifest, { ...config, repository: 'owner/repo/escape' }, asset), /Invalid GitHub/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, sha256: 'invalid' }), /digest/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, size: 0 }), /size/)
  assert.throws(() => releaseMetadata(manifest, config, { ...asset, sourceCommit: 'HEAD' }), /commit/)
  assert.throws(() => releaseMetadata(manifest, { ...config, makeLatest: true }, asset), /application latest/)
})

test('AFP archive validation rejects escaping paths and local environment files', () => {
  assert.throws(() => verifyPackedEntries(manifest, ['package/../escape']), /Unsafe archive/)
  assert.throws(() => verifyPackedEntries(manifest, ['package/.env']), /Unwanted archive/)
  assert.throws(() => verifyPackedEntries(manifest, ['package/node_modules/dependency/index.js']), /Unwanted archive/)
})

test('AFP archive validation rejects a missing Client entry', () => {
  assert.throws(() => verifyPackedEntries(manifest, ['package/package.json']), /Missing packed file: client.js/)
})
