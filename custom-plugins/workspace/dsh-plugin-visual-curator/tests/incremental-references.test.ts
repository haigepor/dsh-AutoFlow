/** Collection membership and incremental observations use production service workflows. */
import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { dataOf } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'

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
