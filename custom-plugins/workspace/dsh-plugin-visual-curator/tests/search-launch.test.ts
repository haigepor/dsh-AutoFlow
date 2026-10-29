import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, stat, mkdir, rename, symlink, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { serviceFixture } from './helpers/service-fixture.ts'
import { searchLaunchViewSchema } from '../src/shared/search-launch.ts'
import type { NativeSearchSessions } from '../src/host/native-search-session.ts'
import { deliverSearchResults, originalSearchResult } from '../src/host/search-results.ts'
import { AssetFiles } from '../src/media/index.ts'
import { dataOf } from '../src/host/runtime.ts'
import { SearchLaunches } from '../src/host/search-launch.ts'
import { RunEngine } from '../src/host/runtime.ts'
import { modelProfileSchema } from '../src/shared/model.ts'
import { ModelProfiles } from '../src/domain/model-profile.ts'
import { readFileSync } from 'node:fs'

class NativeFixture implements NativeSearchSessions {
  path = ''; created: string[] = []; messages: { sessionId: string; requestId: string; text: string; bytes: Uint8Array }[] = []; cancelled: string[] = []
  fail: 'create-ack' | 'attach' | 'prompt-ack' | 'cancel' | undefined
  readonly sessions = new SessionStore(new Context())
  workspaces() { return [{ id: 'workspace', title: 'Photos', path: this.path }] }
  async preflight() { return this.workspaces()[0]! }
  async ensure(_target: unknown, id: string) {
    if (!this.created.includes(id)) { this.created.push(id); this.sessions.create(brandString<import('@deepseek-ai/dsh-session').SessionId>(id), { meta: { cwd: this.path } }) }
    if (this.fail === 'create-ack') { this.fail = undefined; throw new Error('Lost creation acknowledgement') }
  }
  async accepted(id: string, requestId: string) { return this.messages.some(item => item.sessionId === id && item.requestId === requestId) }
  async name() {}
  async submit(sessionId: string, requestId: string, text: string, _name: string, bytes: Uint8Array) {
    if (this.fail === 'attach') { this.fail = undefined; throw new Error('Attachment unavailable') }
    if (!await this.accepted(sessionId, requestId)) this.messages.push({ sessionId, requestId, text, bytes })
    if (this.fail === 'prompt-ack') { this.fail = undefined; throw new Error('Lost prompt acknowledgement') }
  }
  async cancel(id: string) { if (this.fail === 'cancel') { this.fail = undefined; throw new Error('Cancel was not acknowledged') } this.cancelled.push(id) }
}

async function setup() {
  const native = new NativeFixture(), f = await serviceFixture(undefined, {}, { nativeSessions: native })
  native.path = f.root
  f.host.sessions.get = id => native.sessions.get(id)
  await f.service.initialize()
  const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'Green photos' }))
  await f.action('reference-import', { operationId: 'reference', styleId, expectedRevision: 1, files: [{ name: 'ref.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  await f.action('reference-analyze', { operationId: 'analysis', styleId, buildDataset: true }); await f.jobs.drain()
  const profile = f.repository.list('modelProfile')[0]!
  assert.ok(profile)
  const input = { operationId: randomUUID(), workspaceId: 'workspace', modelProfileId: profile.id, taskBrief: 'Find muted green landscapes.', targetCount: 1, output: { kind: 'original' } }
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const values = z.array(searchLaunchViewSchema).parse(await f.action('search-launch-list'))
      if (values.length && values.every(item => item.status !== 'working')) return values[0]!
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Launch did not settle')
  }
  return { f, native, profile, styleId, input, settled }
}

test('zero qualified results expose a pending receipt without claiming or creating an output directory', async () => {
  const { f, input, settled } = await setup()
  try {
    await f.action('search-launch-start', input)
    const launch = await settled(), actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const original = f.http.request.bind(f.http)
    f.http.request = async (url, request) => url.startsWith('https://source.example.test')
      ? { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ items: [{ id: 'no-original', previewUrl: 'https://images.example.test/preview' }], nextCursor: null })) }
      : original(url, request)
    const checked = z.object({ normalizedInput: z.record(z.string(), z.json()), preparationDigest: z.string() }).parse(await f.service.action({ operation: 'task-prepare', args: { kind: 'search', releaseId: input.modelProfileId, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'original' } } }, actor, new AbortController().signal))
    const run = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...checked.normalizedInput, operationId: 'empty-search', preparationDigest: checked.preparationDigest } }, actor, new AbortController().signal))
    await f.jobs.drain()
    const report = z.object({ delivery: z.object({ status: z.literal('pending'), directory: z.string().optional(), files: z.literal(0) }), resultSummary: z.object({ selected: z.literal(0), unavailable: z.literal(1) }) }).parse(await f.service.action({ operation: 'run-get', args: { runId: run.runId } }, actor, new AbortController().signal))
    assert.equal(report.delivery.directory, undefined)
    await assert.rejects(stat(join(f.root, '.visual-curator', input.operationId)), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('owner launch creates one native Session, attaches exact package and submits a recoverable frozen search', async () => {
  const { f, native, input, profile, settled } = await setup()
  try {
    const [a, b] = await Promise.all([f.action('search-launch-start', input), f.action('search-launch-start', input)])
    assert.equal(searchLaunchViewSchema.parse(a).sessionId, searchLaunchViewSchema.parse(b).sessionId)
    const launch = await settled()
    assert.equal(launch.status, 'accepted'); assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
    const message = native.messages[0]!, dataset = f.domain.require('profileExport', launch.datasetId!)
    assert.deepEqual(JSON.parse(Buffer.from(message.bytes).toString('utf8')), { formatVersion: 2, export: dataset.id, files: dataset.files, resources: [] })
    assert.ok(message.text.includes(profile.id)); assert.ok(message.text.includes('visual_search_start')); assert.ok(message.text.includes('不需要安装'))
    assert.ok(message.text.includes('零张合格结果时不会创建目录'))
    assert.ok(message.text.includes('delivery'))
    await assert.rejects(f.action('search-launch-start', { ...input, targetCount: 2 }), /different/)
    const actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const checked = z.object({ status: z.literal('ready'), normalizedInput: z.record(z.string(), z.unknown()), preparationDigest: z.string() }).parse(await f.service.action({ operation: 'task-prepare', args: { kind: 'search', releaseId: profile.id, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'original' } } }, actor, new AbortController().signal))
    const run = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...z.record(z.string(), z.json()).parse(checked.normalizedInput), operationId: 'agent-search', preparationDigest: checked.preparationDigest } }, actor, new AbortController().signal))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', run.runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', run.runId)).error))
    const selection = f.repository.list('selection').find(item => item.runId === run.runId)!
    assert.ok(selection); assert.equal(f.repository.list('cropCandidate').length, 0)
    const directory = join(f.root, '.visual-curator', input.operationId)
    assert.deepEqual(await readFile(join(directory, `${selection.id}.png`)), f.http.image)
    const grant = z.object({ sessionToken: z.string() }).parse(await f.action('session-open', { sessionId: launch.sessionId }))
    const response = await f.service.resource(new Request(`http://localhost/api/visual-curator/resource?selectionId=${selection.id}&sessionId=${launch.sessionId}&sessionToken=${grant.sessionToken}`))
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.http.image)
    assert.equal((await f.service.resource(new Request(`http://localhost/api/visual-curator/resource?selectionId=${selection.id}`))).status, 403)
    assert.equal(f.domain.authorizedImage(selection.imageVersionId, actor).asset.exportPermission, 'references-only')
    const files = new AssetFiles(join(f.root, 'visual-curator'), { maxFileBytes: 1000000, maxPixels: 80000000, maxDimension: 20000, previewMaxDimension: 1280, maxStorageBytes: 4294967296 })
    await assert.rejects(originalSearchResult(f.domain, files, selection.id, { ...actor, sessionId: 'foreign' }), /Only this launch/)
    await writeFile(join(directory, `${selection.id}.png`), 'unrelated', 'utf8')
    const identity = await stat(f.root)
    const delivery = { domain: f.domain, files, launchId: input.operationId, sessionId: launch.sessionId, workspace: { id: 'workspace', path: f.root, device: String(identity.dev), inode: String(identity.ino) }, runId: run.runId, original: true }
    await mkdir(join(f.root, 'alternate-output'))
    await rename(join(f.root, '.visual-curator'), join(f.root, '.saved-output'))
    await symlink(join(f.root, 'alternate-output'), join(f.root, '.visual-curator'), 'junction')
    await assert.rejects(deliverSearchResults(delivery), /redirected/)
    assert.deepEqual(await readdir(join(f.root, 'alternate-output')), [])
    await unlink(join(f.root, '.visual-curator')); await rename(join(f.root, '.saved-output'), join(f.root, '.visual-curator'))
    await assert.rejects(deliverSearchResults({ domain: f.domain, files, launchId: input.operationId, sessionId: launch.sessionId, workspace: { id: 'workspace', path: f.root, device: String(identity.dev), inode: String(identity.ino) }, runId: run.runId, original: true }), /not been overwritten/)
    assert.equal(await readFile(join(directory, `${selection.id}.png`), 'utf8'), 'unrelated')
    const final = z.array(searchLaunchViewSchema).parse(await f.action('search-launch-list'))[0]!
    assert.deepEqual(final.runIds, [run.runId]); assert.equal(final.qualified, 1)
    const expected = { status: final.status, createdSessions: native.created.length, submittedMessages: native.messages.length, attachedFormat: 2, output: final.input.output.kind, linkedRuns: final.runIds.length, qualified: final.qualified, cropCandidates: f.repository.list('cropCandidate').length, foreignRead: 'denied', existingFile: 'preserved' }
    assert.deepEqual(expected, JSON.parse(readFileSync(new URL('./fixtures/search-launch.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

for (const failure of ['create-ack', 'attach', 'prompt-ack'] as const) test(`retry after ${failure} preserves Session, dataset and prompt identity`, async () => {
  const { f, native, input, settled } = await setup()
  try {
    native.fail = failure
    await f.action('search-launch-start', input)
    const failed = await settled(); assert.equal(failed.status, 'failed')
    await f.action('search-launch-start', input)
    const recovered = await settled()
    assert.equal(recovered.status, 'accepted'); assert.equal(recovered.sessionId, failed.sessionId); assert.equal(recovered.datasetId, failed.datasetId)
    assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
    await f.action('search-launch-stop', { id: input.operationId }); assert.deepEqual(native.cancelled, [failed.sessionId])
  } finally { await f.cleanup() }
})

test('stale and private profiles fail before native conversation creation', async () => {
  const { f, native, profile, input, styleId } = await setup()
  try {
    const privateProfile = modelProfileSchema.parse({ ...profile, id: 'private-profile', access: { kind: 'session-run', sessionId: 'another-session' } })
    await f.repository.commit({ aggregateId: 'private-profile', expectedRevision: 0, operationId: 'private-profile', request: {}, records: [privateProfile], state: {} })
    await assert.rejects(f.action('search-launch-start', { ...input, modelProfileId: privateProfile.id }), /another Session/)
    assert.equal(native.created.length, 0)
    await f.action('reference-import', { operationId: 'new-reference', styleId, expectedRevision: f.domain.require('draft', profile.draftId).revision, files: [{ name: 'new.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await assert.rejects(f.action('search-launch-start', input), /analyze the current collection/)
    assert.equal(native.created.length, 0)
    await assert.rejects(f.service.action({ operation: 'search-launch-start', args: input }, { kind: 'agent', id: 'foreign', sessionId: 'foreign', profileId: f.profileId }, new AbortController().signal), /authenticated workbench owner/)
  } finally { await f.cleanup() }
})

test('restart restages an unlogged accepted prompt with its original identity and never creates another Session', async () => {
  const { f, native, input, settled } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled(), original = native.messages[0]!
    native.messages.length = 0
    const recovered = new SearchLaunches({ domain: f.domain, files: new AssetFiles(join(f.root, 'visual-curator'), { maxFileBytes: 1000000, maxPixels: 80000000, maxDimension: 20000, previewMaxDimension: 1280, maxStorageBytes: 4294967296 }), engine: new RunEngine(f.repository, f.jobs), signal: new AbortController().signal, native: () => native, freeze: async () => { throw new Error('A durable launch must not resolve current defaults again') } })
    recovered.recover(); await recovered.drain()
    assert.equal(recovered.list()[0]?.status, 'accepted'); assert.equal(native.created.length, 1)
    assert.equal(native.messages[0]?.requestId, original.requestId); assert.deepEqual(native.messages[0]?.bytes, original.bytes)
    assert.equal(recovered.list()[0]?.sessionId, launch.sessionId)
  } finally { await f.cleanup() }
})

test('an unknown stop acknowledgement remains recoverable and cannot admit new search work', async () => {
  const { f, native, input, settled, profile } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled()
    native.fail = 'cancel'
    const failed = searchLaunchViewSchema.parse(await f.action('search-launch-stop', { id: input.operationId }))
    assert.equal(failed.status, 'failed'); assert.equal(failed.stopping, true)
    await assert.rejects(f.service.action({ operation: 'search-start', args: { releaseId: profile.id, taskBrief: input.taskBrief, operationId: 'late-start', output: { kind: 'original' }, sourceId: 'images' } }, { kind: 'agent', id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }, new AbortController().signal), /stopped/)
    const stopped = searchLaunchViewSchema.parse(await f.action('search-launch-start', input))
    assert.equal(stopped.status, 'stopped'); assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
  } finally { await f.cleanup() }
})

test('an accepted search exports its exact profile after reference changes while a new launch stays blocked', async () => {
  const { f, input, profile, styleId, settled } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled()
    await f.action('reference-import', { operationId: 'later-reference', styleId, expectedRevision: f.domain.require('draft', profile.draftId).revision, files: [{ name: 'later.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const profiles = new ModelProfiles(f.domain), actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    await assert.rejects(f.action('search-launch-start', { ...input, operationId: randomUUID() }), /analyze the current collection/)
    const dataset = await profiles.export(profile, 'accepted-later-package', actor, { acceptedLaunchId: input.operationId })
    assert.equal(dataset.modelProfileId, profile.id); assert.equal(dataset.resources.length, profile.references.length)
    await assert.rejects(profiles.export(profile, 'unrelated-package', { ...actor, sessionId: 'foreign' }, { acceptedLaunchId: input.operationId }), /not authorized/)
  } finally { await f.cleanup() }
})

test('stop cancels the native Session and its active search without cancelling another Session’s Run', async () => {
  const { f, native, input, profile, settled } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled()
    let notify!: () => void
    const reached = new Promise<void>(done => { notify = done }), originalRequest = f.http.request.bind(f.http)
    f.http.request = async (url, request) => {
      if (request.headers?.accept === 'image/jpeg,image/png,image/webp') { const signal = request.signal; assert.ok(signal); return await new Promise((_done, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); notify() }) }
      return originalRequest(url, request)
    }
    const args = { releaseId: profile.id, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'original' }, sourceId: 'images' }, actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const own = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...args, operationId: 'own-running' } }, actor, new AbortController().signal))
    await reached
    await native.ensure({}, 'unrelated-session')
    const other = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...args, operationId: 'other-running' } }, { ...actor, id: 'unrelated-session', sessionId: 'unrelated-session' }, new AbortController().signal))
    const stopped = searchLaunchViewSchema.parse(await f.action('search-launch-stop', { id: input.operationId }))
    assert.equal(stopped.status, 'stopped'); assert.ok(['cancelling', 'cancelled'].includes(f.domain.require('run', own.runId).status))
    assert.equal(f.domain.require('run', other.runId).status, 'running'); assert.deepEqual(native.cancelled, [launch.sessionId])
  } finally { await f.cleanup() }
})
