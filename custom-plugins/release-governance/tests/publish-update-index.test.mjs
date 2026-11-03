/** Real attachment digests and concurrent Git data publication without live remote writes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { collectPublishedPlugins, mergeUpdateIndex, publishUpdateIndex, verifyPublishedPlugin } from '../publish-update-index.mjs'

const repository = 'example/plugins'
const indexPath = 'plugins/stable/index.json'
const time = '2026-11-03T10:00:00Z'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function entry(name = 'alpha', version = '1.1.0', bytes = Buffer.from('public archive bytes')) {
  return { schemaVersion: 1, package: name, version, repository, channel: 'stable', tag: `${name}-v${version}`,
    sourceCommit: 'a'.repeat(40), sourceDirty: false,
    asset: { name: `${name}-${version}.tgz`, url: `https://github.com/${repository}/releases/download/${name}-v${version}/${name}-${version}.tgz`,
      sha256: hash(bytes), size: bytes.length } }
}

function published(name = 'alpha', version = '1.1.0') {
  const archive = Buffer.from('public archive bytes')
  const metadata = entry(name, version, archive)
  const bytes = Buffer.from(JSON.stringify(metadata))
  const metadataName = `${name}-update.json`
  const metadataUrl = `https://github.com/${repository}/releases/download/${metadata.tag}/${metadataName}`
  const source = { name, tagPrefix: `${name}-v`, metadataAsset: metadataName }
  const release = { draft: false, prerelease: false, tag_name: metadata.tag,
    html_url: `https://github.com/${repository}/releases/tag/${metadata.tag}`,
    assets: [{ name: metadataName, browser_download_url: metadataUrl, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}` },
      { name: metadata.asset.name, browser_download_url: metadata.asset.url, size: archive.length, state: 'uploaded', digest: `sha256:${hash(archive)}` }] }
  const request = async (url, init) => {
    assert.equal(init.credentials, 'omit')
    assert.equal(new Headers(init.headers).has('authorization'), false)
    assert.equal(new Headers(init.headers).has('cookie'), false)
    if (String(url) === metadataUrl) return new Response(bytes)
    assert.equal(String(url), metadata.asset.url)
    return new Response(archive)
  }
  const api = async path => {
    assert.equal(path, `/repos/${repository}/git/ref/tags/${metadata.tag}`)
    return { object: { type: 'commit', sha: metadata.sourceCommit } }
  }
  return { source, metadata, release, request, api, archive, metadataUrl }
}

function gitFixture(previous) {
  let sequence = 0
  const id = () => (++sequence).toString(16).padStart(40, '0')
  const trees = new Map(), commits = new Map(), blobs = new Map()
  const initialTree = id(), initialCommit = id()
  const policy = '{"minimumSupportedVersion":"0.0.0","latestVersion":"desktop-version"}\n'
  trees.set(initialTree, { 'desktop/unsigned/policy.json': policy, 'desktop/unsigned/feeds/win-x64/nightly.yml': 'original feed\n',
    ...(previous === undefined ? {} : { [indexPath]: JSON.stringify(previous) }) })
  commits.set(initialCommit, { tree: { sha: initialTree }, parents: [] })
  const state = { head: initialCommit, conflicts: 0, patches: 0, calls: [], branch: 'desktop-updates', beforePatch: undefined }
  const files = () => trees.get(commits.get(state.head).tree.sha)
  const api = async (path, method = 'GET', body) => {
    state.calls.push({ path, method })
    const prefix = `/repos/${repository}`
    if (path === prefix) return { private: false }
    if (path === `${prefix}/pages`) return { source: { branch: state.branch, path: '/' } }
    if (path === `${prefix}/pages/builds`) { assert.equal(method, 'POST'); return {} }
    if (path === `${prefix}/git/refs/heads/desktop-updates`) {
      if (method === 'GET') return { object: { sha: state.head } }
      assert.equal(method, 'PATCH'); assert.equal(body.force, false); state.patches++
      if (state.beforePatch !== undefined) { const effect = state.beforePatch; state.beforePatch = undefined; effect() }
      if (state.conflicts-- > 0 || commits.get(body.sha).parents[0] !== state.head) throw Object.assign(new Error('Concurrent head'), { status: 422 })
      state.head = body.sha; return {}
    }
    if (path.startsWith(`${prefix}/contents/`)) {
      const head = path.slice(path.indexOf('?ref=') + 5)
      const value = trees.get(commits.get(head).tree.sha)[indexPath]
      return value === undefined ? undefined : { encoding: 'base64', content: Buffer.from(value).toString('base64') }
    }
    if (path === `${prefix}/git/blobs`) { const sha = id(); blobs.set(sha, body.content); return { sha } }
    if (path === `${prefix}/git/trees`) {
      assert.equal(body.tree.length, 1); assert.equal(body.tree[0].path, indexPath)
      const sha = id(), tree = { ...trees.get(body.base_tree) }
      for (const item of body.tree) tree[item.path] = blobs.get(item.sha)
      trees.set(sha, tree); return { sha }
    }
    if (path === `${prefix}/git/commits`) { const sha = id(); commits.set(sha, { tree: { sha: body.tree }, parents: body.parents }); return { sha } }
    if (path.startsWith(`${prefix}/git/commits/`)) return commits.get(path.slice(path.lastIndexOf('/') + 1))
    throw new Error(`Unexpected request ${method} ${path}`)
  }
  const change = patch => {
    const tree = id(), commit = id()
    trees.set(tree, { ...files(), ...patch }); commits.set(commit, { tree: { sha: tree }, parents: [state.head] }); state.head = commit
  }
  return { state, api, files, change, policy }
}

test('verifies the complete public archive and tag commit before offering its metadata', async () => {
  const f = published()
  assert.deepEqual(await verifyPublishedPlugin(repository, f.source, f.release, f.api, f.request), f.metadata)
})

for (const part of ['draft', 'metadata-digest', 'archive-digest', 'tag-source', 'archive-bytes']) {
  test(`refuses ${part} without changing the existing Pages index`, async () => {
    const f = published()
    const release = structuredClone(f.release)
    let api = f.api, request = f.request
    if (part === 'draft') release.draft = true
    if (part === 'metadata-digest') release.assets[0].digest = `sha256:${'f'.repeat(64)}`
    if (part === 'archive-digest') release.assets[1].digest = `sha256:${'f'.repeat(64)}`
    if (part === 'tag-source') api = async () => ({ object: { type: 'commit', sha: 'b'.repeat(40) } })
    if (part === 'archive-bytes') request = (url, init) => String(url) === f.metadata.asset.url ? Promise.resolve(new Response(Buffer.alloc(f.archive.length))) : f.request(url, init)
    const git = gitFixture()
    await assert.rejects(async () => {
      const verified = await verifyPublishedPlugin(repository, f.source, release, api, request)
      await publishUpdateIndex({ repository, entries: [verified] }, git.api)
    })
    assert.equal(git.state.calls.length, 0)
    assert.equal(git.files()[indexPath], undefined)
    assert.equal(git.files()['desktop/unsigned/policy.json'], git.policy)
  })
}

test('selects stable releases within each declared family and ignores desktop or prerelease tags', async () => {
  const older = published('alpha', '1.0.0'), newest = published('alpha', '1.1.0')
  const api = path => path.includes('/releases?') ? Promise.resolve([
    older.release, { ...newest.release, tag_name: 'desktop-v99.0.0' },
    { ...newest.release, tag_name: 'alpha-v99.0.0', prerelease: true }, newest.release,
  ]) : newest.api(path)
  assert.deepEqual(await collectPublishedPlugins(repository, [newest.source], api, newest.request), [newest.metadata])
})

test('retains other families, refuses changed immutable identities and never downgrades a version', () => {
  const previous = mergeUpdateIndex(undefined, [entry('alpha', '1.2.0'), entry('beta')], repository, time)
  const merged = mergeUpdateIndex(previous, [entry('alpha', '1.1.0')], repository, '2026-11-03T11:00:00Z')
  assert.deepEqual(merged, previous)
  assert.throws(() => mergeUpdateIndex(previous, [{ ...entry('alpha', '1.2.0'), sourceCommit: 'b'.repeat(40) }], repository, time), /immutable/)
})

test('concurrent plugin publications merge both families and preserve desktop feed and policy bytes', async () => {
  const f = gitFixture()
  await Promise.all([
    publishUpdateIndex({ repository, entries: [entry('alpha')], generatedAt: time }, f.api),
    publishUpdateIndex({ repository, entries: [entry('beta')], generatedAt: time }, f.api),
  ])
  const index = JSON.parse(f.files()[indexPath])
  assert.deepEqual(index.plugins.map(item => item.package), ['alpha', 'beta'])
  assert.equal(f.files()['desktop/unsigned/policy.json'], f.policy)
  assert.equal(f.files()['desktop/unsigned/feeds/win-x64/nightly.yml'], 'original feed\n')
  assert(f.state.patches >= 3)
})

test('rereads a concurrent desktop policy update before advancing the index', async () => {
  const f = gitFixture()
  f.state.beforePatch = () => f.change({ 'desktop/unsigned/policy.json': 'new desktop policy\n' })
  await publishUpdateIndex({ repository, entries: [entry()], generatedAt: time }, f.api)
  assert.equal(f.files()['desktop/unsigned/policy.json'], 'new desktop policy\n')
  assert.equal(JSON.parse(f.files()[indexPath]).plugins[0].version, '1.1.0')
  assert.equal(f.state.patches, 2)
})

test('bounds repeated concurrent failures and refuses an unrelated Pages site', async () => {
  const f = gitFixture()
  f.state.conflicts = 10
  await assert.rejects(publishUpdateIndex({ repository, entries: [entry()], attempts: 3 }, f.api), /Concurrent/)
  assert.equal(f.state.patches, 3)
  assert.equal(f.files()[indexPath], undefined)
  const other = gitFixture(); other.state.branch = 'documentation'
  await assert.rejects(publishUpdateIndex({ repository, entries: [entry()] }, other.api), /another Pages/)
  assert(other.state.calls.every(call => call.method === 'GET'))
})
