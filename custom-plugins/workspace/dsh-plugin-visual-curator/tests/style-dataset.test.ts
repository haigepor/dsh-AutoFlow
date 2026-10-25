import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf } from '../src/host/runtime.ts'
import { styleAnalysisSchema } from '../src/shared/style-analysis.ts'
import { fileChecksum } from '../src/domain/repository.ts'
import { createCuratorStore } from '../src/client/store.ts'
import { draftArgs, exportStyleDataset, publishStyle, suggestedRules, resultId } from '../src/client/workbench-actions.ts'

const identity = z.object({ id: z.string() })
const handle = z.object({ runId: z.string() })
async function imported(f: Awaited<ReturnType<typeof serviceFixture>>, count = 1) {
  const style = identity.parse(await f.action('style-create', { name: 'Local style', operationId: 'create' }))
  const files = []
  for (let index = 0; index < count; index++) {
    const bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: index * 10, g: 100, b: 50 } } }).png().toBuffer()
    files.push({ name: `local-${index}.png`, mime: 'image/png', base64: bytes.toString('base64'), role: index === count - 1 && count > 1 ? 'negative' : 'positive', intent: 'overall', dimensions: [] })
  }
  await f.action('reference-import', { operationId: 'import', styleId: style.id, expectedRevision: 1, files })
  return style.id
}

test('local API analysis summarizes every batch and exports traceable machine observations beside confirmed rules', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = await imported(f, 10)
    const args = { styleId, operationId: 'dataset-analysis', buildDataset: true }
    const started = handle.parse(await f.action('reference-analyze', args)); await f.jobs.drain()
    const run = f.domain.require('run', started.runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run).error))
    assert.deepEqual(f.http.operations, ['analyze:', 'analyze:', 'summarize:'])
    const analysis = styleAnalysisSchema.parse(dataOf(run).checkpoint.styleAnalysis)
    assert.equal(analysis.samples.length, 10)
    assert.equal(JSON.parse(f.http.summaryInputs[0]!).samples.length, 10)
    assert.equal(f.repository.list('suggestion').length, 1)
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).rules.length, 0)
    const snapshot = z.object({ styles: z.array(z.object({ analysis: z.object({ runId: z.string(), stale: z.boolean(), samples: z.array(z.unknown()) }) })) }).parse(await f.action('snapshot'))
    assert.equal(snapshot.styles[0]?.analysis.stale, false)
    assert.equal(snapshot.styles[0]?.analysis.samples.length, 10)
    assert.equal(handle.parse(await f.action('reference-analyze', args)).runId, started.runId)
    assert.equal(f.http.operations.length, 3)
    const draft = f.domain.require('draft', f.domain.require('style', styleId).draftId)
    await f.action('draft-save', { operationId: 'confirm', styleId, expectedRevision: 2, referenceIds: draft.referenceIds, feedbackIds: draft.feedbackIds, conflicts: [], rules: [{ ruleId: 'human-green', statement: 'Prefer muted green.', dimension: 'color', strength: 'preferred', stage: 'source', confirmed: true, condition: '', exceptions: [], supportRefs: draft.referenceIds, counterRefs: [] }] })
    const candidate = identity.parse(await f.action('candidate-create', { operationId: 'candidate', styleId, expectedRevision: 3 }))
    const release = identity.parse(await f.action('style-publish', { operationId: 'publish', styleId, expectedRevision: 4, candidateId: candidate.id }))
    const split = identity.parse(await f.action('split-create', { operationId: 'groups', assignments: f.repository.list('asset').map(asset => ({ familyId: asset.familyId, split: 'learning', groupingConfirmed: true })) }))
    const exportHandle = handle.parse(await f.action('export-start', { operationId: 'export', kind: 'style', purpose: 'reference', releaseId: release.id, splitId: split.id, analysisRunId: run.id })); await f.jobs.drain()
    assert.equal(f.domain.require('run', exportHandle.runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', exportHandle.runId)).error))
    const exp = f.repository.list('export')[0]!
    const content = (name: string) => exp.files.find(file => file.name === name)!.content
    assert.equal(content('samples.jsonl').trim().split('\n').length, 10)
    const profile = JSON.parse(content('style-profile.json'))
    assert.equal(profile.analysisRunId, run.id)
    assert.equal(profile.confirmedRules[0].ruleId, 'human-green')
    assert.equal(profile.modelSummary.status, 'unconfirmed')
    const rows = content('samples.jsonl').trim().split('\n').map(line => JSON.parse(line))
    const expected = JSON.parse(await readFile(new URL('./fixtures/style-dataset.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ formatVersion: profile.formatVersion, purpose: profile.purpose, modelSummaryStatus: profile.modelSummary.status, model: profile.model, declaredModelVersion: profile.declaredModelVersion, validationStatus: profile.validation.status,
      files: exp.files.map(file => file.name), sampleCount: rows.length, sampleSources: [...new Set(rows.map(row => row.source))], roleCounts: { positive: rows.filter(row => row.importIntent.role === 'positive').length, negative: rows.filter(row => row.importIntent.role === 'negative').length },
      measuredWidthMethod: rows[0].measured.find((row: { field: string }) => row.field === 'width').method, observationDimensions: rows[0].inferred.map((row: { field: string }) => row.field), resourceCount: exp.resources.length, exportMode: exp.mode }, expected)
    assert.ok(content('references.json').includes(analysis.samples[0]!.reference.imageVersionId))
    assert.ok(!JSON.stringify(exp.files).includes('base64'))
    const download = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?exportId=${exp.id}`))
    assert.equal(download.status, 200)
    assert.ok((await download.text()).includes('samples.jsonl'))
    for (const file of exp.files) assert.equal(fileChecksum(file.content), file.checksum)
    await assert.rejects(f.service.action({ operation: 'reference-analyze', args: { styleId, operationId: 'agent-cannot-label', buildDataset: true } }, { kind: 'agent', id: 'other', profileId: f.profileId, sessionId: 'unrelated' }, new AbortController().signal), { code: 'owner-denied' })
    const current = f.domain.require('style', styleId)
    await f.action('reference-import', { operationId: 'later-import', styleId, expectedRevision: current.revision, files: [{ name: 'new.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const stale = z.object({ styles: z.array(z.object({ analysis: z.object({ stale: z.boolean() }) })) }).parse(await f.action('snapshot'))
    assert.equal(stale.styles[0]?.analysis.stale, true)
    const candidate2 = identity.parse(await f.action('candidate-create', { operationId: 'candidate2', styleId, expectedRevision: current.revision + 1 }))
    const release2 = identity.parse(await f.action('style-publish', { operationId: 'publish2', styleId, expectedRevision: current.revision + 2, candidateId: candidate2.id }))
    await assert.rejects(f.domain.createExport({ operationId: 'mixed-version', exportKind: 'style', purpose: 'reference', releaseId: release2.id, splitId: split.id, analysisRunId: run.id }, f.actor), { code: 'revision-conflict' })
    await assert.rejects(f.domain.createExport({ operationId: 'not-human-training', exportKind: 'classification', purpose: 'training', releaseId: release.id, splitId: split.id, analysisRunId: run.id }, f.actor), { code: 'constraint-conflict' })
    await assert.rejects(f.domain.createExport({ operationId: 'unauthorized-bytes', exportKind: 'style', purpose: 'reference', releaseId: release.id, splitId: split.id, analysisRunId: run.id, mode: 'with-bytes' }, f.actor), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('workbench confirms API suggestions and grouping before exporting a dataset, even when previews are paginated', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const styleId = await imported(f)
    await store.execute('reference-analyze', { styleId, operationId: 'ui-analysis', buildDataset: true }); await f.jobs.drain(); await store.reload()
    let snapshot = store.getSnapshot().snapshot!, style = snapshot.styles.find(item => item.styleId === styleId)!
    await assert.rejects(exportStyleDataset(store, style, '', true), /dataset-not-ready/)
    const suggestions = suggestedRules({ ...snapshot, images: [] }, style)
    assert.equal(suggestions.length, 1)
    await store.execute('draft-save', draftArgs(style, suggestions))
    style = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    await publishStyle(store, style)
    snapshot = store.getSnapshot().snapshot!; style = snapshot.styles.find(item => item.styleId === styleId)!
    await assert.rejects(exportStyleDataset(store, style, '', false), /grouping-required/)
    const runId = await exportStyleDataset(store, style, '', true); await f.jobs.drain(); await store.reload()
    assert.equal(f.domain.require('run', runId).status, 'completed')
    const exported = store.getSnapshot().snapshot!.exports.find(item => item.analysisRunId === style.analysis!.runId)!
    assert.equal(exported.releaseId, style.releases.at(-1)!.id)
    assert.ok(f.repository.list('export')[0]!.files.some(file => file.name === 'style-profile.json'))
    assert.match(exported.downloadPath!, /^\/api\/visual-curator\/resource\?exportId=/)
    assert.equal(resultId({ id: exported.exportId }), f.repository.list('export')[0]!.id)
  } finally { store.dispose(); await f.cleanup() }
})

test('exhausted API budget retains per-image observations without claiming a complete style dataset', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = await imported(f)
    f.service.config.limits.maxVisionCalls = 1
    const { runId } = handle.parse(await f.action('reference-analyze', { styleId, operationId: 'limited', buildDataset: true })); await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.outcome, 'budget-exhausted')
    assert.equal(dataOf(run).counts.observed, 1)
    assert.equal(dataOf(run).checkpoint.styleAnalysis, undefined)
    assert.equal(f.repository.list('observation').length, 1)
    assert.equal(f.repository.list('export').length, 0)
    const snapshot = z.object({ styles: z.array(z.object({ analysis: z.object({ outcome: z.string(), summary: z.unknown().optional() }) })) }).parse(await f.action('snapshot'))
    assert.equal(snapshot.styles[0]!.analysis.outcome, 'budget-exhausted')
    assert.equal(snapshot.styles[0]!.analysis.summary, undefined)
  } finally { await f.cleanup() }
})

for (const mode of ['foreign-summary-evidence', 'incomplete-analysis'] as const) test(`dataset rejects ${mode} without publishing a complete profile`, async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = await imported(f); f.http.mode = mode
    const { runId } = handle.parse(await f.action('reference-analyze', { styleId, operationId: mode, buildDataset: true })); await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.status, 'failed')
    assert.equal(dataOf(run).error?.code, 'vision-invalid-output')
    assert.equal(dataOf(run).checkpoint.styleAnalysis, undefined)
    assert.equal(f.repository.list('suggestion').length, 0)
  } finally { await f.cleanup() }
})
