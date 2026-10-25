import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import sharp from 'sharp'
import { serviceFixture } from './helpers/service-fixture.ts'
import { visionReviewSchema } from '../src/media/index.ts'
import { dataOf, toJson } from '../src/host/runtime.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { assessmentSchema, imageVersionSchema, runSchema, selectionSchema } from '../src/shared/model.ts'

const identity = z.object({ id: z.string() }), taskIdentity = z.object({ runId: z.string() })
const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) })
const promptSchema = z.object({ input: z.object({ operation: z.string(), stage: z.string().optional(), images: z.array(z.object({ imageVersionId: z.string() })) }) })
const responseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) })
const viewSchema = z.object({ results: z.array(z.object({ imageVersionId: z.string(), kind: z.string(), name: z.string() })) })
const expected = z.object({ byPreference: z.array(z.string()), equalScoreIds: z.array(z.string()) }).parse(JSON.parse(await readFile(new URL('./fixtures/search-ranking.expected.json', import.meta.url), 'utf8')))

async function rankedSearch(equalScores: boolean) {
  const f = await serviceFixture()
  const secondImage = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#234799' } }).png().toBuffer()
  const request = f.http.request.bind(f.http)
  f.http.request = async (url, input) => {
    if (url.startsWith('https://source.example.test')) return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ items: ['low', 'high'].map(id => ({ id, previewUrl: `https://images.example.test/${id}`, originalUrl: `https://images.example.test/${id}` })), nextCursor: null })) }
    if (url === 'https://images.example.test/high') return { status: 200, headers: { 'content-type': 'image/png' }, bytes: secondImage }
    const response = await request(url, input)
    if (!url.startsWith('https://vision.example.test')) return response
    const body = requestSchema.parse(JSON.parse(Buffer.from(input.body ?? []).toString('utf8')))
    const content = body.messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(content))
    const prompt = promptSchema.parse(JSON.parse(content[0]?.text ?? '{}')).input
    if (prompt.operation !== 'review' || prompt.stage !== 'final') return response
    const image = f.domain.require('imageVersion', prompt.images[0]!.imageVersionId)
    const asset = f.domain.require('asset', image.assetId)
    const output = responseSchema.parse(JSON.parse(response.bytes.toString('utf8')))
    const review = visionReviewSchema.parse(JSON.parse(output.choices[0]!.message.content))
    const score = equalScores ? 0.5 : asset.source.kind === 'provider' && asset.source.providerAssetId === 'high' ? 0.9 : 0.1
    const revised = { ...review, preferenceScores: review.preferenceScores.map(row => ({ ...row, score })) }
    return { ...response, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(revised) }, finish_reason: 'stop' }] })) }
  }
  await f.service.initialize()
  try {
    const { id: styleId } = identity.parse(await f.action('style-create', { operationId: 'ranking-style', name: 'Ranking fixture' }))
    await f.action('reference-import', { operationId: 'ranking-reference', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'ranking-analysis', styleId, buildDataset: true })
    await f.jobs.drain()
    const profile = f.repository.list('modelProfile')[0]!
    assert.ok(profile)
    const { id: usageRevisionId } = identity.parse(await f.action('usage-create', { operationId: 'ranking-usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const { runId } = taskIdentity.parse(await f.action('search-start', { operationId: 'ranked-search', releaseId: profile.id, usageRevisionId, sourceId: 'images', taskBrief: 'Muted green photographs', queries: ['green'], targetCount: 2 }))
    await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.outcome, 'target-met', JSON.stringify(dataOf(run).error))
    const selections = f.repository.list('selection').filter(selection => selection.runId === runId)
    assert.equal(selections.length, 2)
    // 使用新的固定标识复制实际成图与审核，不覆盖原记录，避免随机 UUID 决定投影回归是否暴露。
    const projectionRunId = 'ranking-projection-run'
    const records = ['low', 'high'].map((name, index) => {
      const selected = selections.find(selection => f.domain.require('asset', f.domain.require('imageVersion', selection.imageVersionId).assetId).source.description === name)!
      assert.ok(selected)
      const originalImage = f.domain.require('imageVersion', selected.imageVersionId)
      const originalAssessment = f.domain.require('assessment', selected.assessmentId)
      const image = imageVersionSchema.parse({ ...originalImage, id: index === 0 ? 'final-z' : 'final-a' })
      const assessment = assessmentSchema.parse({ ...originalAssessment, id: index === 0 ? 'assessment-a' : 'assessment-z', runId: projectionRunId, imageVersionId: image.id })
      const selection = selectionSchema.parse({ ...selected, id: `selection-${index}`, runId: projectionRunId, imageVersionId: image.id, assessmentId: assessment.id })
      return { image, assessment, selection }
    })
    const projectionRun = runSchema.parse({ ...run, id: projectionRunId, data: toJson({ ...dataOf(run), checkpoint: {}, requestIds: [], resultIds: records.map(row => row.selection.id) }) })
    await f.repository.commit({ aggregateId: `run:${projectionRunId}`, expectedRevision: 0, operationId: 'fixed-ranking-projection', request: {}, records: [projectionRun, ...records.flatMap(row => [row.image, row.assessment, row.selection])], state: {} })
    const savedSelections = f.repository.list('selection').filter(selection => selection.runId === projectionRunId)
    return { f, runId: projectionRunId, selections: savedSelections, before: contentDigest(savedSelections), operations: [...f.http.operations] }
  } catch (error) {
    await f.cleanup()
    throw error
  }
}

test('search ranks all qualified final images by the saved preference scale instead of retrieval order', async () => {
  const { f, runId, before, operations } = await rankedSearch(false)
  try {
    const view = viewSchema.parse(await f.action('run-get', { runId }))
    const again = viewSchema.parse(await f.action('run-get', { runId }))
    assert.equal(contentDigest(f.repository.list('selection').filter(selection => selection.runId === runId)), before)
    assert.deepEqual(f.http.operations, operations, 'Ranking saved assessments must not issue model calls')
    assert.deepEqual(view.results.filter(image => image.kind === 'crop').map(image => image.name), expected.byPreference)
    assert.deepEqual(again.results.filter(image => image.kind === 'crop').map(image => image.name), expected.byPreference)
  } finally { await f.cleanup() }
})

test('equally scored final selections and repeated projections use stable image identities to break ties', async () => {
  const { f, runId, before, operations } = await rankedSearch(true)
  try {
    const view = viewSchema.parse(await f.action('run-get', { runId }))
    const again = viewSchema.parse(await f.action('run-get', { runId }))
    assert.equal(contentDigest(f.repository.list('selection').filter(selection => selection.runId === runId)), before)
    assert.deepEqual(f.http.operations, operations, 'Reprojection must use saved final assessments')
    assert.deepEqual(view.results.filter(image => image.kind === 'crop').map(image => image.imageVersionId), expected.equalScoreIds)
    assert.deepEqual(again.results.filter(image => image.kind === 'crop').map(image => image.imageVersionId), expected.equalScoreIds)
  } finally { await f.cleanup() }
})
