/** Completed-task references exercise real storage, roles and Session authorization without providers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { serviceFixture } from './helpers/service-fixture.ts'
import { taskReferencePageSchema, taskReferenceReceiptSchema } from '../src/shared/task-references.ts'
import { assetSchema, imageVersionSchema, assessmentSchema, runSchema, selectionSchema, cropCandidateSchema } from '../src/shared/model.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { remoteReferenceBlob } from '../src/media/remote-reference.ts'
import { readFile } from 'node:fs/promises'
import { galleryTaskViewSchema, galleryTaskProgress } from '../src/shared/gallery-task.ts'
import { createCuratorStore } from '../src/client/store.ts'
import { GalleryReferenceTasks } from '../src/host/gallery-tasks.ts'
import { taskReferenceImportSchema } from '../src/shared/task-references.ts'

async function fixture() {
  const f = await serviceFixture(); await f.service.initialize()
  const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'task-reference-style', name: 'Task references' }))
  const reference = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#314f77' } }).png().toBuffer()
  await f.action('reference-import', { operationId: 'task-reference-seed', styleId: style.id, expectedRevision: 1, files: [{ name: 'seed.png', mime: 'image/png', base64: reference.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  await f.action('reference-analyze', { operationId: 'task-reference-analysis', styleId: style.id, buildDataset: true }); await f.jobs.drain()
  const profile = f.repository.list('modelProfile')[0]!
  f.http.mode = 'reject-final'
  const prepared = z.object({ normalizedInput: z.record(z.string(), z.json()), preparationDigest: z.string() }).parse(await f.action('task-prepare', { kind: 'search', releaseId: profile.id, output: { kind: 'original' }, taskBrief: 'Find forest images', queries: ['forest'], targetCount: 1 }))
  const started = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'task-reference-search', ...prepared.normalizedInput, preparationDigest: prepared.preparationDigest })); await f.jobs.drain()
  const run = f.domain.require('run', started.runId)
  assert.equal(run.status, 'completed')
  const assessment = f.repository.list('assessment').find(item => item.runId === run.id && item.verdict === 'reject')!
  assert.ok(assessment)
  return { ...f, styleId: style.id, run, assessment }
}

async function backgroundInput(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  const first = f.domain.require('imageVersion', f.assessment.imageVersionId), second = imageVersionSchema.parse({ ...first, id: `${operationId}-second-image` })
  const secondRun = runSchema.parse({ ...f.run, id: `${operationId}-second-run` })
  await f.repository.commit({ aggregateId: `${operationId}-seed`, expectedRevision: 0, operationId: `${operationId}-seed`, request: {}, state: {}, records: [second, secondRun, assessmentSchema.parse({ ...f.assessment, id: `${operationId}-assessment`, imageVersionId: second.id, runId: secondRun.id })] })
  return taskReferenceImportSchema.parse({ operationId, styleId: f.styleId, expectedRevision: f.domain.require('style', f.styleId).revision, role: 'negative', images: [{ runId: f.run.id, imageVersionId: first.id }, { runId: secondRun.id, imageVersionId: second.id }] })
}

test('accepted task references outlive the request, publish each committed image and complete on the collection page', { timeout: 10000 }, async () => {
  const f = await fixture(), input = await backgroundInput(f, 'background-references'), request = new AbortController()
  const store = createCuratorStore({ invoke: (operation, args) => operation === 'task-reference-start' ? f.service.action({ operation, args }, f.actor, request.signal) : f.action(operation, args) })
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()], entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const action = f.domain.action.bind(f.domain); let rows = 0
  f.domain.action = async (...args) => { if (args[0] === 'reference-confirm') { const row = rows++; entered[row]?.resolve(); await gates[row]?.promise }; return action(...args) }
  try {
    await assert.rejects(f.action('task-reference-start', { ...input, images: [{ runId: input.images[0]!.runId, imageVersionId: input.images[1]!.imageVersionId }] }), { code: 'owner-denied' })
    assert.equal(z.object({ tasks: z.array(galleryTaskViewSchema) }).parse(await f.action('gallery-reference-tasks')).tasks.length, 0)
    await store.reload()
    const accepted = await store.startGalleryReferences(input, 'completed-search')
    assert.equal(accepted.source, 'completed-search'); assert.equal(accepted.total, 2)
    assert.ok(store.getSnapshot().galleryTasks.some(task => task.id === accepted.id))
    await entered[0]!.promise; request.abort()
    assert.ok(['queued', 'running'].includes(accepted.status))
    assert.equal((await f.action('task-reference-start', input) as { id: string }).id, accepted.id)
    await assert.rejects(f.action('task-reference-start', { ...input, role: 'positive' }), { code: 'operation-conflict' })
    await assert.rejects(f.action('style-rename', { operationId: 'rename-during-references', styleId: f.styleId, name: 'Busy' }), { code: 'constraint-conflict' })
    gates[0]!.resolve(); await entered[1]!.promise
    await store.refreshGalleryTasks()
    const running = store.getSnapshot().galleryTasks.find(task => task.id === accepted.id)!
    assert.equal(galleryTaskProgress(running).referenced, 1, 'The first reference must be visible while the second is still pending')
    gates[1]!.resolve(); await f.jobs.drain(); await store.refreshGalleryTasks()
    const completed = store.getSnapshot().galleryTasks.find(task => task.id === accepted.id)!
    assert.equal(completed.status, 'completed'); assert.equal(completed.completed, 2); assert.equal(completed.failed, 0)
    assert.deepEqual({ acceptedBeforeWritesFinished: true, requestAbortKeepsJob: true, crossTaskImages: accepted.total, publishedWhileRunning: galleryTaskProgress(running).referenced, finalStatus: completed.status, completed: completed.completed }, JSON.parse(await readFile(new URL('./fixtures/task-reference-background.expected.json', import.meta.url), 'utf8')))
  } finally { gates.forEach(gate => gate.resolve()); store.dispose(); f.domain.action = action; await f.cleanup() }
})

test('a partially failed background addition resumes only missing images and keeps its saved target role', async () => {
  const f = await fixture(), input = await backgroundInput(f, 'partial-background'), action = f.domain.action.bind(f.domain), seen: string[] = []
  let failSecond = true
  f.domain.action = async (...args) => {
    if (args[0] === 'reference-confirm') { const id = z.object({ imageVersionId: imageVersionSchema.shape.id }).parse(args[1]).imageVersionId; seen.push(id); if (failSecond && id === input.images[1]!.imageVersionId) throw Object.assign(new Error('Image temporarily unavailable'), { code: 'reference-unavailable' }) }
    return action(...args)
  }
  try {
    const accepted = galleryTaskViewSchema.parse(await f.action('task-reference-start', input)); await f.jobs.drain()
    const partial = z.object({ tasks: z.array(galleryTaskViewSchema) }).parse(await f.action('gallery-reference-tasks')).tasks[0]!
    assert.equal(partial.status, 'partial'); assert.equal(partial.completed, 1); assert.equal(partial.failed, 1)
    failSecond = false; seen.length = 0
    await f.action('gallery-reference-resume', { taskId: accepted.id }); await f.jobs.drain()
    const complete = z.object({ tasks: z.array(galleryTaskViewSchema) }).parse(await f.action('gallery-reference-tasks')).tasks[0]!
    assert.equal(complete.status, 'completed'); assert.equal(complete.completed, 2); assert.equal(complete.failed, 0)
    assert.deepEqual(seen, [input.images[1]!.imageVersionId])
    assert.equal(f.repository.list('reference').filter(reference => reference.role === 'negative').length, 2)
  } finally { f.domain.action = action; await f.cleanup() }
})

test('restart reconstructs completed-search row receipts without dispatching writes', async () => {
  const f = await fixture(), input = await backgroundInput(f, 'recover-background')
  let recovered: GalleryReferenceTasks | undefined
  try {
    const accepted = galleryTaskViewSchema.parse(await f.action('task-reference-start', input)); await f.jobs.drain()
    const manifest = f.repository.manifest(`gallery-task:${accepted.id}`)!, saved = z.record(z.string(), z.json()).parse(manifest.state)
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'before-reference-task-checkpoint', request: {}, records: [], state: toJson({ ...saved, status: 'running', completed: 0, referenceBatch: input }) })
    let dispatched = 0
    recovered = new GalleryReferenceTasks(f.service.config, f.domain, f.jobs, async () => { throw new Error('No gallery dispatch') }, () => ({ rows: [] }), async () => {}, { validate: async () => {}, import: async () => { dispatched++; throw new Error('Recovery cannot import') } })
    await recovered.initialize()
    const task = recovered.list(f.actor)[0]!
    assert.equal(task.status, 'interrupted'); assert.equal(task.completed, 2); assert.equal(dispatched, 0)
    const resumed = await recovered.resume(task.id, f.actor)
    assert.equal(resumed.status, 'completed'); assert.equal(dispatched, 0)
  } finally { await recovered?.dispose(); await f.cleanup() }
})

test('stopping a completed-search reference job retains its admitted row and ends the task', { timeout: 10000 }, async () => {
  const f = await fixture(), input = await backgroundInput(f, 'cancel-background'), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), action = f.domain.action.bind(f.domain)
  let rows = 0
  f.domain.action = async (...args) => { if (args[0] === 'reference-confirm') { rows++; entered.resolve(); await gate.promise }; return action(...args) }
  try {
    const accepted = galleryTaskViewSchema.parse(await f.action('task-reference-start', input)); await entered.promise
    await f.action('gallery-reference-stop', { taskId: accepted.id }); gate.resolve(); await f.jobs.drain()
    const stopped = z.object({ tasks: z.array(galleryTaskViewSchema) }).parse(await f.action('gallery-reference-tasks')).tasks[0]!
    assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.completed, 1); assert.equal(rows, 1)
    await assert.rejects(f.action('gallery-reference-resume', { taskId: stopped.id }), { code: 'invalid-input' })
  } finally { gate.resolve(); f.domain.action = action; await f.cleanup() }
})

test('completed-task picker includes rejected candidates, paginates and binds cursors to their collection', async () => {
  const f = await fixture()
  try {
    const image = f.domain.require('imageVersion', f.assessment.imageVersionId)
    const extra = imageVersionSchema.parse({ ...image, id: 'task-reference-extra' })
    await f.repository.commit({ aggregateId: 'task-reference-test-extra', expectedRevision: 0, operationId: 'extra', request: {}, state: {}, records: [extra, assessmentSchema.parse({ ...f.assessment, id: 'task-reference-extra-assessment', imageVersionId: extra.id }), runSchema.parse({ ...f.run, id: 'unfinished-reference-run', status: 'running' })] })
    const page = taskReferencePageSchema.parse(await f.action('task-reference-list', { styleId: f.styleId }))
    assert.deepEqual(page.tasks.map(item => item.runId), [f.run.id])
    const rejected = taskReferencePageSchema.parse(await f.action('task-reference-list', { styleId: f.styleId, runId: f.run.id, resultFilter: 'rejected' }))
    assert.equal(rejected.images.length, 2)
    assert.ok(rejected.images.every(row => row.resultCategory === 'rejected'))
    const selected = taskReferencePageSchema.parse(await f.action('task-reference-list', { styleId: f.styleId, runId: f.run.id, resultFilter: 'selected' }))
    assert.equal(selected.images.length, 0)
    const { readTaskReferences } = await import('../src/host/task-references.ts')
    const first = readTaskReferences(f.domain, f.actor, { styleId: f.styleId, runId: f.run.id }, 1)
    assert.ok(first.nextImagePageToken)
    const second = readTaskReferences(f.domain, f.actor, { styleId: f.styleId, runId: f.run.id, pageToken: first.nextImagePageToken }, 1)
    assert.notEqual(first.images[0]?.imageVersionId, second.images[0]?.imageVersionId)
    assert.throws(() => readTaskReferences(f.domain, f.actor, { styleId: f.styleId, runId: f.run.id, resultFilter: 'rejected', pageToken: first.nextImagePageToken }, 1), { code: 'invalid-input' })
    const other = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'other-reference-style', name: 'Other' }))
    await assert.rejects(f.action('task-reference-list', { styleId: other.id, runId: f.run.id }), { code: 'owner-denied' })
    await assert.rejects(f.service.action({ operation: 'task-reference-list', args: { styleId: f.styleId } }, { ...f.actor, kind: 'agent' }, new AbortController().signal), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('picker pages retain weighted selections, categories and readable totals without full image-review projections', async () => {
  const f = await fixture()
  const { readTaskReferences } = await import('../src/host/task-references.ts')
  try {
    const image = f.domain.require('imageVersion', f.assessment.imageVersionId), asset = f.domain.require('asset', image.assetId)
    const copies = ['selected-low', 'selected-high', 'review', 'failed', 'pending', 'source-parent', 'source-derived'].map(id => imageVersionSchema.parse({ ...image, id: `picker-${id}` }))
    const privateAsset = assetSchema.parse({ ...asset, id: 'picker-private-asset', access: { kind: 'session-run', sessionId: 'unreadable-source-session' } }), privateImage = imageVersionSchema.parse({ ...image, id: 'picker-private-image', assetId: privateAsset.id })
    const [low, high, review, failed, pending, parent, derived] = copies
    const lowAssessment = assessmentSchema.parse({ ...f.assessment, id: 'picker-low-assessment', imageVersionId: low!.id, verdict: 'pass', preferenceScores: Object.fromEntries(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'].map(dimension => [dimension, 0.2])) })
    const highAssessment = assessmentSchema.parse({ ...lowAssessment, id: 'picker-high-assessment', imageVersionId: high!.id, preferenceScores: Object.fromEntries(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'].map(dimension => [dimension, 0.9])) })
    const data = dataOf(f.run)
    await f.repository.commit({ aggregateId: 'picker-categories', expectedRevision: 0, operationId: 'picker-categories', request: {}, state: {}, records: [
      ...copies, privateAsset, privateImage, lowAssessment, highAssessment,
      assessmentSchema.parse({ ...f.assessment, id: 'picker-review-assessment', imageVersionId: review!.id, verdict: 'needs-review' }),
      assessmentSchema.parse({ ...f.assessment, id: 'picker-failed-assessment', imageVersionId: failed!.id, technicalStatus: 'failed', verdict: undefined }),
      selectionSchema.parse({ schemaVersion: 1, profileId: f.profileId, kind: 'selection', id: 'picker-low-selection', runId: f.run.id, imageVersionId: low!.id, assessmentId: lowAssessment.id, qualification: 'auto-qualified', rank: 0, warnings: [], createdAt: f.run.createdAt }),
      selectionSchema.parse({ schemaVersion: 1, profileId: f.profileId, kind: 'selection', id: 'picker-high-selection', runId: f.run.id, imageVersionId: high!.id, assessmentId: highAssessment.id, qualification: 'auto-qualified', rank: 1, warnings: [], createdAt: f.run.createdAt }),
      cropCandidateSchema.parse({ schemaVersion: 1, profileId: f.profileId, kind: 'cropCandidate', id: 'picker-source-crop', createdAt: f.run.createdAt, runId: f.run.id, parentImageVersionId: parent!.id, derivedImageVersionId: derived!.id, releaseId: 'picker-release', usageRevisionId: 'picker-usage', recipeId: f.assessment.recipeId, requestedRect: { x: 0, y: 0, width: 1, height: 1 }, geometryResult: 'pass', origin: 'model', data: {} }),
    ] })
    await f.repository.commit({ aggregateId: `run:${f.run.id}`, expectedRevision: f.repository.manifest(`run:${f.run.id}`)!.revision, operationId: 'picker-pending-images', request: {}, state: {}, records: [runSchema.parse({ ...f.run, data: toJson({ ...data, checkpoint: { search: { importedImages: { pending: pending!.id, private: privateImage.id }, issues: [] } } }) })] })
    const get = f.repository.get.bind(f.repository)
    let modelReads = 0, feedbackReads = 0
    f.repository.get = (kind, id) => { if (kind === 'modelProfile') modelReads++; if (kind === 'feedback' || kind === 'feedbackThread') feedbackReads++; return get(kind, id) }
    try {
      const first = readTaskReferences(f.domain, f.actor, { styleId: f.styleId, runId: f.run.id }, 2)
      assert.equal(first.totalImages, 8)
      assert.deepEqual(first.images.map(row => row.imageVersionId), [high!.id, low!.id])
      const ids = first.images.map(row => row.imageVersionId)
      let next = first.nextImagePageToken
      while (next) { const page = readTaskReferences(f.domain, f.actor, { styleId: f.styleId, runId: f.run.id, pageToken: next }, 2); ids.push(...page.images.map(row => row.imageVersionId)); next = page.nextImagePageToken }
      assert.equal(new Set(ids).size, 8); assert.ok(!ids.includes(privateImage.id))
      for (const [filter, total] of [['selected', 2], ['review', 1], ['failed', 1], ['rejected', 1], ['pending', 2], ['source', 1], ['processing', 0]] as const) {
        const page = readTaskReferences(f.domain, f.actor, { styleId: f.styleId, runId: f.run.id, resultFilter: filter }, 20)
        assert.equal(page.totalImages, total, filter)
        assert.ok(page.images.every(image => image.resultCategory === filter), filter)
      }
      assert.equal(modelReads, 0); assert.equal(feedbackReads, 0)
    } finally { f.repository.get = get }
  } finally { await f.cleanup() }
})

test('explicit negative references are durable, replay-safe and do not change the original task', async () => {
  const f = await fixture()
  try {
    const image = f.domain.require('imageVersion', f.assessment.imageVersionId)
    const secondImage = imageVersionSchema.parse({ ...image, id: 'second-task-reference-image' }), secondRun = runSchema.parse({ ...f.run, id: 'second-task-reference-run' })
    await f.repository.commit({ aggregateId: 'second-completed-reference-task', expectedRevision: 0, operationId: 'second-reference-task', request: {}, state: {}, records: [secondImage, secondRun, assessmentSchema.parse({ ...f.assessment, id: 'second-task-reference-assessment', runId: secondRun.id, imageVersionId: secondImage.id })] })
    const revision = f.domain.require('style', f.styleId).revision, original = JSON.stringify(f.domain.require('run', f.run.id)), before = f.domain.require('draft', f.domain.require('style', f.styleId).draftId).referenceIds.length
    const input = { operationId: 'add-negative-task-images', styleId: f.styleId, expectedRevision: revision, images: [{ runId: f.run.id, imageVersionId: image.id }, { runId: secondRun.id, imageVersionId: secondImage.id }], role: 'negative' }
    await assert.rejects(f.action('task-reference-import', { ...input, operationId: 'mixed-task-membership', images: [{ runId: f.run.id, imageVersionId: image.id }, { runId: f.run.id, imageVersionId: secondImage.id }] }), { code: 'owner-denied' })
    assert.equal(f.domain.require('style', f.styleId).revision, revision, 'All source memberships must be checked before any reference is added')
    const controller = new AbortController(), commit = f.repository.commit.bind(f.repository)
    f.repository.commit = async request => { const result = await commit(request); if (request.operationId === `${input.operationId}:row:${image.id}`) controller.abort(); return result }
    await assert.rejects(f.service.action({ operation: 'task-reference-import', args: input }, f.actor, controller.signal))
    f.repository.commit = commit
    const added = taskReferenceReceiptSchema.parse(await f.action('task-reference-import', input))
    assert.equal(added.results[0]?.status, 'added')
    const replay = taskReferenceReceiptSchema.parse(await f.action('task-reference-import', input))
    assert.deepEqual(replay, added)
    await assert.rejects(f.action('task-reference-import', { ...input, role: 'positive' }), { code: 'operation-conflict' })
    await assert.rejects(f.action('task-reference-import', { ...input, operationId: 'duplicate-input', images: [input.images[0]!, input.images[0]!] }), { code: 'invalid-input' })
    await assert.rejects(f.action('task-reference-import', { ...input, operationId: 'too-many-images', images: Array.from({ length: 31 }, (_, index) => ({ runId: index % 2 ? secondRun.id : f.run.id, imageVersionId: `image-${index}` })) }), { code: 'invalid-input' })
    await assert.rejects(f.service.action({ operation: 'task-reference-import', args: input }, { ...f.actor, kind: 'agent' }, new AbortController().signal), { code: 'owner-denied' })
    const draft = f.domain.require('draft', f.domain.require('style', f.styleId).draftId), reference = f.domain.require('reference', added.results[0]!.referenceId!)
    assert.equal(draft.referenceIds.length, before + 2); assert.equal(reference.role, 'negative')
    assert.ok(added.results.length === 2 && added.results.every(row => row.status === 'added'))
    assert.ok(f.domain.referenceJudgments(reference).every(row => row.judgment.kind === 'style-verdict' && row.judgment.value === 'reject'))
    assert.equal(JSON.stringify(f.domain.require('run', f.run.id)), original)
    const duplicate = taskReferenceReceiptSchema.parse(await f.action('task-reference-import', { ...input, operationId: 'add-same-negative-again', expectedRevision: f.domain.require('style', f.styleId).revision }))
    assert.equal(duplicate.results[0]?.status, 'skipped')
    const unrelated = f.repository.list('reference').find(item => item.imageVersionId !== image.id)!
    await assert.rejects(f.action('task-reference-import', { ...input, operationId: 'foreign-image', expectedRevision: f.domain.require('style', f.styleId).revision, images: [{ runId: f.run.id, imageVersionId: unrelated.imageVersionId }] }), { code: 'owner-denied' })
    assert.deepEqual({ includesRejected: f.assessment.verdict === 'reject', explicitRole: reference.role, added: added.results[0]!.status, replayUnchanged: JSON.stringify(added) === JSON.stringify(replay), repeatedSelection: duplicate.results[0]!.status, sourceTaskUnchanged: JSON.stringify(f.domain.require('run', f.run.id)) === original, crossTaskAdditions: added.results.length }, JSON.parse(await readFile(new URL('./fixtures/task-reference-host.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

test('Session preview images become readable library references without a pixel download or permission upgrade', async () => {
  const f = await fixture()
  try {
    const source = f.domain.require('imageVersion', f.assessment.imageVersionId), asset = f.domain.require('asset', source.assetId)
    const remoteAsset = assetSchema.parse({ ...asset, id: 'session-reference-asset', access: { kind: 'session-run', sessionId: 'reference-source-session' }, exportPermission: 'references-only' })
    const remote = imageVersionSchema.parse({ ...source, id: 'session-reference-image', assetId: remoteAsset.id, versionKind: 'remote-reference', blob: remoteReferenceBlob({ providerId: 'unsplash', photoId: 'forest-example', accountId: 'public', url: 'https://images.unsplash.com/photo-reference?w=1080', thumbnailUrl: 'https://images.unsplash.com/photo-reference?w=400' }) })
    const spec = specOf(f.run), data = dataOf(f.run)
    const run = runSchema.parse({ ...f.run, id: 'session-reference-run', owner: { kind: 'session', sessionId: 'reference-source-session' }, spec: toJson({ ...spec, fixed: { ...spec.fixed, output: { kind: 'preview' } } }), data: toJson({ ...data, checkpoint: { previewSearch: { importedImages: { one: remote.id }, issues: [] } } }) })
    const secondAsset = assetSchema.parse({ ...remoteAsset, id: 'other-session-reference-asset', access: { kind: 'session-run', sessionId: 'other-source-session' } }), secondImage = imageVersionSchema.parse({ ...remote, id: 'other-session-reference-image', assetId: secondAsset.id })
    const secondRun = runSchema.parse({ ...run, id: 'other-session-reference-run', owner: { kind: 'session', sessionId: 'other-source-session' }, data: toJson({ ...data, checkpoint: { previewSearch: { importedImages: { two: secondImage.id }, issues: [] } } }) })
    await f.repository.commit({ aggregateId: 'session-reference-fixture', expectedRevision: 0, operationId: 'session-reference-fixture', request: {}, state: {}, records: [remoteAsset, remote, run, secondAsset, secondImage, secondRun, assessmentSchema.parse({ ...f.assessment, id: 'session-reference-assessment', runId: run.id, imageVersionId: remote.id }), assessmentSchema.parse({ ...f.assessment, id: 'other-session-reference-assessment', runId: secondRun.id, imageVersionId: secondImage.id })] })
    await assert.rejects(f.action('task-reference-list', { styleId: f.styleId, runId: run.id }), { code: 'owner-denied' })
    const sessions = new SessionStore(new Context()); sessions.create(brandString<SessionId>('reference-source-session'), { meta: { cwd: f.root } }); f.host.sessions = sessions
    const input = { operationId: 'save-session-negative', styleId: f.styleId, expectedRevision: f.domain.require('style', f.styleId).revision, images: [{ runId: run.id, imageVersionId: remote.id }, { runId: secondRun.id, imageVersionId: secondImage.id }], role: 'negative' }
    await assert.rejects(f.action('task-reference-import', input), { code: 'owner-denied' })
    assert.equal(f.domain.require('style', f.styleId).revision, input.expectedRevision)
    sessions.create(brandString<SessionId>('other-source-session'), { meta: { cwd: f.root } })
    const page = taskReferencePageSchema.parse(await f.action('task-reference-list', { styleId: f.styleId, runId: run.id }))
    assert.ok(page.images.some(row => row.imageVersionId === remote.id && row.previewPath.includes('sessionToken=')))
    assert.ok(page.resourceExpiresAt && page.resourceExpiresAt > Date.now())
    let requests = 0
    const request = f.http.request.bind(f.http); f.http.request = async (...args) => { requests++; return await request(...args) }
    const result = taskReferenceReceiptSchema.parse(await f.action('task-reference-import', input))
    assert.equal(result.results[0]?.status, 'added'); assert.equal(requests, 0)
    assert.ok(result.results.length === 2 && result.results.every(row => row.status === 'added'))
    const reference = f.domain.require('reference', result.results[0]!.referenceId!), saved = f.domain.authorizedImage(reference.imageVersionId, f.actor)
    assert.notEqual(saved.image.id, remote.id); assert.equal(saved.asset.access.kind, 'profile-library')
    assert.equal(saved.asset.exportPermission, 'references-only'); assert.deepEqual(saved.image.blob.remoteSource, remote.blob.remoteSource)
    assert.equal(f.domain.require('asset', remoteAsset.id).access.kind, 'session-run')
  } finally { await f.cleanup() }
})
