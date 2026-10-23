/** Live workbench edits cannot replace an accepted task's review standard or sampling recipe. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { specOf } from '../src/host/runtime.ts'

const idSchema = z.object({ id: z.string() })
const runView = z.object({ results: z.array(z.object({ imageVersionId: z.string(), kind: z.string(), verdict: z.string().optional(), feedbackContext: z.record(z.string(), z.json()).optional(), reviewQueueReasons: z.array(z.string()) })) })
type Fixture = Awaited<ReturnType<typeof serviceFixture>>

async function prepare(f: Fixture) {
  const style = idSchema.parse(await f.action('style-create', { operationId: 'style', name: 'Frozen green' }))
  const upload = { name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }
  await f.action('reference-import', { operationId: 'reference', styleId: style.id, expectedRevision: 1, files: [upload] })
  const candidate = idSchema.parse(await f.action('candidate-create', { operationId: 'candidate', styleId: style.id, expectedRevision: 2 }))
  const release = idSchema.parse(await f.action('release-publish', { operationId: 'publish', styleId: style.id, expectedRevision: 3, candidateId: candidate.id }))
  await f.action('default-set', { operationId: 'default', styleId: style.id, expectedRevision: 4, releaseId: release.id })
  const usage = idSchema.parse(await f.action('usage-create', { operationId: 'usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
  return { style, release, usage, upload }
}

test('editing references and the default during a blocked search keeps its source and crop reviews on the original release', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let unblock!: () => void
  const released = new Promise<void>(resolve => { unblock = resolve })
  try {
    const { style, release, usage, upload } = await prepare(f)
    const frozen = f.domain.require('release', release.id)
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { entered = resolve })
    const request = f.http.request.bind(f.http)
    let first = true
    f.http.request = async (url, input) => {
      if (first && url.startsWith('https://vision.example.test')) { first = false; entered(); await released }
      return request(url, input)
    }
    const started = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'search', releaseId: release.id, usageRevisionId: usage.id, taskBrief: 'Green subject.', sourceId: 'images', targetCount: 1 }))
    await blocked
    await f.action('reference-import', { operationId: 'new-reference', styleId: style.id, expectedRevision: 5, files: [{ ...upload, role: 'negative', intent: 'dimensions', dimensions: ['composition'] }] })
    const next = idSchema.parse(await f.action('candidate-create', { operationId: 'next-candidate', styleId: style.id, expectedRevision: 6 }))
    const published = idSchema.parse(await f.action('release-publish', { operationId: 'next-release', styleId: style.id, expectedRevision: 7, candidateId: next.id }))
    await f.action('default-set', { operationId: 'next-default', styleId: style.id, expectedRevision: 8, releaseId: published.id })
    unblock(); await f.jobs.drain()
    const run = f.domain.require('run', started.runId)
    assert.equal(run.outcome, 'target-met')
    assert.deepEqual(specOf(run).fixed.release, frozen)
    assert.equal(f.domain.require('style', style.id).defaultReleaseId, published.id)
    assert.equal(f.domain.require('release', published.id).references.length, 2)
    assert.ok(f.repository.list('assessment').filter(item => item.runId === run.id).every(item => item.releaseId === release.id))
    assert.ok(f.repository.list('cropCandidate').filter(item => item.runId === run.id).every(item => item.releaseId === release.id))
  } finally { unblock(); await f.cleanup() }
})

test('review queue preserves frozen ordinary sampling, flags new unconfirmed families and tracks revised human disagreement', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { release, usage } = await prepare(f)
    f.service.config.limits.reviewSampleRate = 1
    f.http.image = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#607060' } }).png().toBuffer()
    const started = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'sample', releaseId: release.id, usageRevisionId: usage.id, taskBrief: 'New green subject.', sourceId: 'images', targetCount: 1 }))
    f.service.config.limits.reviewSampleRate = 0
    await f.jobs.drain()
    const first = runView.parse(await f.action('run-get', { runId: started.runId }))
    const image = first.results.find(item => item.kind === 'crop')
    assert.ok(image?.feedbackContext)
    assert.equal(image.verdict, 'pass')
    assert.ok(image.reviewQueueReasons.includes('ordinary-sample'))
    assert.ok(image.reviewQueueReasons.includes('new-source-group'))
    await f.action('feedback-confirm', { operationId: 'human-reject', subject: { kind: 'image', imageVersionId: image.imageVersionId }, context: image.feedbackContext, judgment: { kind: 'style-verdict', value: 'reject' }, scope: 'style-candidate', expectedHead: null, viewEvidence: [{ imageVersionId: image.imageVersionId, versionKind: 'crop' }] })
    const after = runView.parse(await f.action('run-get', { runId: started.runId })).results.find(item => item.imageVersionId === image.imageVersionId)
    assert.ok(after)
    assert.ok(after.reviewQueueReasons.includes('human-model-disagreement'))
    assert.deepEqual(after.reviewQueueReasons, runView.parse(await f.action('run-get', { runId: started.runId })).results.find(item => item.imageVersionId === image.imageVersionId)?.reviewQueueReasons)
  } finally { await f.cleanup() }
})

test('invalid model output enters technical review without manufacturing a style rejection', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { release, usage } = await prepare(f)
    f.http.mode = 'bad-json'
    const started = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'invalid-model', releaseId: release.id, usageRevisionId: usage.id, taskBrief: 'Green subject.', sourceId: 'images', targetCount: 1 }))
    await f.jobs.drain()
    const images = runView.parse(await f.action('run-get', { runId: started.runId })).results
    assert.ok(images.some(image => image.reviewQueueReasons.includes('technical-failed')))
    assert.ok(images.every(image => image.verdict !== 'reject'))
  } finally { await f.cleanup() }
})
