/** Collection membership and incremental observations use production service workflows. */
import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { dataOf } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { styleAnalysisOf, styleSummarySchema } from '../src/shared/style-analysis.ts'
import { ModelProfiles } from '../src/domain/model-profile.ts'

const identity = z.object({ id: z.string() }), started = z.object({ runId: z.string() })
const planSchema = z.object({ digest: z.string(), total: z.number(), pending: z.number(), reusable: z.number(), changed: z.number(), entries: z.array(z.object({ state: z.string() })) })

test('distinct imports skip existing photos within a collection and retain cross-collection isolation', async () => {
  let details = 0
  const api = new UnsplashApi({ request: async path => {
    if (path === '/me') return { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 }
    details++
    return { id: 'park', width: 400, height: 200, urls: { small: 'https://images.unsplash.com/park?w=200', regular: 'https://images.unsplash.com/park?w=1080' } }
  } })
  const unsplash = resolveConfig({ source: { unsplash: { accounts: [{ id: 'a', label: 'A', credentialRef: 'COOKIE_A', userId: 'user-a', username: 'owner-a', name: 'A' }] } } }).source.unsplash
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api }, { provider: 'unsplash', unsplash })
  try {
    await f.service.initialize()
    const a = identity.parse(await f.action('style-create', { operationId: 'a', name: 'A' })).id
    const b = identity.parse(await f.action('style-create', { operationId: 'b', name: 'B' })).id
    const input = { mode: 'remote-reference', accountId: 'a', photoIds: ['park'] }
    await f.action('gallery-import', { ...input, operationId: 'first', transferId: 'first', styleId: a, expectedRevision: 1 })
    const revision = f.domain.require('style', a).revision
    const result = await f.action('gallery-import', { ...input, operationId: 'second', transferId: 'second', styleId: a, expectedRevision: revision })
    assert.equal(z.object({ results: z.array(z.object({ skipped: z.literal('already-imported') })) }).parse(result).results.length, 1)
    assert.equal(f.domain.require('style', a).revision, revision)
    assert.equal(f.repository.list('reference').length, 1)
    assert.equal(details, 1)
    await f.action('gallery-import', { ...input, operationId: 'other-collection', transferId: 'other', styleId: b, expectedRevision: 1 })
    assert.equal(f.repository.list('reference').length, 2)
  } finally { await f.cleanup() }
})

test('new references reuse prior observations, summarize all images, and require confirmation for full reanalysis', async () => {
  const f = await serviceFixture(undefined, { maxReferenceImages: 1, maxVisionCalls: 20 })
  try {
    await f.service.initialize()
    const styleId = identity.parse(await f.action('style-create', { operationId: 'style', name: 'Incremental' })).id
    const add = async (color: string) => {
      const base64 = (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64')
      await f.action('reference-import', { operationId: `add-${color}`, styleId, expectedRevision: f.domain.require('style', styleId).revision, files: [{ name: color + '.png', base64, mime: 'image/png', role: 'positive', intent: 'overall', dimensions: [] }] })
    }
    await add('red')
    await f.action('reference-analyze', { operationId: 'initial', styleId, buildDataset: true }); await f.jobs.drain()
    await add('green')
    const plan = planSchema.parse(await f.action('reference-state', { styleId }))
    assert.deepEqual([plan.total, plan.pending, plan.reusable, plan.changed], [2, 1, 1, 0])
    const before = f.http.operations.length
    const runId = started.parse(await f.action('reference-analyze', { operationId: 'incremental', styleId, buildDataset: true, analysisMode: 'pending', planDigest: plan.digest })).runId
    await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run).error))
    assert.deepEqual(f.http.operations.slice(before), ['analyze:', 'summarize:'])
    assert.equal(dataOf(run).counts.observed, 2)
    assert.equal(f.repository.list('observation').length, 2)
    const summary = z.object({ checkpoint: z.object({ styleAnalysis: z.object({ samples: z.array(z.unknown()) }) }) }).parse(run.data)
    assert.equal(summary.checkpoint.styleAnalysis.samples.length, 2)
    await assert.rejects(f.action('reference-analyze', { operationId: 'unconfirmed-full', styleId, buildDataset: true, analysisMode: 'all' }), { code: 'constraint-conflict' })
    const confirmed = planSchema.parse(await f.action('reference-state', { styleId }))
    const fullBefore = f.http.operations.length
    await f.action('reference-analyze', { operationId: 'confirmed-full', styleId, buildDataset: true, analysisMode: 'all', planDigest: confirmed.digest }); await f.jobs.drain()
    assert.equal(f.http.operations.slice(fullBefore).filter(op => op === 'analyze:').length, 2)
    await add('blue')
    await assert.rejects(f.action('reference-analyze', { operationId: 'stale', styleId, buildDataset: true, analysisMode: 'pending', planDigest: confirmed.digest }), { code: 'revision-conflict' })
  } finally { await f.cleanup() }
})

test('two remote batches retain all twenty observations and export their original evidence without reanalyzing ten prior images', async () => {
  let downloads = 0
  const api = new UnsplashApi({ request: async path => {
    if (path === '/me') return { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 }
    const id = path.split('/').at(-1)!
    return { id, width: 400, height: 200, urls: { small: `https://images.unsplash.com/${id}?w=200`, regular: `https://images.unsplash.com/${id}?w=1080` } }
  } })
  const unsplash = resolveConfig({ source: { unsplash: { accounts: [{ id: 'a', label: 'A', credentialRef: 'COOKIE_A', userId: 'user-a', username: 'owner-a', name: 'A' }] } } }).source.unsplash
  const f = await serviceFixture(undefined, { maxReferenceImages: 4 }, { galleryApi: async () => api, galleryMedia: { request: async () => { downloads++; throw new Error('Remote references must not download pixels in the Host') } } }, { provider: 'unsplash', unsplash })
  try {
    await f.service.initialize()
    const styleId = identity.parse(await f.action('style-create', { operationId: 'twenty-style', name: 'Twenty remote references' })).id
    const importBatch = async (start: number) => f.action('gallery-import', { operationId: `batch-${start}`, transferId: `transfer-${start}`, mode: 'remote-reference', accountId: 'a', styleId, expectedRevision: f.domain.require('style', styleId).revision, photoIds: Array.from({ length: 10 }, (_, index) => `photo-${start + index}`), role: 'positive' })
    const analyze = async (operationId: string) => {
      const plan = planSchema.parse(await f.action('reference-state', { styleId }))
      const { runId } = started.parse(await f.action('reference-analyze', { operationId, styleId, buildDataset: true, analysisMode: 'pending', planDigest: plan.digest }))
      await f.jobs.drain()
      const run = f.domain.require('run', runId)
      assert.equal(run.status, 'completed', JSON.stringify(dataOf(run).error))
      return styleAnalysisOf(run)!
    }
    await importBatch(0)
    const first = await analyze('first-ten'), firstEvidence = new Map(first.samples.map(sample => [sample.reference.imageVersionId, f.domain.require('observation', sample.observationId)]))
    assert.equal(first.samples.length, 10)
    assert.equal(f.http.operations.filter(operation => operation === 'analyze:').length, 3)
    await importBatch(10)
    const plan = planSchema.parse(await f.action('reference-state', { styleId }))
    assert.deepEqual([plan.total, plan.pending, plan.reusable, plan.changed], [20, 10, 10, 0])
    const before = f.http.operations.length, second = await analyze('second-ten')
    assert.deepEqual(f.http.operations.slice(before), ['analyze:', 'analyze:', 'analyze:', 'summarize:'])
    assert.equal(f.repository.list('observation').length, 20)
    assert.equal(new Set(second.samples.map(sample => sample.reference.imageVersionId)).size, 20)
    for (const sample of second.samples) if (firstEvidence.has(sample.reference.imageVersionId)) assert.deepEqual(f.domain.require('observation', sample.observationId), firstEvidence.get(sample.reference.imageVersionId))
    const summary = z.object({ samples: z.array(z.object({ imageVersionId: z.string(), observation: z.object({ id: z.string() }) })), coverage: z.object({ observed: z.number(), total: z.number(), representativePixels: z.number() }) }).parse(JSON.parse(f.http.summaryInputs.at(-1)!))
    assert.deepEqual([summary.coverage.observed, summary.coverage.total, summary.coverage.representativePixels], [20, 20, 4])
    assert.equal(summary.samples.length, 20)
    assert.deepEqual(new Set(summary.samples.map(sample => sample.observation.id)), new Set(second.samples.map(sample => sample.observationId)))
    assert.deepEqual(new Set(second.summary.suggestedRules[0]!.supportImageVersionIds), new Set(second.samples.map(sample => sample.reference.imageVersionId)))
    const current = new ModelProfiles(f.domain).current(styleId, f.actor)!, dataset = await new ModelProfiles(f.domain).export(current, 'twenty-dataset', f.actor)
    const rows = dataset.files.find(file => file.name === 'samples.jsonl')!.content.trim().split('\n').map(line => z.object({ imageVersionId: z.string(), inferred: z.array(z.object({ requestId: z.string() }).passthrough()), measured: z.array(z.unknown()) }).parse(JSON.parse(line)))
    assert.equal(rows.length, 20)
    for (const row of rows) {
      assert.equal(row.measured.length, 0, 'URL references must not claim measured pixels')
      const sample = second.samples.find(sample => sample.reference.imageVersionId === row.imageVersionId)!
      assert.deepEqual(row.inferred, f.domain.require('observation', sample.observationId).inferred)
    }
    const revision = f.domain.require('style', styleId).revision
    await f.action('gallery-import', { operationId: 'duplicate-ten', transferId: 'duplicate-ten', mode: 'remote-reference', accountId: 'a', styleId, expectedRevision: revision, photoIds: Array.from({ length: 10 }, (_, index) => `photo-${index}`) })
    assert.equal(f.domain.require('style', styleId).revision, revision)
    const reusable = planSchema.parse(await f.action('reference-state', { styleId }))
    assert.deepEqual([reusable.total, reusable.pending, reusable.reusable], [20, 0, 20])
    const thirdBefore = f.http.operations.length
    const third = await analyze('all-reused')
    assert.deepEqual(f.http.operations.slice(thirdBefore), ['summarize:'])
    assert.equal(third.samples.length, 20)
    assert.equal(f.repository.list('observation').length, 20)
    assert.equal(downloads, 0)
  } finally { await f.cleanup() }
})

test('contradictory model evidence fails organization visibly and retries only the retained summary', async context => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const styleId = identity.parse(await f.action('style-create', { operationId: 'conflict-style', name: 'Evidence conflict' })).id
    await f.action('reference-import', { operationId: 'conflict-import', styleId, expectedRevision: 1, files: [{ name: 'reference.png', base64: f.http.image.toString('base64'), mime: 'image/png', role: 'positive', intent: 'overall', dimensions: [] }] })
    const request = f.http.request.bind(f.http)
    let contradict = true
    context.mock.method(f.http, 'request', async (...args: Parameters<typeof request>) => {
      const response = await request(...args)
      if (!contradict || f.http.operations.at(-1) !== 'summarize:') return response
      const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string() })) }).parse(JSON.parse(Buffer.from(response.bytes).toString('utf8')))
      const summary = styleSummarySchema.parse(JSON.parse(envelope.choices[0]!.message.content))
      summary.suggestedRules[0]!.counterImageVersionIds = [...summary.suggestedRules[0]!.supportImageVersionIds]
      envelope.choices[0]!.message.content = JSON.stringify(summary)
      return { ...response, bytes: Buffer.from(JSON.stringify(envelope)) }
    })
    const { runId } = started.parse(await f.action('reference-analyze', { operationId: 'conflict-analysis', styleId, buildDataset: true }))
    await f.jobs.drain()
    const failed = f.domain.require('run', runId)
    assert.equal(failed.status, 'failed')
    assert.equal(dataOf(failed).error?.code, 'vision-invalid-output')
    assert.equal(dataOf(failed).counts.observed, 1)
    assert.equal(dataOf(failed).checkpoint.styleAnalysis, undefined)
    assert.equal(f.repository.list('modelProfile').length, 0)
    assert.equal(f.repository.list('profileExport').length, 0)
    const evidence = f.repository.list('observation')[0]!
    contradict = false
    const plan = planSchema.parse(await f.action('reference-state', { styleId }))
    assert.deepEqual([plan.pending, plan.reusable], [0, 1])
    const before = f.http.operations.length
    const next = started.parse(await f.action('reference-analyze', { operationId: 'fixed-summary', styleId, buildDataset: true, analysisMode: 'pending', planDigest: plan.digest }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', next.runId).status, 'completed')
    assert.deepEqual(f.http.operations.slice(before), ['summarize:'])
    assert.deepEqual(f.repository.list('observation'), [evidence])
    assert.equal(styleAnalysisOf(f.domain.require('run', next.runId))!.samples[0]!.observationId, evidence.id)
  } finally { await f.cleanup() }
})
