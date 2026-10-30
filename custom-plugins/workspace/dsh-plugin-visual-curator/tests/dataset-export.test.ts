import { test } from 'node:test'
import assert from 'node:assert/strict'
import { datasetProgressSchema, datasetListSchema, datasetDetailSchema } from '../src/shared/datasets.ts'
import type { DatasetProgress } from '../src/shared/datasets.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { z } from 'zod'
import { ModelProfiles } from '../src/domain/model-profile.ts'
import { fileChecksum } from '../src/domain/repository.ts'
import { readFile } from 'node:fs/promises'
import { RunEngine, dataOf } from '../src/host/runtime.ts'
import { listDatasets, readDataset } from '../src/host/datasets.ts'
import { profileExportSchema } from '../src/shared/model.ts'
import sharp from 'sharp'

async function recognized(f: Awaited<ReturnType<typeof serviceFixture>>, sampleCount = 1) {
  const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'dataset-style', name: 'Dataset collection' }))
  const files = await Promise.all(Array.from({ length: sampleCount }, async (_, index) => ({ name: `reference-${index}.png`, mime: 'image/png', base64: index ? (await sharp(f.http.image).tint('#625353').png().toBuffer()).toString('base64') : f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
  await f.action('reference-import', { operationId: 'dataset-images', styleId: style.id, expectedRevision: 1, files })
  await f.action('reference-analyze', { operationId: 'dataset-analysis', styleId: style.id, buildDataset: true }); await f.jobs.drain()
  const profile = f.repository.list('modelProfile')[0]
  assert.ok(profile)
  return profile
}

test('dataset progress separates unknown totals from measured zero and rejects inconsistent counters', () => {
  assert.deepEqual(datasetProgressSchema.parse({ phase: 'saving', completed: 0, total: 0, unit: 'items' }), { phase: 'saving', completed: 0, total: 0, unit: 'items' })
  assert.equal(datasetProgressSchema.parse({ phase: 'files', completed: 0, total: 5, unit: 'files' }).total, 5)
  assert.equal(datasetProgressSchema.safeParse({ phase: 'samples', completed: 11, total: 10, unit: 'samples' }).success, false)
  assert.equal(datasetProgressSchema.safeParse({ phase: 'saving', completed: 1, total: 0, unit: 'items' }).success, false)
})

test('dataset reads join a completed task with its immutable package and bound file previews', async () => {
  const f = await serviceFixture(undefined, { maxExportPreviewChars: 64 }); await f.service.initialize()
  try {
    const profile = await recognized(f)
    await f.action('export-start', { operationId: 'listed-export', kind: 'style', purpose: 'reference', releaseId: profile.id, mode: 'references-only' }); await f.jobs.drain()
    const list = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId }))
    assert.equal(list.total, 1)
    const entry = list.entries[0]!
    assert.ok(entry.runId && entry.exportId)
    assert.equal(entry.status, 'completed')
    assert.equal(entry.profileRevision, profile.revision)
    assert.equal(entry.counts.files, 5)
    assert.equal(entry.counts.references, 1)
    assert.deepEqual(entry.progress, { phase: 'saving', completed: 1, total: 1, unit: 'items' })
    const detail = datasetDetailSchema.parse(await f.action('dataset-get', { id: entry.id }))
    assert.equal(detail.samples.length, 1)
    assert.equal(detail.files.length, 5)
    assert.deepEqual({ state: entry.status, counts: entry.counts, ruleSelections: detail.rules.map(rule => ({ enabled: rule.enabled, confirmed: rule.confirmed, source: rule.source })), files: detail.files.map(file => file.name), resources: detail.resources }, JSON.parse(await readFile(new URL('./fixtures/dataset-workspace.expected.json', import.meta.url), 'utf8')))
    assert.ok(detail.files.every(file => file.verified && file.preview.length <= 64))
    assert.ok(detail.files.some(file => file.truncated))
    const rule = profile.options[0]!
    await f.action('profile-save', { operationId: 'listed-profile-edit', styleId: profile.styleId, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: rule.rule.ruleId, enabled: false }] })
    const historical = datasetDetailSchema.parse(await f.action('dataset-get', { id: entry.id }))
    assert.equal(historical.entry.modelProfileId, profile.id)
    assert.equal(historical.rules.find(item => item.id === rule.rule.ruleId)?.enabled, rule.enabled)
    const unmatched = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId, query: 'not-present' }))
    assert.equal(unmatched.total, 0)
    assert.equal(unmatched.allTotal, 1)
  } finally { await f.cleanup() }
})

test('dataset pages bind their cursor to filters and frozen samples paginate independently', async () => {
  const f = await serviceFixture(undefined, { pageSize: 1 }); await f.service.initialize()
  try {
    const profile = await recognized(f, 2)
    for (const operationId of ['page-export-a', 'page-export-b']) await new ModelProfiles(f.domain).export(profile, operationId, f.actor)
    const first = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId }))
    assert.equal(first.total, 2); assert.equal(first.entries.length, 1); assert.ok(first.nextPageToken)
    const second = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId, pageToken: first.nextPageToken }))
    assert.equal(second.entries.length, 1); assert.notEqual(second.entries[0]?.id, first.entries[0]?.id)
    await assert.rejects(f.action('datasets-list', { styleId: profile.styleId, query: 'changed', pageToken: first.nextPageToken }), { code: 'invalid-input' })
    const detail = datasetDetailSchema.parse(await f.action('dataset-get', { id: first.entries[0]!.id }))
    assert.equal(detail.sampleTotal, 2); assert.equal(detail.samples.length, 1); assert.ok(detail.nextSamplePageToken)
    const next = datasetDetailSchema.parse(await f.action('dataset-get', { id: detail.entry.id, pageToken: detail.nextSamplePageToken }))
    assert.notEqual(detail.samples[0]?.referenceId, next.samples[0]?.referenceId)
    await assert.rejects(f.action('dataset-get', { id: second.entries[0]!.id, pageToken: detail.nextSamplePageToken }), { code: 'invalid-input' })
  } finally { await f.cleanup() }
})

test('dataset metadata and files remain owner-scoped, including private packages without task rows', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), engine = new RunEngine(f.repository, f.jobs), privateActor = { ...f.actor, sessionId: 'private-session' }
    const artifact = await new ModelProfiles(f.domain).export(profile, 'private-dataset', privateActor)
    assert.equal(listDatasets(f.domain, engine, f.actor, { styleId: profile.styleId }, 10).total, 0)
    const privateList = listDatasets(f.domain, engine, privateActor, { styleId: profile.styleId }, 10)
    assert.equal(privateList.total, 1)
    assert.equal(readDataset(f.domain, engine, privateActor, { id: privateList.entries[0]!.id }, { pageSize: 10, maxExportPreviewChars: 64 }).files.length, 5)
    await assert.rejects(f.action('dataset-get', { id: artifact.id }), { code: 'owner-denied' })
    await assert.rejects(f.service.action({ operation: 'datasets-list', args: { styleId: profile.styleId } }, { ...f.actor, profileId: 'foreign-profile' }, new AbortController().signal), { code: 'owner-denied' })
    assert.equal((await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?exportId=${artifact.id}`))).status, 403)
    const response = await f.service.data(new Request('https://owner.example/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'datasets-list', args: { styleId: profile.styleId } }) }))
    assert.equal(response.status, 200)
    assert.equal(datasetListSchema.parse(z.object({ value: z.json() }).parse(await response.json()).value).total, 0)
  } finally { await f.cleanup() }
})

test('a committed package joins its run even if the final run checkpoint failed', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), commit = f.repository.commit.bind(f.repository)
    let fail = true
    f.repository.commit = async input => {
      if (fail && input.records.some(record => record.kind === 'run' && dataOf(record).resultIds.some(id => id.startsWith('profile-export-')))) { fail = false; throw new Error('checkpoint storage failed after package commit') }
      return commit(input)
    }
    await f.action('export-start', { operationId: 'orphan-checkpoint', kind: 'style', purpose: 'reference', releaseId: profile.id }); await f.jobs.drain()
    const list = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId }))
    assert.equal(list.total, 1)
    assert.equal(list.entries[0]?.status, 'completed')
    assert.equal(list.entries[0]?.error, undefined)
    assert.ok(list.entries[0]?.runId && list.entries[0]?.exportId)
    assert.equal(datasetDetailSchema.parse(await f.action('dataset-get', { id: list.entries[0]!.id })).files.length, 5)
  } finally { await f.cleanup() }
})

test('persisted file checksum mismatches reject detail reads instead of presenting verified files', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), saved = await new ModelProfiles(f.domain).export(profile, 'valid-files', f.actor)
    const corrupted = profileExportSchema.parse({ ...saved, id: 'invalid-file-checksum', files: saved.files.map((file, index) => index ? file : { ...file, content: file.content + 'changed' }) })
    await f.repository.commit({ aggregateId: 'invalid-file-checksum', expectedRevision: 0, operationId: 'invalid-file-checksum', request: {}, records: [corrupted], state: {} })
    await assert.rejects(f.action('dataset-get', { id: corrupted.id }), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})

test('profile package progress follows verified references, serialized samples and checksummed files', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), progress: DatasetProgress[] = []
    const saved = await new ModelProfiles(f.domain).export(profile, 'progress-export', f.actor, { progress: async (value: DatasetProgress) => { progress.push(value) } })
    assert.deepEqual([...new Set(progress.map(value => value.phase))], ['verifying', 'samples', 'files', 'saving'])
    assert.ok(progress.some(value => value.phase === 'verifying' && value.completed === 1 && value.total === 1))
    assert.ok(progress.some(value => value.phase === 'samples' && value.completed === 1 && value.total === 1))
    assert.ok(progress.some(value => value.phase === 'files' && value.completed === 5 && value.total === 5))
    assert.equal(saved.files.length, 5)
    assert.ok(saved.files.every(file => fileChecksum(file.content) === file.checksum))
    const controller = new AbortController(); controller.abort(new Error('export stopped'))
    await assert.rejects(new ModelProfiles(f.domain).export(profile, 'aborted-export', f.actor, { signal: controller.signal }), /export stopped/)
    assert.equal(f.repository.list('profileExport').length, 1)
  } finally { await f.cleanup() }
})
