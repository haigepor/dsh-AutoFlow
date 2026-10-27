/** Shared package-owned regressions for the independent plugin release adapters. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { releaseMetadata, verifyPackedEntries } from './prepare-plugin-release.mjs'

/** Register release checks against one real manifest and its owned configuration.
 * @param {URL} root Owning plugin directory.
 * @param {string} expectedPackage Independent package identity.
 * @returns {void} Registers keyless release protocol tests.
 */
export function testReleaseAdapter(root, expectedPackage) {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const config = JSON.parse(readFileSync(new URL('release.config.json', root), 'utf8'))
  const asset = { tag: `${config.tagPrefix}${manifest.version}`, sourceCommit: 'a'.repeat(40), sha256: 'b'.repeat(64), size: 1024, sourceDirty: false }
  test(`${expectedPackage} release owns its tag, metadata asset and updater declaration`, () => {
    const metadata = releaseMetadata(manifest, config, asset, expectedPackage)
    assert.equal(metadata.package, expectedPackage)
    assert.equal(metadata.asset.name, `${expectedPackage}-${manifest.version}.tgz`)
    assert.equal(metadata.asset.url, `https://github.com/${config.repository}/releases/download/${asset.tag}/${metadata.asset.name}`)
    assert.equal(metadata.sourceDirty, false)
    assert.equal(releaseMetadata(manifest, config, { ...asset, sourceDirty: true }, expectedPackage).sourceDirty, true)
  })
  test(`${expectedPackage} refuses another package, tag or pre-release version`, () => {
    assert.throws(() => releaseMetadata({ ...manifest, name: 'another-plugin' }, config, asset, expectedPackage), /Unexpected package/)
    assert.throws(() => releaseMetadata(manifest, config, { ...asset, tag: 'afp-v0.1.0' }, expectedPackage), /Tag and package version/)
    assert.throws(() => releaseMetadata({ ...manifest, version: '0.1.0-beta.1' }, config, asset, expectedPackage), /stable package version/)
  })
  test(`${expectedPackage} refuses a mismatched update source or application latest flag`, () => {
    assert.throws(() => releaseMetadata(manifest, { ...config, repository: 'another/project' }, asset, expectedPackage), /update source/)
    assert.throws(() => releaseMetadata(manifest, { ...config, metadataAsset: 'another-update.json' }, asset, expectedPackage), /update source/)
    assert.throws(() => releaseMetadata(manifest, { ...config, makeLatest: true }, asset, expectedPackage), /application latest/)
  })
  test(`${expectedPackage} refuses invalid commit, digest or byte count`, () => {
    assert.throws(() => releaseMetadata(manifest, config, { ...asset, sourceCommit: 'HEAD' }, expectedPackage), /commit/)
    assert.throws(() => releaseMetadata(manifest, config, { ...asset, sha256: 'invalid' }, expectedPackage), /digest/)
    assert.throws(() => releaseMetadata(manifest, config, { ...asset, size: 0 }, expectedPackage), /size/)
  })
  test(`${expectedPackage} archive checks reject private files and escaping paths`, () => {
    for (const path of ['package/../escape', 'package\\escape']) assert.throws(() => verifyPackedEntries(manifest, [path]), /Unsafe archive/)
    for (const path of ['package/.env', 'package/tests/account.test.ts', 'package/node_modules/dependency/index.js']) assert.throws(() => verifyPackedEntries(manifest, [path]), /Unwanted archive/)
    assert.throws(() => verifyPackedEntries(manifest, ['package/package.json']), /Missing packed file/)
  })
  test(`${expectedPackage} accepts every declared runtime entry without inventing a Client`, () => {
    const leaves = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(leaves)
    const bundle = manifest.dsh.bundle
    const paths = ['package.json', 'README.md', 'README.zh.md', 'THIRD_PARTY_NOTICES.md', 'release/README.md', 'release/README.zh.md', 'release.config.json',
      manifest.icon, ...[bundle.patch].flat(), ...leaves(manifest.exports), ...bundle.featureConfig === undefined ? [] : [bundle.featureConfig],
      ...(bundle.features ?? []).flatMap(feature => feature.icon === undefined ? [] : [feature.icon])]
    const entries = paths.map(path => `package/${path.replace(/^\.\//, '').replace('*', 'en')}`)
    verifyPackedEntries(manifest, entries)
    for (const path of leaves(manifest.exports).filter(path => !path.includes('*'))) {
      assert.throws(() => verifyPackedEntries(manifest, entries.filter(entry => entry !== `package/${path.replace(/^\.\//, '')}`)), /Missing packed file/)
    }
  })
}
