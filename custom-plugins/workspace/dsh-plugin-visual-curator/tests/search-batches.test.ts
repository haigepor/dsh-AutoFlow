import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { readSearchBatches } from '../src/host/search-batches.ts'
import { projectRun } from '../src/host/projection.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { searchBatchPageSchema } from '../src/shared/search-batches.ts'
import { recordSchema, runSchema, selectionSchema } from '../src/shared/model.ts'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'

async function fixture() {
  const f = await serviceFixture()
  await f.service.initialize()
  const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style-a', name: 'A' }))
  await f.action('reference-import', { operationId: 'reference-a', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  await f.action('reference-analyze', { operationId: 'analysis-a', styleId: style.id, buildDataset: true }); await f.jobs.drain()
  const profile = f.repository.list('modelProfile')[0]!
  assert.ok(profile)
  const prepared = z.object({ normalizedInput: z.record(z.string(), z.json()), preparationDigest: z.string() }).parse(await f.action('task-prepare', { kind: 'search', releaseId: profile.id, output: { kind: 'original' }, taskBrief: 'Green landscape', queries: ['forest'], targetCount: 1 }))
  const started = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'search-a', ...prepared.normalizedInput, preparationDigest: prepared.preparationDigest }))
  await f.jobs.drain()
  const original = f.domain.require('run', started.runId), selection = f.repository.list('selection').find(item => item.runId === original.id)!
  assert.ok(selection)
  const other = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style-b', name: 'B' }))
  for (const [id, styleId] of [['session-batch', style.id], ['foreign-collection', other.id]]) {
    const spec = specOf(original), standard = z.object({ styleId: z.string() }).passthrough().parse(spec.fixed.release)
    const run = runSchema.parse({ ...original, id, createdAt: '2026-10-29T01:00:00.000Z', owner: { kind: 'session', sessionId: `session-${id}` }, spec: toJson({ ...spec, fixed: { ...spec.fixed, release: { ...standard, styleId } } }) })
    await f.repository.commit({ aggregateId: `fixture:${id}`, expectedRevision: 0, operationId: `copy:${id}`, request: {}, state: {}, records: [run, selectionSchema.parse({ ...selection, id: `selection-${id}`, runId: id })] })
  }
  const read = (run: typeof original) => ({ actor: { ...f.actor, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) } })
  return { ...f, styleId: style.id, otherStyleId: other.id, original, read }
}

test('collection batches retain both profile and Session results without mixing another collection', async () => {
  const f = await fixture()
  try {
    const page = readSearchBatches(f.domain, f.actor, { styleId: f.styleId }, 20, f.read)
    assert.equal(page.totalBatches, 2); assert.equal(page.totalMatches, 2)
    assert.deepEqual(page.batches.map(batch => batch.runId).sort(), [f.original.id, 'session-batch'].sort())
    assert.equal(page.batches.every(batch => batch.images.length === 1), true)
    const live = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: f.styleId }))
    assert.equal(live.batches.find(batch => batch.runId === 'session-batch')?.unavailable, true)
    assert.equal(live.batches.find(batch => batch.runId === f.original.id)?.images.length, 1)
    const sessions = new SessionStore(new Context())
    sessions.create(brandString<SessionId>('session-session-batch'), { meta: { cwd: f.root } })
    f.host.sessions = sessions
    const authorized = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: f.styleId }))
    const restored = authorized.batches.find(batch => batch.runId === 'session-batch')!
    assert.equal(restored.unavailable, false); assert.equal(restored.images.length, 1)
    const token = new URL(restored.images[0]!.previewPath, 'http://fixture.test').searchParams.get('sessionToken')
    assert.ok(token)
    await f.action('run-get', { runId: 'session-batch', sessionToken: token })
    await assert.rejects(f.action('run-get', { runId: 'foreign-collection', sessionToken: token }), /another Session|another owner/)
    assert.equal(dataOf(f.domain.require('run', f.original.id)).counts.qualified, 1)
  } finally { await f.cleanup() }
})

test('batch and cursor filters stay in the selected collection and Agent reads stay denied', async () => {
  const f = await fixture()
  try {
    const first = readSearchBatches(f.domain, f.actor, { styleId: f.styleId }, 1, f.read)
    assert.ok(first.nextPageToken)
    const second = readSearchBatches(f.domain, f.actor, { styleId: f.styleId, pageToken: first.nextPageToken }, 1, f.read)
    assert.notEqual(first.batches[0]?.runId, second.batches[0]?.runId)
    assert.throws(() => readSearchBatches(f.domain, f.actor, { styleId: f.otherStyleId, pageToken: first.nextPageToken }, 1, f.read), /Refresh the batch list/)
    assert.throws(() => readSearchBatches(f.domain, f.actor, { styleId: f.styleId, batchId: 'foreign-collection' }, 1, f.read), /unavailable/)
    await assert.rejects(f.service.action({ operation: 'search-batches', args: { styleId: f.styleId } }, { kind: 'agent', id: 'agent', profileId: f.profileId, sessionId: 'session-session-batch' }, new AbortController().signal), /unavailable to Agent tools/)
  } finally { await f.cleanup() }
})

test('the owner can hide an ended batch with an unavailable Session without granting access to its saved Run', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.action('run-delete', { styleId: f.otherStyleId, runId: 'session-batch', operationId: 'wrong-collection' }), { code: 'owner-denied' })
    const args = { styleId: f.styleId, runId: 'session-batch', operationId: 'hide-unavailable' }
    await assert.rejects(f.service.action({ operation: 'run-delete', args }, { ...f.actor, kind: 'agent', sessionId: 'session-session-batch' }, new AbortController().signal), { code: 'owner-denied' })
    assert.deepEqual(await f.action('run-delete', args), { runId: 'session-batch', deleted: true })
    assert.deepEqual(await f.action('run-delete', args), { runId: 'session-batch', deleted: true })
    const page = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: f.styleId }))
    assert.equal(page.totalBatches, 1)
    assert.equal(page.batches.some(batch => batch.runId === 'session-batch'), false)
    assert.ok(f.repository.get('run', 'session-batch'))
    assert.ok(f.repository.list('selection').some(item => item.runId === 'session-batch'))
    await assert.rejects(f.action('run-get', { runId: 'session-batch' }), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('batch browsing assembles selected metadata without image review projections or media requests', async () => {
  const f = await fixture()
  try {
    const listed: string[] = [], originalList = f.repository.list.bind(f.repository)
    f.repository.list = kind => { listed.push(kind); return originalList(kind) }
    let mediaRequests = 0
    const originalRequest = f.http.request.bind(f.http)
    f.http.request = async (...args) => { mediaRequests++; return await originalRequest(...args) }
    const page = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: f.styleId }))
    assert.equal(page.totalMatches, 2)
    assert.equal(page.batches.find(batch => batch.runId === f.original.id)?.images.length, 1)
    assert.equal(mediaRequests, 0)
    assert.equal(listed.includes('feedback'), false)
    assert.equal(listed.includes('feedbackThread'), false)
    assert.equal(listed.includes('cropCandidate'), false)
    assert.equal(listed.includes('assessment'), false)
  } finally { await f.cleanup() }
})

test('remote batch thumbnails keep the preview grant without reading either image representation', async () => {
  const f = await fixture()
  try {
    const selection = f.repository.list('selection').find(item => item.runId === f.original.id)!
    const image = f.domain.require('imageVersion', selection.imageVersionId), asset = f.domain.require('asset', image.assetId)
    const digest = 'c'.repeat(64)
    await f.repository.commit({ aggregateId: 'fixture:remote-thumbnail', expectedRevision: 0, operationId: 'remote-thumbnail', request: {}, state: {}, records: [
      recordSchema.parse({ ...asset, id: 'remote-thumbnail-asset', access: { kind: 'session-run', sessionId: 'session-session-batch' } }),
      recordSchema.parse({ ...image, id: 'remote-thumbnail-image', assetId: 'remote-thumbnail-asset', versionKind: 'remote-reference', blob: { digest: `remote-url-v1:${digest}`, byteLength: 0, mime: 'image/jpeg', storageRef: `remote-links/${digest}`, remoteSource: { providerId: 'unsplash', photoId: 'synthetic-thumbnail', accountId: 'synthetic-account', url: 'https://images.unsplash.com/photo-synthetic?w=1200', thumbnailUrl: 'https://images.unsplash.com/photo-synthetic?w=240' } } }),
      recordSchema.parse({ ...selection, id: 'remote-thumbnail-selection', runId: 'session-batch', imageVersionId: 'remote-thumbnail-image' }),
    ] })
    const sessions = new SessionStore(new Context())
    sessions.create(brandString<SessionId>('session-session-batch'), { meta: { cwd: f.root } }); f.host.sessions = sessions
    let mediaRequests = 0
    const originalRequest = f.http.request.bind(f.http)
    f.http.request = async (...args) => { mediaRequests++; return await originalRequest(...args) }
    const page = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: f.styleId, batchId: 'session-batch' }))
    const remote = page.batches[0]!.images.find(item => item.imageVersionId === 'remote-thumbnail-image')!
    assert.ok(remote.thumbnailPath)
    const preview = new URL(remote.previewPath, 'http://fixture.test'), thumbnail = new URL(remote.thumbnailPath, 'http://fixture.test')
    assert.equal(preview.searchParams.get('imageVersionId'), 'remote-thumbnail-image')
    assert.equal(preview.searchParams.get('preview'), null)
    assert.equal(thumbnail.searchParams.get('preview'), 'thumbnail')
    assert.equal(thumbnail.searchParams.get('imageVersionId'), preview.searchParams.get('imageVersionId'))
    assert.ok(preview.searchParams.get('sessionToken'))
    assert.equal(thumbnail.searchParams.get('sessionToken'), preview.searchParams.get('sessionToken'))
    assert.equal(page.batches[0]!.images.find(item => item.imageVersionId === image.id)?.thumbnailPath, undefined)
    assert.equal(mediaRequests, 0)
  } finally { await f.cleanup() }
})

test('Run result pages retain global summaries and order while review tables are read once per page', async () => {
  const f = await fixture()
  try {
    const selected = f.repository.list('selection').find(item => item.runId === f.original.id)!
    const image = f.domain.require('imageVersion', selected.imageVersionId), assessment = f.domain.require('assessment', selected.assessmentId)
    const records = Array.from({ length: 7 }, (_, index) => {
      const id = `extra-image-${index}`, assessmentId = `extra-assessment-${index}`
      return [recordSchema.parse({ ...image, id }), recordSchema.parse({ ...assessment, id: assessmentId, imageVersionId: id }),
        recordSchema.parse({ ...selected, id: `extra-selection-${index}`, imageVersionId: id, assessmentId })]
    }).flat()
    await f.repository.commit({ aggregateId: 'fixture:extra-results', expectedRevision: 0, operationId: 'extra-results', request: {}, state: {}, records })
    const expected = projectRun(f.domain, f.domain.require('run', f.original.id), f.actor).results.filter(item => item.selection?.kind === 'selected').map(item => item.imageVersionId)
    const tableReads = new Map<string, number>(), originalList = f.repository.list.bind(f.repository)
    f.repository.list = kind => { tableReads.set(kind, (tableReads.get(kind) ?? 0) + 1); return originalList(kind) }
    let imageReads = 0
    const authorizedImage = f.domain.authorizedImage.bind(f.domain)
    f.domain.authorizedImage = (id, actor) => { imageReads++; return authorizedImage(id, actor) }
    const page = z.object({ results: z.array(z.object({ imageVersionId: z.string() })), pageToken: z.string(), resultSummary: z.object({ selected: z.number() }) }).parse(await f.action('run-get', { runId: f.original.id, resultFilter: 'selected', pageSize: 2 }))
    assert.deepEqual(page.results.map(item => item.imageVersionId), expected.slice(0, 2))
    assert.equal(page.resultSummary.selected, 8)
    assert.equal(imageReads, 10, 'all eight images need authorization, while only two need result-card metadata')
    for (const kind of ['assessment', 'selection', 'cropCandidate', 'feedback', 'feedbackThread']) assert.ok((tableReads.get(kind) ?? 0) <= 1, `${kind} was enumerated ${tableReads.get(kind)} times for a two-image page`)
    const next = z.object({ results: z.array(z.object({ imageVersionId: z.string() })), resultSummary: z.object({ selected: z.number() }) }).parse(await f.action('run-get', { runId: f.original.id, resultFilter: 'selected', pageSize: 2, pageToken: page.pageToken }))
    assert.deepEqual(next.results.map(item => item.imageVersionId), expected.slice(2, 4))
    assert.equal(next.resultSummary.selected, 8)
    const batches = readSearchBatches(f.domain, f.actor, { styleId: f.styleId, batchId: f.original.id }, 2, f.read)
    assert.deepEqual(batches.batches[0]?.images.map(item => item.imageVersionId), expected.slice(0, 2))
    assert.ok(batches.batches[0]?.nextImagePageToken)
    const nextImages = readSearchBatches(f.domain, f.actor, { styleId: f.styleId, batchId: f.original.id, pageToken: batches.batches[0].nextImagePageToken }, 2, f.read)
    assert.deepEqual(nextImages.batches[0]?.images.map(item => item.imageVersionId), expected.slice(2, 4))
  } finally { await f.cleanup() }
})

test('filtered result pages keep rejected, unknown, technical, source and pending totals independent', async () => {
  const f = await fixture()
  try {
    const selected = f.repository.list('selection').find(item => item.runId === f.original.id)!
    const image = f.domain.require('imageVersion', selected.imageVersionId), assessment = f.domain.require('assessment', selected.assessmentId)
    const records = ['rejected', 'review', 'failed', 'pending', 'source'].flatMap(category => {
      const { verdict, ...fields } = assessment
      return [recordSchema.parse({ ...image, id: `${category}-image` }), recordSchema.parse({ ...fields, id: `${category}-assessment`, imageVersionId: `${category}-image`, technicalStatus: category === 'failed' ? 'failed' : 'completed', ...(category !== 'failed' ? { verdict: category === 'rejected' ? 'reject' : category === 'review' ? 'needs-review' : 'pass' } : {}) })]
    })
    records.push(recordSchema.parse({ schemaVersion: 1, profileId: f.profileId, createdAt: f.original.createdAt, kind: 'cropCandidate', id: 'source-crop', parentImageVersionId: 'source-image', derivedImageVersionId: image.id, runId: f.original.id, releaseId: assessment.releaseId ?? 'fixed-profile', usageRevisionId: 'fixed-usage', recipeId: assessment.recipeId, requestedRect: { x: 0, y: 0, width: 1, height: 1 }, geometryResult: 'pass', origin: 'model', data: {} }))
    await f.repository.commit({ aggregateId: 'fixture:result-categories', expectedRevision: 0, operationId: 'result-categories', request: {}, state: {}, records })
    for (const category of ['rejected', 'review', 'failed', 'pending', 'source']) {
      const page = z.object({ results: z.array(z.object({ imageVersionId: z.string() })), resultSummary: z.object({ selected: z.number(), needsReview: z.number(), rejected: z.number(), failedImages: z.number(), pending: z.number(), sourceImages: z.number(), candidates: z.number() }) }).parse(await f.action('run-get', { runId: f.original.id, resultFilter: category, pageSize: 1 }))
      assert.deepEqual(page.results.map(item => item.imageVersionId), [`${category}-image`])
      assert.deepEqual(page.resultSummary, { selected: 1, needsReview: 1, rejected: 1, failedImages: 1, pending: 1, sourceImages: 1, candidates: 6 })
    }
    const running = projectRun(f.domain, { ...f.domain.require('run', f.original.id), status: 'running' }, f.actor, undefined, true, { resultFilter: 'processing', imageWindow: () => ({ offset: 0, size: 1 }) })
    assert.deepEqual(running.results.map(item => item.imageVersionId), ['pending-image'])
    assert.equal(running.resultSummary?.processing, 1)
    assert.equal(running.resultSummary?.pending, 0)
  } finally { await f.cleanup() }
})
