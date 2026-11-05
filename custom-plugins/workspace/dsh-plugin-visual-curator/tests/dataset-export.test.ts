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
import { styleSummarySchema } from '../src/shared/style-analysis.ts'
import sharp from 'sharp'

async function recognized(f: Awaited<ReturnType<typeof serviceFixture>>, sampleCount = 1, negativeCount = 0) {
  const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'dataset-style', name: 'Dataset collection' }))
  const files = await Promise.all(Array.from({ length: sampleCount }, async (_, index) => ({ name: `reference-${index}.png`, mime: 'image/png', base64: index ? (await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: index * 20, g: 100, b: 50 } } }).png().toBuffer()).toString('base64') : f.http.image.toString('base64'), role: index >= sampleCount - negativeCount ? 'negative' : 'positive', intent: 'overall', dimensions: [] })))
  await f.action('reference-import', { operationId: 'dataset-images', styleId: style.id, expectedRevision: 1, files })
  await f.action('reference-analyze', { operationId: 'dataset-analysis', styleId: style.id, buildDataset: true }); await f.jobs.drain()
  const profile = f.repository.list('modelProfile')[0]
  assert.ok(profile)
  return profile
}

test('revised human roles agree across saved membership, list counts and sample filters while older packages remain frozen', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const first = await recognized(f, 2, 1), prior = f.repository.list('profileExport')[0]!
    const accepted = f.repository.list('feedback').find(item => item.judgment.kind === 'style-verdict' && item.judgment.value === 'accept')!
    await f.domain.action('feedback-confirm', { operationId: 'revise-to-negative', subject: accepted.subject, context: accepted.context, judgment: { kind: 'style-verdict', value: 'reject' }, viewEvidence: accepted.viewEvidence, scope: 'style-candidate', expectedHead: accepted.id, comment: 'The subject is obscured.' }, f.actor)
    const plan = z.object({ digest: z.string() }).parse(await f.action('reference-state', { styleId: first.styleId }))
    await f.action('reference-analyze', { operationId: 'revised-analysis', styleId: first.styleId, buildDataset: true, planDigest: plan.digest }); await f.jobs.drain()
    const profile = f.repository.list('modelProfile').sort((a, b) => b.revision - a.revision)[0]!
    const saved = await new ModelProfiles(f.domain).export(profile, 'revised-negative-package', f.actor, { sampleScope: 'negative' })
    const list = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId, query: saved.id }))
    assert.equal(list.entries[0]!.counts.references, 2); assert.equal(list.entries[0]!.counts.negative, 2); assert.equal(list.entries[0]!.counts.positive, 0)
    const detail = datasetDetailSchema.parse(await f.action('dataset-get', { id: saved.id, sampleRole: 'negative' }))
    assert.equal(detail.sampleTotal, 2); assert.ok(detail.samples.every(sample => sample.role === 'negative'))
    assert.ok(detail.samples.some(sample => sample.importedRole === 'positive' && sample.reasons?.some(reason => reason.source === 'human' && reason.text === 'The subject is obscured.')))
    const original = datasetDetailSchema.parse(await f.action('dataset-get', { id: prior.id, sampleRole: 'positive' }))
    assert.equal(original.sampleTotal, 1)
  } finally { await f.cleanup() }
})

test('equivalent export requests reuse one package and preserve scope-bound retry receipts', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), original = f.repository.list('profileExport')[0]!, profiles = new ModelProfiles(f.domain)
    const first = await profiles.export(profile, 'same-content-first', f.actor)
    const second = await profiles.export(profile, 'same-content-second', f.actor)
    assert.equal(first.id, original.id); assert.equal(second.id, original.id); assert.equal(f.repository.list('profileExport').length, 1)
    await assert.rejects(profiles.export(profile, 'same-content-first', f.actor, { sampleScope: 'positive' }), { code: 'operation-conflict' })
    assert.equal((await profiles.export(profile, 'same-content-first', f.actor)).id, original.id)
  } finally { await f.cleanup() }
})

test('concurrent equivalent exports publish one immutable package with independent retry receipts', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), profiles = new ModelProfiles(f.domain)
    const [first, second] = await Promise.all([
      profiles.export(profile, 'concurrent-positive-a', f.actor, { sampleScope: 'positive' }),
      profiles.export(profile, 'concurrent-positive-b', f.actor, { sampleScope: 'positive' }),
    ])
    assert.equal(first.id, second.id)
    assert.equal(f.repository.list('profileExport').filter(record => record.sampleScope === 'positive').length, 1)
    assert.equal((await profiles.export(profile, 'concurrent-positive-b', f.actor, { sampleScope: 'positive' })).id, first.id)
  } finally { await f.cleanup() }
})

test('identical historical packages collapse in version lists while every saved export remains readable', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), original = f.repository.list('profileExport')[0]!
    const copy = profileExportSchema.parse({ ...original, id: 'historical-identical-export', createdAt: '2099-01-01T00:00:00.000Z' })
    await f.repository.commit({ aggregateId: copy.id, expectedRevision: 0, operationId: copy.id, request: {}, records: [copy], state: {} })
    const list = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId }))
    assert.equal(list.total, 1); assert.equal(list.versionTotal, 1); assert.equal(list.exportTotal, 2)
    assert.equal(list.entries[0]!.duplicateExports?.length, 2)
    for (const id of [original.id, copy.id]) {
      const detail = datasetDetailSchema.parse(await f.action('dataset-get', { id }))
      assert.equal(detail.sampleTotal, 1); assert.equal(detail.files.length, 5)
    }
    assert.equal(f.domain.require('profileExport', original.id).files[0]!.checksum, original.files[0]!.checksum)
  } finally { await f.cleanup() }
})

test('model organization generates scoped uncertain reasons without creating new human labels', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f, 4, 2), packageRecord = f.repository.list('profileExport')[0]!
    const detail = datasetDetailSchema.parse(await f.action('dataset-get', { id: packageRecord.id, sampleRole: 'negative' }))
    assert.equal(detail.sampleTotal, 2)
    assert.ok(detail.samples.every(sample => sample.reasons?.some(reason => reason.source === 'model' && reason.dimension === 'composition' && reason.uncertain)))
    assert.equal(f.repository.list('feedback').length, 4)
    assert.equal(f.domain.require('run', profile.analysisRunId).status, 'completed')
    assert.equal(f.http.operations.filter(operation => operation.startsWith('summarize')).length, 1)
  } finally { await f.cleanup() }
})

test('reference-only notes do not inflate matching-rule totals or version changes', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const request = f.http.request.bind(f.http)
  f.http.request = async (url, input) => {
    const response = await request(url, input)
    if (!f.http.operations.at(-1)?.startsWith('summarize') || !url.startsWith('https://vision.example.test')) return response
    const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string() })) }).parse(JSON.parse(Buffer.from(response.bytes).toString('utf8')))
    const summary = styleSummarySchema.parse(JSON.parse(envelope.choices[0]!.message.content))
    assert.ok(summary.organization)
    const first = summary.suggestedRules[0]; assert.ok(first)
    summary.suggestedRules.push({ ...first, statement: 'Keep reference guidance separate from matching.', strength: 'reference-only' })
    summary.organization.selections.push({ ruleIndex: 1, enabled: false, groupId: null, reason: 'Reference guidance only.' })
    envelope.choices[0]!.message.content = JSON.stringify(summary)
    return { ...response, bytes: Buffer.from(JSON.stringify(envelope)) }
  }
  try {
    const profile = await recognized(f), note = profile.options.find(option => option.rule.strength === 'reference-only')!
    const changed = z.object({ id: z.string() }).parse(await f.action('profile-save', { operationId: 'enable-note', styleId: profile.styleId, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: note.rule.ruleId, enabled: true }] }))
    const saved = await new ModelProfiles(f.domain).export(f.domain.require('modelProfile', changed.id), 'with-note', f.actor)
    const entry = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId, query: saved.id })).entries[0]!
    assert.equal(entry.counts.rules, 1); assert.equal(entry.counts.candidates, 1); assert.equal(entry.counts.referenceNotes, 1)
    assert.equal(entry.changes?.notesOnly, true); assert.equal(entry.changes?.rulesAdded, 0)
  } finally { await f.cleanup() }
})

test('dataset progress separates unknown totals from measured zero and rejects inconsistent counters', () => {
  assert.deepEqual(datasetProgressSchema.parse({ phase: 'saving', completed: 0, total: 0, unit: 'items' }), { phase: 'saving', completed: 0, total: 0, unit: 'items' })
  assert.equal(datasetProgressSchema.parse({ phase: 'files', completed: 0, total: 5, unit: 'files' }).total, 5)
  assert.equal(datasetProgressSchema.safeParse({ phase: 'samples', completed: 11, total: 10, unit: 'samples' }).success, false)
  assert.equal(datasetProgressSchema.safeParse({ phase: 'saving', completed: 1, total: 0, unit: 'items' }).success, false)
})

test('role-filtered packages retain only selected references and observations without executable style rules', async () => {
  const f = await serviceFixture(undefined, { pageSize: 1 }); await f.service.initialize()
  try {
    const profile = await recognized(f, 4, 2), calls = f.http.operations.length
    for (const sampleScope of ['positive', 'negative'] as const) {
      const { runId } = z.object({ runId: z.string() }).parse(await f.action('export-start', { operationId: `scope-${sampleScope}`, kind: 'style', purpose: 'reference', releaseId: profile.id, sampleScope }))
      await f.jobs.drain()
      assert.equal(f.domain.require('run', runId).status, 'completed')
      const saved = f.repository.list('profileExport').find(record => record.sampleScope === sampleScope)!
      const file = (name: string) => saved.files.find(file => file.name === name)!.content
      const rows = file('samples.jsonl').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(rows.length, 2)
      assert.ok(rows.every(row => row.importIntent.role === sampleScope && row.inferred.length > 0 && row.requestIds.length > 0))
      const metadata = JSON.parse(file('style-profile.json'))
      assert.equal(metadata.purpose, 'api-reference-observations')
      assert.deepEqual(metadata.activeRules, [])
      assert.deepEqual(metadata.ruleSelections, [])
      assert.equal(metadata.matchingPrompt, '')
      assert.equal(saved.resources.length, 2)
      assert.ok(JSON.parse(file('references.json')).references.every((row: { reference: { role: string } }) => row.reference.role === sampleScope))
      for (const file of saved.files) assert.equal(fileChecksum(file.content), file.checksum)
      const entry = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId, query: saved.id })).entries[0]!
      assert.equal(entry.sampleScope, sampleScope)
      assert.equal(entry.counts[sampleScope], 2)
      assert.equal(entry.counts[sampleScope === 'positive' ? 'negative' : 'positive'], 0)
      assert.equal(entry.counts.rules, 0)
      const response = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?exportId=${saved.id}`))
      const download = z.object({ files: z.array(z.object({ name: z.string(), content: z.string() })) }).parse(await response.json())
      assert.equal(download.files.find(file => file.name === 'samples.jsonl')!.content, file('samples.jsonl'))
    }
    assert.equal(f.http.operations.length, calls, 'Generating observations must not invoke the model again')
    const reusable = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId, reusableOnly: true }))
    assert.equal(reusable.total, 1, 'Analysis automatically saves the full package; role-only packages remain excluded')
    assert.ok(reusable.entries.every(entry => entry.sampleScope === 'all'))
  } finally { await f.cleanup() }
})

test('a negative-only collection exports observations without requiring adopted style rules', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f, 2, 2)
    assert.equal(profile.rules.length, 0)
    await assert.rejects(f.action('export-start', { operationId: 'negative-full', kind: 'style', purpose: 'reference', releaseId: profile.id }), { code: 'constraint-conflict' })
    await assert.rejects(f.action('export-start', { operationId: 'empty-positive', kind: 'style', purpose: 'reference', releaseId: profile.id, sampleScope: 'positive' }), { code: 'constraint-conflict' })
    await f.action('export-start', { operationId: 'negative-observations', kind: 'style', purpose: 'reference', releaseId: profile.id, sampleScope: 'negative' }); await f.jobs.drain()
    const saved = f.repository.list('profileExport').find(item => item.sampleScope === 'negative')!
    assert.equal(saved.sampleScope, 'negative')
    assert.equal(saved.resources.length, 2)
    await assert.rejects(new ModelProfiles(f.domain).export(profile, 'negative-observations:export', f.actor, { sampleScope: 'positive' }), { code: 'operation-conflict' })
  } finally { await f.cleanup() }
})

test('sample role filters apply before pagination and cannot reuse a different filter cursor', async () => {
  const f = await serviceFixture(undefined, { pageSize: 1 }); await f.service.initialize()
  try {
    const profile = await recognized(f, 4, 2), saved = await new ModelProfiles(f.domain).export(profile, 'mixed-filter', f.actor)
    const first = datasetDetailSchema.parse(await f.action('dataset-get', { id: saved.id, sampleRole: 'negative' }))
    assert.equal(first.sampleTotal, 2)
    assert.equal(first.samples.length, 1)
    assert.equal(first.samples[0]!.role, 'negative')
    assert.ok(first.nextSamplePageToken)
    const next = datasetDetailSchema.parse(await f.action('dataset-get', { id: saved.id, sampleRole: 'negative', pageToken: first.nextSamplePageToken }))
    assert.equal(next.samples[0]!.role, 'negative')
    assert.notEqual(next.samples[0]!.referenceId, first.samples[0]!.referenceId)
    assert.equal(next.nextSamplePageToken, undefined)
    await assert.rejects(f.action('dataset-get', { id: saved.id, sampleRole: 'positive', pageToken: first.nextSamplePageToken }), { code: 'invalid-input' })
  } finally { await f.cleanup() }
})

test('dataset reads join a completed task with its immutable package and bound file previews', async () => {
  const f = await serviceFixture(undefined, { maxExportPreviewChars: 64 }); await f.service.initialize()
  try {
    const profile = await recognized(f)
    await f.action('export-start', { operationId: 'listed-export', kind: 'style', purpose: 'reference', releaseId: profile.id, mode: 'references-only' }); await f.jobs.drain()
    const list = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId }))
    assert.equal(list.total, 1)
    const entry = list.entries.find(entry => entry.runId)!
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
    const profile = await recognized(f, 3, 1)
    for (const sampleScope of ['positive', 'negative'] as const) await new ModelProfiles(f.domain).export(profile, `page-export-${sampleScope}`, f.actor, { sampleScope })
    const first = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId }))
    assert.equal(first.total, 3); assert.equal(first.entries.length, 1); assert.ok(first.nextPageToken)
    const second = datasetListSchema.parse(await f.action('datasets-list', { styleId: profile.styleId, pageToken: first.nextPageToken }))
    assert.equal(second.entries.length, 1); assert.notEqual(second.entries[0]?.id, first.entries[0]?.id)
    await assert.rejects(f.action('datasets-list', { styleId: profile.styleId, query: 'changed', pageToken: first.nextPageToken }), { code: 'invalid-input' })
    const detail = datasetDetailSchema.parse(await f.action('dataset-get', { id: first.entries[0]!.id }))
    assert.equal(detail.sampleTotal, 3); assert.equal(detail.samples.length, 1); assert.ok(detail.nextSamplePageToken)
    const next = datasetDetailSchema.parse(await f.action('dataset-get', { id: detail.entry.id, pageToken: detail.nextSamplePageToken }))
    assert.notEqual(detail.samples[0]?.referenceId, next.samples[0]?.referenceId)
    await assert.rejects(f.action('dataset-get', { id: second.entries[0]!.id, pageToken: detail.nextSamplePageToken }), { code: 'invalid-input' })
  } finally { await f.cleanup() }
})

test('dataset metadata and files are shared across Sessions while foreign application profiles remain unavailable', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const profile = await recognized(f), engine = new RunEngine(f.repository, f.jobs), privateActor = { ...f.actor, sessionId: 'private-session' }
    const artifact = await new ModelProfiles(f.domain).export(profile, 'private-dataset', privateActor)
    const publicList = listDatasets(f.domain, engine, f.actor, { styleId: profile.styleId }, 10)
    assert.equal(publicList.total, 1)
    assert.ok(publicList.entries.some(entry => entry.exportId === artifact.id))
    const privateList = listDatasets(f.domain, engine, privateActor, { styleId: profile.styleId }, 10)
    assert.equal(privateList.total, 1)
    const privateEntry = privateList.entries.find(entry => entry.exportId === artifact.id)!
    assert.equal(readDataset(f.domain, engine, privateActor, { id: privateEntry.id }, { pageSize: 10, maxExportPreviewChars: 64 }).files.length, 5)
    assert.equal(datasetDetailSchema.parse(await f.action('dataset-get', { id: artifact.id })).entry.exportId, artifact.id)
    await assert.rejects(f.service.action({ operation: 'datasets-list', args: { styleId: profile.styleId } }, { ...f.actor, profileId: 'foreign-profile' }, new AbortController().signal), { code: 'owner-denied' })
    assert.equal((await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?exportId=${artifact.id}`))).status, 200)
    const response = await f.service.data(new Request('https://owner.example/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'datasets-list', args: { styleId: profile.styleId } }) }))
    assert.equal(response.status, 200)
    const responseList = datasetListSchema.parse(z.object({ value: z.json() }).parse(await response.json()).value)
    assert.equal(responseList.total, 1)
    assert.ok(responseList.entries.some(entry => entry.exportId === artifact.id))
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
    const joined = list.entries.find(entry => entry.runId)!
    assert.equal(joined.status, 'completed')
    assert.equal(joined.error, undefined)
    assert.ok(joined.runId && joined.exportId)
    assert.equal(datasetDetailSchema.parse(await f.action('dataset-get', { id: joined.id })).files.length, 5)
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
    const saved = await new ModelProfiles(f.domain).export(profile, 'progress-export', f.actor, { sampleScope: 'positive', progress: async (value: DatasetProgress) => { progress.push(value) } })
    assert.deepEqual([...new Set(progress.map(value => value.phase))], ['verifying', 'samples', 'files', 'saving'])
    assert.ok(progress.some(value => value.phase === 'verifying' && value.completed === 1 && value.total === 1))
    assert.ok(progress.some(value => value.phase === 'samples' && value.completed === 1 && value.total === 1))
    assert.ok(progress.some(value => value.phase === 'files' && value.completed === 5 && value.total === 5))
    assert.equal(saved.files.length, 5)
    assert.ok(saved.files.every(file => fileChecksum(file.content) === file.checksum))
    const controller = new AbortController(); controller.abort(new Error('export stopped'))
    await assert.rejects(new ModelProfiles(f.domain).export(profile, 'aborted-export', f.actor, { signal: controller.signal }), /export stopped/)
    assert.equal(f.repository.list('profileExport').length, 2)
  } finally { await f.cleanup() }
})
