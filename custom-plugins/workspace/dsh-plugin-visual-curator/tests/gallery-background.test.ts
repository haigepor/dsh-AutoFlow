/** Background imports keep their target and receipts after the launching view leaves. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { GalleryReferenceTasks } from '../src/host/gallery-tasks.ts'
import { toJson } from '../src/host/runtime.ts'
import { readFile } from 'node:fs/promises'
import { galleryTaskProgress, galleryTaskViewSchema } from '../src/shared/gallery-task.ts'

const taskView = z.object({ id: z.string(), styleId: z.string(), status: z.string(), completed: z.number(), failed: z.number(), total: z.number() })
const photo = (id: string) => ({ id, width: 400, height: 200, urls: { small: `https://images.unsplash.com/${id}?w=200`, regular: `https://images.unsplash.com/${id}?w=800` } })

test('live progress includes published batch rows and stays unchanged when its batch receipt settles', () => {
  const task = galleryTaskViewSchema.parse({ id: 'a'.repeat(64), styleId: 'style', status: 'running', phase: 'saving', total: 25, completed: 0, registered: 3, failed: 0, createdAt: '', updatedAt: '' })
  assert.deepEqual(galleryTaskProgress(task), { referenced: 3, processed: 3, percent: 12 })
  assert.deepEqual(galleryTaskProgress({ ...task, completed: 3, registered: 0 }), galleryTaskProgress(task))
  assert.deepEqual(galleryTaskProgress({ ...task, total: 0 }), { referenced: 0, processed: 0, percent: 0 })
  assert.deepEqual(galleryTaskProgress({ ...task, completed: 24, registered: 3, failed: 2 }), { referenced: 25, processed: 25, percent: 100 })
})

test('each successful URL reference is visible before the remaining photos finish', async () => {
  let enter = () => {}, release = () => {}
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const api = new UnsplashApi({ request: async path => {
    const id = path.split('/').at(-1)!
    if (id === 'two') { enter(); await gate }
    return photo(id)
  } })
  const f = await serviceFixture(undefined, { maxImportFiles: 3 }, { galleryApi: async () => api, galleryMedia: { request: async () => { throw new Error('URL registration must not fetch image bytes') } } })
  await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'live-style', name: 'Live' }))
    await f.action('gallery-reference-start', { operationId: 'live-import', styleId, photoIds: ['one', 'two', 'three'] })
    await entered
    const page = z.object({ total: z.number(), images: z.array(z.object({ imageVersionId: z.string() })) }).parse(await f.action('references-list', { styleId }))
    const task = z.object({ tasks: z.array(taskView.extend({ registered: z.number() })) }).parse(await f.action('gallery-reference-tasks')).tasks[0]!
    assert.deepEqual({ cards: page.images.length, total: page.total, registered: task.registered + task.completed }, { cards: 1, total: 1, registered: 1 })
    assert.equal(task.status, 'running')
    release(); await f.jobs.drain()
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).referenceIds.length, 3)
    assert.equal(f.http.operations.length, 0)
  } finally { release(); await f.cleanup() }
})

test('accepted imports outlive the starting request, pin their collection, and expose committed progress', async () => {
  let enter = () => {}, release = () => {}
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const api = new UnsplashApi({ request: async path => { enter(); await gate; return photo(path.split('/').at(-1)!) } })
  const f = await serviceFixture(undefined, { maxImportFiles: 2, pageSize: 2 }, { galleryApi: async () => api })
  await f.service.initialize()
  const lifetime = new AbortController()
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'background-style', name: 'Background' }))
    const args = { operationId: 'background-import', styleId: style.id, photoIds: ['one', 'two', 'three'], role: 'positive' }
    const accepted = taskView.parse(await f.service.action({ operation: 'gallery-reference-start', args }, f.actor, lifetime.signal))
    await entered
    lifetime.abort()
    assert.equal(taskView.parse(await f.action('gallery-reference-start', args)).id, accepted.id)
    await assert.rejects(f.action('gallery-reference-start', { ...args, operationId: 'conflicting-import' }), { code: 'constraint-conflict' })
    await assert.rejects(f.action('reference-analyze', { styleId: style.id, operationId: 'premature-analysis', buildDataset: true }), { code: 'constraint-conflict' })
    await assert.rejects(f.action('style-archive', { styleId: style.id, operationId: 'premature-delete', expectedRevision: 1 }), { code: 'constraint-conflict' })
    release(); await f.jobs.drain()
    const result = z.object({ tasks: z.array(taskView) }).parse(await f.action('gallery-reference-tasks')).tasks[0]!
    assert.deepEqual({ status: result.status, completed: result.completed, failed: result.failed, total: result.total }, JSON.parse(await readFile(new URL('./fixtures/gallery-background.expected.json', import.meta.url), 'utf8')))
    assert.equal(f.domain.require('draft', f.domain.require('style', style.id).draftId).referenceIds.length, 3)
    assert.equal(f.repository.list('imageVersion').every(image => image.versionKind === 'remote-reference'), true)
    assert.equal(f.http.operations.length, 0)
  } finally { release(); await f.cleanup() }
})

test('collection pagination stays valid when background imports append references', async () => {
  const api = new UnsplashApi({ request: async path => photo(path.split('/').at(-1)!) })
  const f = await serviceFixture(undefined, { maxImportFiles: 2, pageSize: 2 }, { galleryApi: async () => api })
  await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'pagination-style', name: 'Paged' }))
    await f.action('gallery-reference-start', { operationId: 'first-three', styleId, photoIds: ['one', 'two', 'three'] }); await f.jobs.drain()
    const schema = z.object({ images: z.array(z.object({ referenceId: z.string(), styleId: z.string() })), total: z.number(), nextPageToken: z.string().optional() })
    const first = schema.parse(await f.action('references-list', { styleId, pageSize: 2 }))
    assert.equal(first.total, 3); assert.equal(first.images.length, 2); assert.ok(first.nextPageToken)
    await f.action('gallery-reference-start', { operationId: 'append-two', styleId, photoIds: ['four', 'five'] }); await f.jobs.drain()
    const next = schema.parse(await f.action('references-list', { styleId, pageSize: 10, pageToken: first.nextPageToken }))
    assert.equal(next.total, 5); assert.equal(next.images.length, 3)
    assert.equal(new Set([...first.images, ...next.images].map(image => image.referenceId)).size, 5)
    const other = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'other-style', name: 'Other' }))
    await assert.rejects(f.action('references-list', { styleId: other.id, pageToken: first.nextPageToken }), { code: 'invalid-input' })
    const style = f.domain.require('style', styleId), draft = f.domain.require('draft', style.draftId)
    await f.domain.action('draft-save', { operationId: 'remove-prefix', styleId, expectedRevision: style.revision, referenceIds: draft.referenceIds.slice(1), rules: draft.rules, conflicts: draft.conflicts, feedbackIds: draft.feedbackIds }, f.actor)
    await assert.rejects(f.action('references-list', { styleId, pageToken: first.nextPageToken }), { code: 'invalid-input' })
  } finally { await f.cleanup() }
})

test('stopping a later batch retains its confirmed prefix and does not dispatch the next photo', async () => {
  let enter = () => {}, release = () => {}
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const seen: string[] = []
  const api = new UnsplashApi({ request: async (path, _params, bounds) => {
    const id = path.split('/').at(-1)!; seen.push(id)
    if (id === 'two') {
      enter()
      await Promise.race([gate, new Promise<void>((_resolve, reject) => { bounds.signal?.addEventListener('abort', () => reject(bounds.signal?.reason), { once: true }) })])
      bounds.signal?.throwIfAborted()
    }
    return photo(id)
  } })
  const f = await serviceFixture(undefined, { maxImportFiles: 1 }, { galleryApi: async () => api }); await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'stop-style', name: 'Stopped' }))
    const task = taskView.parse(await f.action('gallery-reference-start', { operationId: 'stop-job', styleId, photoIds: ['one', 'two', 'three'] }))
    await entered
    const foreign = { ...f.actor, profileId: 'other-profile' }
    await assert.rejects(f.service.action({ operation: 'gallery-reference-stop', args: { taskId: task.id } }, foreign, new AbortController().signal), { code: 'owner-denied' })
    await f.action('gallery-reference-stop', { taskId: task.id }); await f.jobs.drain()
    const result = z.object({ tasks: z.array(taskView) }).parse(await f.action('gallery-reference-tasks')).tasks[0]!
    assert.equal(result.status, 'cancelled'); assert.equal(result.completed, 1)
    assert.deepEqual(seen, ['one', 'two'])
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).referenceIds.length, 1)
  } finally { release(); await f.cleanup() }
})

test('restart reconstructs a committed batch before marking its unfinished task interrupted', async () => {
  let requests = 0
  const api = new UnsplashApi({ request: async path => { requests++; return photo(path.split('/').at(-1)!) } })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api }); await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'recover-style', name: 'Recover' }))
    const task = taskView.parse(await f.action('gallery-reference-start', { operationId: 'recover-job', styleId, photoIds: ['one', 'two'] })); await f.jobs.drain()
    const manifest = f.repository.manifest(`gallery-task:${task.id}`)!
    const saved = z.record(z.string(), z.json()).parse(manifest.state)
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'simulate-before-task-checkpoint', request: {}, records: [], state: toJson({ ...saved, status: 'running', offset: 0, completed: 0, batch: { operationId: `gallery-task:${task.id}:0`, expectedRevision: 1, photoIds: ['one', 'two'] } }) })
    const recovered = new GalleryReferenceTasks(f.service.config, f.domain, f.jobs, async () => { throw new Error('Recovery must not dispatch') }, () => ({ rows: [] }), async () => {})
    await recovered.initialize()
    assert.equal(recovered.list(f.actor)[0]!.completed, 2)
    assert.equal(recovered.list(f.actor)[0]!.status, 'interrupted')
    assert.equal(requests, 2)
    await recovered.dispose()
  } finally { await f.cleanup() }
})

test('a missing final batch receipt retains published cards and recovers their count without replay', async () => {
  let requests = 0
  const api = new UnsplashApi({ request: async path => { requests++; return photo(path.split('/').at(-1)!) } })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api }); await f.service.initialize()
  const commit = f.repository.commit.bind(f.repository)
  f.repository.commit = async input => { if (input.aggregateId.startsWith('gallery-reference:')) throw new Error('Interrupted before final batch receipt'); return commit(input) }
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'partial-style', name: 'Partial' }))
    const task = taskView.parse(await f.action('gallery-reference-start', { operationId: 'partial-import', styleId, photoIds: ['one', 'two'] })); await f.jobs.drain()
    const result = z.object({ tasks: z.array(taskView) }).parse(await f.action('gallery-reference-tasks')).tasks[0]!
    assert.equal(result.status, 'needs-review'); assert.equal(result.completed, 2)
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).referenceIds.length, 2)
    f.repository.commit = commit
    const manifest = f.repository.manifest(`gallery-task:${task.id}`)!, saved = z.record(z.string(), z.json()).parse(manifest.state)
    await commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'simulate-before-partial-checkpoint', request: {}, records: [], state: toJson({ ...saved, status: 'running', completed: 0, offset: 0, batch: { operationId: `gallery-task:${task.id}:0`, expectedRevision: 1, photoIds: ['one', 'two'] } }) })
    const recovered = new GalleryReferenceTasks(f.service.config, f.domain, f.jobs, async () => { throw new Error('Recovery cannot dispatch') }, () => ({ rows: [] }), async () => {})
    await recovered.initialize()
    assert.equal(recovered.list(f.actor)[0]!.completed, 2)
    assert.equal(recovered.list(f.actor)[0]!.status, 'interrupted')
    assert.equal(requests, 2)
    await recovered.dispose()
  } finally { f.repository.commit = commit; await f.cleanup() }
})

test('an unrecognizable batch receipt stops the task without replay or later dispatch', async () => {
  const f = await serviceFixture(undefined, { maxImportFiles: 1 }); await f.service.initialize()
  let calls = 0
  const tasks = new GalleryReferenceTasks(f.service.config, f.domain, f.jobs, async () => { calls++; return { results: [] } }, () => ({ rows: [] }), async () => {})
  await tasks.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'unknown-style', name: 'Unknown' }))
    const accepted = await tasks.start({ operationId: 'unknown-job', styleId, photoIds: ['one', 'two'] }, f.actor)
    await assert.rejects(tasks.cancel(accepted.id, { ...f.actor, sessionId: 'other-session' }), { code: 'owner-denied' })
    await f.jobs.drain()
    assert.equal(tasks.list(f.actor)[0]!.status, 'needs-review'); assert.equal(calls, 1)
    assert.equal(tasks.list(f.actor)[0]!.completed, 0)
  } finally { await tasks.dispose(); await f.cleanup() }
})

test('Host disposal waits for an admitted batch receipt before closing its writer', async () => {
  let enter = () => {}, release = () => {}
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const requests: string[] = []
  const api = new UnsplashApi({ request: async path => { const id = path.split('/').at(-1)!; requests.push(id); return photo(id) } })
  const f = await serviceFixture(undefined, { maxImportFiles: 1 }, { galleryApi: async () => api }); await f.service.initialize()
  const commit = f.repository.commit.bind(f.repository)
  let paused = false
  f.repository.commit = async input => {
    if (!paused && input.aggregateId.startsWith('gallery-reference:')) { paused = true; enter(); await gate }
    return commit(input)
  }
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'dispose-style', name: 'Dispose' }))
    const task = taskView.parse(await f.action('gallery-reference-start', { operationId: 'dispose-job', styleId, photoIds: ['one', 'two'] }))
    await entered
    let stopped = false
    const stopping = f.service.dispose().then(() => { stopped = true })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(stopped, false)
    release(); await stopping
    const saved = taskView.parse(f.repository.manifest(`gallery-task:${task.id}`)!.state)
    assert.equal(saved.status, 'interrupted'); assert.equal(saved.completed, 1)
    assert.deepEqual(requests, ['one'])
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).referenceIds.length, 1)
  } finally { release(); f.repository.commit = commit; await f.cleanup() }
})
