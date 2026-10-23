import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CuratorDomain, DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/index.ts'
import { recipeSchema, type DomainActor, type Rule } from '../src/shared/model.ts'
import { dataOf } from '../src/host/runtime.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const identified = z.object({ id: z.string() })
type Fixture = Awaited<ReturnType<typeof serviceFixture>>

async function importedStyle(fixture: Fixture, operationId: string, role: 'positive' | 'negative' | 'undecided') {
  const style = identified.parse(await fixture.action('style-create', { operationId: `${operationId}:style`, name: operationId }))
  const result = z.object({ results: z.array(z.object({ imageVersionId: z.string() })) }).parse(await fixture.action('reference-import', {
    operationId: `${operationId}:import`, styleId: style.id, expectedRevision: 1,
    files: [{ name: 'reference.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role, intent: 'overall', dimensions: [] }],
  }))
  const imageVersionId = result.results[0]?.imageVersionId
  assert.ok(imageVersionId)
  return { styleId: style.id, imageVersionId }
}

async function publish(fixture: Fixture, styleId: string, operationId: string) {
  const candidate = identified.parse(await fixture.action('candidate-create', { operationId: `${operationId}:candidate`, styleId, expectedRevision: fixture.domain.require('style', styleId).revision }))
  return identified.parse(await fixture.action('release-publish', { operationId: `${operationId}:publish`, styleId, candidateId: candidate.id, expectedRevision: fixture.domain.require('style', styleId).revision }))
}

test('the same imported blob keeps independent opposite roles and supervision in two styles', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const positive = await importedStyle(fixture, 'positive-style', 'positive')
    const negative = await importedStyle(fixture, 'negative-style', 'negative')
    const firstImage = fixture.domain.require('imageVersion', positive.imageVersionId)
    const secondImage = fixture.domain.require('imageVersion', negative.imageVersionId)
    assert.equal(firstImage.blob.digest, secondImage.blob.digest)
    assert.notEqual(firstImage.id, secondImage.id)
    const references = fixture.repository.list('reference')
    const first = references.find(reference => reference.styleId === positive.styleId)
    const second = references.find(reference => reference.styleId === negative.styleId)
    assert.ok(first); assert.ok(second)
    assert.equal(first.role, 'positive'); assert.equal(second.role, 'negative')
    assert.deepEqual(fixture.domain.referenceJudgments(first).map(feedback => feedback.judgment), [{ kind: 'style-verdict', value: 'accept' }])
    assert.deepEqual(fixture.domain.referenceJudgments(second).map(feedback => feedback.judgment), [{ kind: 'style-verdict', value: 'reject' }])
    assert.deepEqual(fixture.domain.require('draft', fixture.domain.require('style', positive.styleId).draftId).referenceIds, [first.id])
    assert.deepEqual(fixture.domain.require('draft', fixture.domain.require('style', negative.styleId).draftId).referenceIds, [second.id])
  } finally { await fixture.cleanup() }
})

test('publication retries after its dependency writes but failed manifest without exposing a release or changing the old default', async () => {
  const profileId = 'publication-profile', now = '2026-10-23T00:00:00.000Z'
  const actor: DomainActor = { kind: 'human', id: 'owner', profileId }
  const adapter = new MemoryDomainAdapter(), repository = new DomainRepository(profileId, adapter)
  const domain = new CuratorDomain(profileId, repository, { now: () => now })
  const recipe = recipeSchema.parse({ schemaVersion: 1, kind: 'recipe', id: 'recipe', profileId, createdAt: now, visionRevision: 'fixture-v1', model: 'fixture', vendorVersion: 'fixture-v1', promptVersion: '1', outputSchemaVersion: '1', preprocessingVersion: '1', referenceStrategy: { maxImages: 4, maxBytes: 1000 }, preferenceScale: { min: 0, max: 1, weights: { color: 1 } }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
  const style = await domain.createStyle({ operationId: 'create', name: 'Published style' }, actor)
  const firstCandidate = await domain.createCandidate({ operationId: 'first-candidate', styleId: style.id, expectedRevision: 1, recipe }, actor)
  const firstRelease = await domain.publishStyle({ operationId: 'first-publish', styleId: style.id, expectedRevision: 2, candidateId: firstCandidate.id }, actor)
  await domain.setDefault({ operationId: 'default', styleId: style.id, expectedRevision: 3, releaseId: firstRelease.id }, actor)
  const nextCandidate = await domain.createCandidate({ operationId: 'next-candidate', styleId: style.id, expectedRevision: 4, recipeId: recipe.id }, actor)
  const command = { operationId: 'next-publish', styleId: style.id, expectedRevision: 5, candidateId: nextCandidate.id }
  const before = domain.require('style', style.id)
  adapter.failNextManifest = true
  await assert.rejects(domain.publishStyle(command, actor), { code: 'storage-commit-failed' })
  assert.ok([...adapter.records.values()].some(record => record.kind === 'release' && record.releaseNumber === 2), 'the release dependency must have reached storage before the injected manifest failure')
  assert.deepEqual(repository.list('release'), [firstRelease])
  assert.deepEqual(domain.require('style', style.id), before)
  const recoveredRepository = new DomainRepository(profileId, adapter)
  const recovered = new CuratorDomain(profileId, recoveredRepository, { now: () => now })
  assert.deepEqual(recovered.require('style', style.id), before)
  const released = await recovered.publishStyle(command, actor)
  assert.deepEqual(await recovered.publishStyle(command, actor), released)
  const after = recovered.require('style', style.id)
  assert.equal(released.releaseNumber, 2)
  assert.equal(after.nextReleaseNumber, 3)
  assert.equal(after.defaultReleaseId, firstRelease.id)
  assert.deepEqual(after.committedReleaseIds, [firstRelease.id, released.id])
  assert.equal(recoveredRepository.list('release').length, 2)
})

test('color acceptance and composition rejection retain separate heads while task-only judgments stay out of classification exports', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const imported = await importedStyle(fixture, 'dimensional-style', 'undecided')
    const release = await publish(fixture, imported.styleId, 'dimensional-release')
    const context = { styleId: imported.styleId, standard: { kind: 'release', releaseId: release.id }, usage: { kind: 'none' }, taskBriefDigest: contentDigest('') }
    const judgments = [{ dimension: 'color', value: 'accept', scope: 'style-candidate' }, { dimension: 'composition', value: 'reject', scope: 'style-candidate' }, { dimension: 'lighting', value: 'accept', scope: 'task-only' }]
    const feedback = []
    for (const judgment of judgments) {
      const saved = identified.parse(await fixture.action('feedback-confirm', { operationId: `feedback-${judgment.dimension}`, subject: { kind: 'image', imageVersionId: imported.imageVersionId }, context, judgment: { kind: 'dimension-verdict', dimension: judgment.dimension, value: judgment.value }, scope: judgment.scope, expectedHead: null, viewEvidence: [{ imageVersionId: imported.imageVersionId, versionKind: 'normalized' }] }))
      feedback.push(fixture.domain.require('feedback', saved.id))
    }
    assert.equal(new Set(feedback.map(item => item.threadId)).size, 3)
    for (const item of feedback) assert.equal(fixture.domain.require('feedbackThread', item.threadId).headFeedbackId, item.id)
    assert.equal(feedback[2]?.labelEligibility, 'none')
    const image = fixture.domain.require('imageVersion', imported.imageVersionId), asset = fixture.domain.require('asset', image.assetId)
    const split = identified.parse(await fixture.action('split-create', { operationId: 'split', assignments: [{ familyId: asset.familyId, split: 'learning', groupingConfirmed: true }] }))
    const started = z.object({ runId: z.string() }).parse(await fixture.action('export-start', { operationId: 'dimension-export', kind: 'classification', purpose: 'training', releaseId: release.id, splitId: split.id, mode: 'references-only' }))
    await fixture.jobs.drain()
    const run = fixture.domain.require('run', started.runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run)))
    const snapshot = fixture.domain.require('export', dataOf(run).resultIds[0] ?? '')
    assert.deepEqual([...snapshot.feedbackIds].sort(), feedback.slice(0, 2).map(item => item.id).sort())
    const file = snapshot.files.find(file => file.name === 'classification.jsonl')
    assert.ok(file)
    const rows = file.content.trim().split('\n').map(line => z.object({ judgment: z.object({ kind: z.literal('dimension-verdict'), dimension: z.string(), value: z.string() }) }).parse(JSON.parse(line)))
    assert.deepEqual(rows.map(row => `${row.judgment.dimension}:${row.judgment.value}`).sort(), ['color:accept', 'composition:reject'])
    assert.equal(fixture.http.operations.length, 0)
  } finally { await fixture.cleanup() }
})

test('draft standards and impossible required output rules reject search before any external request or job', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const style = identified.parse(await fixture.action('style-create', { operationId: 'style', name: 'Output standard' }))
    const usage = identified.parse(await fixture.action('usage-create', { operationId: 'usage', name: 'Small square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const urls: string[] = [], original = fixture.http.request.bind(fixture.http)
    fixture.http.request = async (url, input) => { urls.push(url); return await original(url, input) }
    const search = { operationId: 'draft-search', releaseId: fixture.domain.require('style', style.id).draftId, usageRevisionId: usage.id, taskBrief: 'Subject.', sourceId: 'images', targetCount: 1 }
    await assert.rejects(fixture.action('search-start', search), { code: 'reference-unavailable' })
    const rule: Rule = { ruleId: 'minimum-width', dimension: 'composition', statement: 'The final image must be at least 200 pixels wide.', strength: 'required', stage: 'final', condition: {}, exceptions: [], supportRefs: [], counterRefs: [], check: { kind: 'measured', field: 'width', unit: 'pixels', min: 200, tolerance: 0 }, confirmation: { status: 'confirmed', actor: { kind: 'authenticated-human', id: fixture.actor.id, confirmationMethod: 'client-action', confirmedAt: new Date().toISOString() } } }
    await fixture.domain.saveDraft({ operationId: 'measured-rule', styleId: style.id, expectedRevision: 1, rules: [rule], referenceIds: [], feedbackIds: [], conflicts: [] }, fixture.actor)
    const release = await publish(fixture, style.id, 'measured-release')
    await assert.rejects(fixture.action('search-start', { ...search, operationId: 'conflicting-output', releaseId: release.id }), { code: 'constraint-conflict' })
    assert.deepEqual(urls, [])
    assert.equal(fixture.jobs.hooks.length, 0)
    assert.equal(fixture.repository.list('run').length, 0)
  } finally { await fixture.cleanup() }
})

test('an authorized byte export downloads verified resources and identical retries while a missing blob prevents publication', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const style = identified.parse(await fixture.action('style-create', { operationId: 'authorized-style', name: 'Authorized export' }))
    await fixture.action('reference-import', { operationId: 'authorized-import', styleId: style.id, expectedRevision: 1, bytesAllowed: true,
      files: [{ name: 'reference.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const release = await publish(fixture, style.id, 'authorized-release')
    const reference = fixture.repository.list('reference')[0]!
    const image = fixture.domain.require('imageVersion', reference.imageVersionId)
    const familyId = fixture.domain.require('asset', image.assetId).familyId
    const split = identified.parse(await fixture.action('split-create', { operationId: 'authorized-split', assignments: [{ familyId, split: 'learning', groupingConfirmed: true }] }))
    const args = { operationId: 'authorized-export', kind: 'style', purpose: 'training', releaseId: release.id, splitId: split.id, mode: 'with-bytes' }
    const started = z.object({ runId: z.string() }).parse(await fixture.action('export-start', args))
    await fixture.jobs.drain()
    assert.equal(fixture.domain.require('run', started.runId).status, 'completed')
    const snapshot = fixture.repository.list('export')[0]!
    const request = () => new Request(`https://owner.example/api/visual-curator/resource?exportId=${snapshot.id}`)
    const response = await fixture.service.resource(request())
    assert.equal(response.status, 200)
    const firstBody = await response.text()
    const payload = z.object({ files: z.array(z.object({ name: z.string(), content: z.string(), checksum: z.string() })), resources: z.array(z.object({ digest: z.string(), base64: z.string() })) }).parse(JSON.parse(firstBody))
    assert.ok(payload.resources.length > 0)
    for (const file of payload.files) assert.equal(file.checksum, `sha256-v1:${createHash('sha256').update(file.content, 'utf8').digest('hex')}`)
    for (const resource of payload.resources) assert.equal(resource.digest, createHash('sha256').update(Buffer.from(resource.base64, 'base64')).digest('hex'))
    assert.equal(await (await fixture.service.resource(request())).text(), firstBody, 'repeat downloads retain exact envelope fields and order')
    assert.equal(z.object({ runId: z.string() }).parse(await fixture.action('export-start', args)).runId, started.runId)
    assert.equal(fixture.jobs.hooks.length, 1)
    assert.equal(fixture.http.operations.length, 0)
    await rm(join(fixture.root, 'visual-curator', image.blob.storageRef))
    await assert.rejects(fixture.domain.createExport({ operationId: 'missing-byte-export', exportKind: 'style', purpose: 'training', releaseId: release.id, splitId: split.id, mode: 'with-bytes' }, fixture.actor))
    assert.equal(fixture.repository.list('export').length, 1)
  } finally { await fixture.cleanup() }
})
