/** Local versions remain updateable; stable publication follows immutable tags and public index evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { gt, valid } from 'semver'
import { localVersion } from '../local-package.mjs'
import { publishStablePlugin, runPluginWorkflow, verifyStableAssets } from '../plugin-workflow.mjs'

const manifest = JSON.parse(await readFile(new URL('../../workspace/dsh-plugin-visual-curator/package.json', import.meta.url), 'utf8'))
const config = JSON.parse(await readFile(new URL('../../workspace/dsh-plugin-visual-curator/release.config.json', import.meta.url), 'utf8'))
const sourceCommit = 'a'.repeat(40), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const tag = `${config.tagPrefix}${manifest.version}`, root = `/repos/${config.repository}`
const metadata = { schemaVersion: 1, package: manifest.name, version: manifest.version, repository: config.repository, channel: 'stable',
  tag, sourceCommit, sourceDirty: false, asset: { name: `${manifest.name}-${manifest.version}.tgz`,
    url: `https://github.com/${config.repository}/releases/download/${tag}/${manifest.name}-${manifest.version}.tgz`, size: 42, sha256: 'b'.repeat(64) } }
const json = Buffer.from(JSON.stringify(metadata)), sums = Buffer.from(`${metadata.asset.sha256}  ${metadata.asset.name}\n`)
const release = { tag_name: tag, html_url: `https://github.com/${config.repository}/releases/tag/${tag}`, draft: false, prerelease: false,
  assets: [[metadata.asset.name, 42, metadata.asset.sha256], [config.metadataAsset, json.length, hash(json)], ['SHA256SUMS', sums.length, hash(sums)]].map(([name, size, sha256]) => ({
    name, size, state: 'uploaded', digest: `sha256:${sha256}`, browser_download_url: `https://github.com/${config.repository}/releases/download/${tag}/${name}`,
  })) }

function fixture({ wrongTag = false, missingRun = false, failedRun = false, draft = false } = {}) {
  const calls = [], reads = []
  const run = { id: 12, head_branch: tag, head_sha: sourceCommit, status: 'completed', conclusion: failedRun ? 'failure' : 'success', run_attempt: 1, html_url: `https://github.com/${config.repository}/actions/runs/12` }
  let reference = !missingRun, published = !missingRun && !failedRun, dispatched = false
  const api = async (method, path, body) => {
    calls.push({ method, path, body })
    if (method === 'POST' && path.endsWith('/git/refs')) { reference = true; return }
    if (path.includes('/git/ref/tags/')) return reference ? { object: { type: 'commit', sha: wrongTag ? 'c'.repeat(40) : sourceCommit } } : undefined
    if (path.includes('/releases/tags/')) return published ? { ...release, draft: draft && !dispatched } : undefined
    if (path.endsWith('/dispatches')) { dispatched = true; published = true; return }
    if (path.includes('/runs?')) return { workflow_runs: missingRun && !dispatched ? [] : [run] }
    if (path.endsWith('/rerun-failed-jobs')) { run.run_attempt++; published = true; run.conclusion = 'success'; return }
    if (path.endsWith('/runs/12')) return structuredClone(run)
    if (path === root) return { default_branch: 'main' }
    assert.fail(`Unexpected request ${method} ${path}`)
  }
  const readPublic = async url => { reads.push(url); return url.includes('github.io') ? Buffer.from(JSON.stringify({ schemaVersion: 1, repository: config.repository, plugins: [metadata] })) : json }
  return { api, calls, reads, dependencies: { readPublic, report: () => {}, wait: async () => {} } }
}

test('same-base local versions pass the updater parser and offer the current or newer stable release', () => {
  const version = localVersion('0.2.13', new Date('2026-11-05T09:00:01.123Z'))
  assert.equal(version, '0.2.13-local.20261105090001.123')
  assert.equal(valid(version), version)
  assert.ok(gt('0.2.13', version)); assert.ok(gt('0.2.14', version)); assert.ok(!gt('0.2.12', version))
  assert.ok(gt(localVersion('0.2.13', new Date('2026-11-05T09:00:01.124Z')), version))
  assert.throws(() => localVersion('0.2.14-beta.1'), /stable source base/)
})

test('formal asset checks reject corrupt, incomplete, dirty, prerelease and wrong-source evidence', () => {
  assert.deepEqual(verifyStableAssets(manifest, config, sourceCommit, release, json), metadata)
  for (const mutation of [row => { row.assets.pop() }, row => { row.assets[0].digest = `sha256:${'0'.repeat(64)}` }, row => { row.prerelease = true }]) {
    const changed = structuredClone(release); mutation(changed)
    assert.throws(() => verifyStableAssets(manifest, config, sourceCommit, changed, json))
  }
  assert.throws(() => verifyStableAssets(manifest, config, 'c'.repeat(40), release, json))
  assert.throws(() => verifyStableAssets(manifest, config, sourceCommit, release, Buffer.from(JSON.stringify({ ...metadata, sourceDirty: true }))))
})

test('rerunning an already published and indexed exact release makes no remote writes', async () => {
  const f = fixture()
  const result = await publishStablePlugin({ manifest, config, sourceCommit }, f.api, f.dependencies)
  assert.equal(result.version, manifest.version)
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0)
  assert.ok(f.reads.some(url => url.includes('github.io')))
})

test('a missing tag starts the owning workflow and waits for both public assets and official index', async () => {
  const f = fixture({ missingRun: true })
  const result = await publishStablePlugin({ manifest, config, sourceCommit }, f.api, f.dependencies)
  assert.equal(result.sourceCommit, sourceCommit)
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body]), [
    [`${root}/git/refs`, { ref: `refs/tags/${tag}`, sha: sourceCommit }],
    [`${root}/actions/workflows/release-custom-plugins.yml/dispatches`, { ref: tag, inputs: { tag } }],
  ])
})

test('a conflicting tag or failed native run stops before publication or index repair', async () => {
  for (const flags of [{ wrongTag: true }, { failedRun: true }]) {
    const f = fixture(flags)
    await assert.rejects(publishStablePlugin({ manifest, config, sourceCommit }, f.api, f.dependencies))
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
    assert.equal(f.reads.length, 0)
  }
})

test('explicit retry preserves tags and only reruns failed jobs and the trusted index workflow', async () => {
  const f = fixture({ failedRun: true })
  await publishStablePlugin({ manifest, config, sourceCommit, retry: true }, f.api, f.dependencies)
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.path), [
    `${root}/actions/runs/12/rerun-failed-jobs`, `${root}/actions/workflows/plugin-update-index.yml/dispatches`,
  ])
})

test('a missing official entry is polled and mismatched bytes prevent a completed release result', async () => {
  const f = fixture()
  let polls = 0
  const readPublic = async url => {
    if (!url.includes('github.io')) return json
    polls++
    return Buffer.from(JSON.stringify({ schemaVersion: 1, repository: config.repository, plugins: polls === 1 ? [] : [{ ...metadata, asset: { ...metadata.asset, sha256: 'c'.repeat(64) } }] }))
  }
  await assert.rejects(publishStablePlugin({ manifest, config, sourceCommit }, f.api, { ...f.dependencies, readPublic }), /官方索引/)
  assert.equal(polls, 2)
})

test('formal CLI rejects dirty authorization and local-only output flags before any network access', async () => {
  await assert.rejects(runPluginWorkflow([manifest.name, '--allow-dirty']), /仅用于本地/)
  await assert.rejects(runPluginWorkflow([manifest.name, '--out', '.artifacts/test']), /仅用于 :local/)
})
