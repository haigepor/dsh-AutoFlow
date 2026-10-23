import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CuratorDomain, DomainRepository, MemoryDomainAdapter, contentDigest, curatorDomainSpecFor,
  acquireProfileWriter, evaluationMetrics, recordSchema, assetSchema, imageVersionSchema, recipeSchema, suggestionSchema, cropCandidateSchema,
  type CommitInput, type DomainActor, type EvaluationRecipe, type Rule,
} from '../src/domain/index.ts'

const now = '2026-10-23T00:00:00.000Z'
const human: DomainActor = { kind: 'human', id: 'human-a', profileId: 'profile-a' }
const agent: DomainActor = { kind: 'agent', id: 'agent-a', profileId: 'profile-a', sessionId: 'session-a' }
const base = { schemaVersion: 1 as const, profileId: 'profile-a', createdAt: now }
function setup() {
  const adapter = new MemoryDomainAdapter()
  const repository = new DomainRepository('profile-a', adapter)
  const domain = new CuratorDomain('profile-a', repository, { now: () => now, verifyImage: async () => {} })
  return { adapter, repository, domain }
}
async function addImage(repository: DomainRepository, name = 'a', sessionId?: string) {
  const asset = assetSchema.parse({ ...base, kind: 'asset', id: `asset-${name}`, familyId: `family-${name}`, source: { kind: 'local-import', description: name }, access: sessionId ? { kind: 'session-run', sessionId } : { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'confirmed' })
  const image = imageVersionSchema.parse({ ...base, kind: 'imageVersion', id: `image-${name}`, assetId: asset.id, versionKind: 'normalized', blob: { digest: 'a'.repeat(64), byteLength: 5, mime: 'image/png', storageRef: `blob-${name}` }, geometry: { width: 2000, height: 2000, colorSpace: 'srgb', processorVersion: 'fixture-1' } })
  await repository.commit({ aggregateId: `media:${name}`, expectedRevision: 0, operationId: `import-${name}`, request: { name }, records: [asset, image], state: { imageId: image.id } })
  return { asset, image }
}
function recipe(): EvaluationRecipe {
  return recipeSchema.parse({ ...base, kind: 'recipe', id: 'recipe-a', visionRevision: 'vision-a', model: 'fixture', vendorVersion: null, promptVersion: 'prompt-1', outputSchemaVersion: 'schema-1', preprocessingVersion: 'image-1', referenceStrategy: { maxImages: 5, maxBytes: 10000 }, preferenceScale: { min: 0, max: 4, weights: { color: 1, lighting: 1, texture: 1, subject: 1, composition: 1, density: 1, depth: 1 } }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
}
function rule(): Rule {
  return { ruleId: 'rule-a', dimension: 'color', statement: 'Keep natural color', condition: {}, strength: 'required', stage: 'final', check: { kind: 'visual', criterion: 'natural colors' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'confirmed', actor: { kind: 'authenticated-human', id: 'human-a', confirmedAt: now, confirmationMethod: 'client-action' } } }
}
async function published(domain: CuratorDomain) {
  const style = await domain.createStyle({ name: 'Natural', operationId: 'style-create' }, human)
  await domain.saveDraft({ styleId: style.id, expectedRevision: style.revision, operationId: 'draft-save', rules: [rule()], referenceIds: [], feedbackIds: [], conflicts: [], recipe: recipe() }, human)
  const candidate = await domain.createCandidate({ styleId: style.id, expectedRevision: 2, operationId: 'candidate-create' }, human)
  const release = await domain.publishStyle({ styleId: style.id, candidateId: candidate.id, expectedRevision: 3, operationId: 'release-publish' }, human)
  return { style: domain.require('style', style.id), candidate, release }
}

describe('aggregate publication', () => {
  it('hides dependencies after a failed manifest and retries exactly once', async () => {
    const { adapter, repository } = setup()
    adapter.failNextManifest = true
    const command: CommitInput = { aggregateId: 'test', expectedRevision: 0, operationId: 'operation-a', request: { name: 'A' }, records: [suggestionSchema.parse({ ...base, kind: 'suggestion', id: 'suggestion-a', status: 'pending', author: { kind: 'agent', sourceId: 'agent-a' }, text: 'A', feedbackIds: [] })], state: { resultId: 'suggestion-a' } }
    await assert.rejects(repository.commit(command), { code: 'storage-commit-failed' })
    assert.deepEqual(repository.list('suggestion'), [])
    const reopened = new DomainRepository('profile-a', adapter)
    assert.deepEqual(reopened.list('suggestion'), [])
    const first = await reopened.commit(command)
    assert.deepEqual(await reopened.commit(command), first)
    assert.equal(reopened.list('suggestion').length, 1)
    await assert.rejects(reopened.commit({ ...command, request: { name: 'B' } }), { code: 'operation-conflict' })
  })
  it('admits only one writer at an expected revision', async () => {
    const { repository } = setup()
    const results = await Promise.allSettled(['a', 'b'].map(operationId => repository.commit({ aggregateId: 'test', expectedRevision: 0, operationId, request: { operationId }, records: [], state: {} })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  })
  it('hashes objects canonically without ignoring array order', () => {
    assert.equal(contentDigest({ a: 1, b: 2 }), contentDigest({ b: 2, a: 1 }))
    assert.notEqual(contentDigest([1, 2]), contentDigest([2, 1]))
    assert.match(curatorDomainSpecFor('profile-a').name, /^[a-z][a-z0-9_]*$/)
    assert.notEqual(curatorDomainSpecFor('profile-a').name, curatorDomainSpecFor('profile-b').name)
  })
  it('rejects cross-profile records, unknown schemas and unknown tagged values', async () => {
    const { repository } = setup()
    const invalid: CommitInput = { aggregateId: 'a', operationId: 'a', expectedRevision: 0, request: {}, records: [suggestionSchema.parse({ ...base, profileId: 'other', kind: 'suggestion', id: 'a', status: 'pending', author: { kind: 'agent', sourceId: 'a' }, text: 'a', feedbackIds: [] })], state: {} }
    await assert.rejects(repository.commit(invalid), { code: 'owner-denied' })
    assert.equal(recordSchema.safeParse({ ...invalid.records[0], profileId: 'profile-a', schemaVersion: 2 }).success, false)
    assert.equal(recordSchema.safeParse({ ...invalid.records[0], profileId: 'profile-a', status: 'invented' }).success, false)
  })
  it('refuses replacing immutable asset ownership while preserving committed bytes', async () => {
    const { repository } = setup()
    const { asset } = await addImage(repository)
    await assert.rejects(repository.commit({ aggregateId: 'media:a', expectedRevision: 1, operationId: 'rewrite-asset', request: {}, records: [{ ...asset, access: { kind: 'session-run', sessionId: 'other' } }], state: {} }), { code: 'constraint-conflict' })
    assert.deepEqual(repository.get('asset', asset.id), asset)
  })
  it('rejects a second profile writer and allows takeover after release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visual-curator-domain-'))
    try {
      const first = await acquireProfileWriter(join(directory, 'writer'))
      await assert.rejects(acquireProfileWriter(join(directory, 'writer')), { code: 'writer-occupied' })
      await first()
      const second = await acquireProfileWriter(join(directory, 'writer'))
      await second()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('style snapshots', () => {
  it('publishes once without selecting a default and preserves old releases after edits', async () => {
    const { domain } = setup()
    const { style, release, candidate } = await published(domain)
    assert.equal(style.defaultReleaseId, null)
    assert.equal(release.releaseNumber, 1)
    assert.equal(release.validation.status, 'provisional')
    const repeated = await domain.publishStyle({ styleId: style.id, candidateId: candidate.id, expectedRevision: 3, operationId: 'release-publish' }, human)
    assert.equal(repeated.id, release.id)
    assert.equal(domain.require('style', style.id).nextReleaseNumber, 2)
    await domain.setDefault({ styleId: style.id, releaseId: release.id, expectedRevision: 4, operationId: 'default' }, human)
    const fixed = domain.resolveRelease(style.id, undefined)
    await domain.saveDraft({ styleId: style.id, expectedRevision: 5, operationId: 'edit', rules: [{ ...rule(), statement: 'New preference' }], referenceIds: [], feedbackIds: [], conflicts: [], recipeId: recipe().id }, human)
    assert.deepEqual(domain.require('release', release.id), fixed)
    await assert.rejects(domain.publishStyle({ styleId: style.id, candidateId: candidate.id, expectedRevision: 6, operationId: 'stale-publish' }, human), { code: 'revision-conflict' })
  })
  it('keeps the previous published list and default after a manifest failure', async () => {
    const { domain, adapter } = setup()
    const { style, release } = await published(domain)
    adapter.failNextManifest = true
    await assert.rejects(domain.setDefault({ styleId: style.id, releaseId: release.id, expectedRevision: 4, operationId: 'default-failure' }, human), { code: 'storage-commit-failed' })
    assert.equal(domain.require('style', style.id).defaultReleaseId, null)
    assert.equal(domain.require('style', style.id).revision, 4)
  })
  it('refuses unconfirmed required rules and invalid output ratios before execution', async () => {
    const { domain } = setup()
    const style = await domain.createStyle({ name: 'A', operationId: 'create' }, human)
    await domain.saveDraft({ styleId: style.id, expectedRevision: 1, operationId: 'save', rules: [{ ...rule(), confirmation: { status: 'suggested' } }], referenceIds: [], feedbackIds: [], conflicts: [], recipe: recipe() }, human)
    await assert.rejects(domain.createCandidate({ styleId: style.id, expectedRevision: 2, operationId: 'candidate' }, human), { code: 'constraint-conflict' })
    await assert.rejects(domain.action('usage-create', { operationId: 'usage', name: 'phone', output: { aspectP: 9, aspectQ: 16, targetWidth: 1000, targetHeight: 1000, acceptedFormats: ['jpeg'], allowUpscale: false }, safeRegions: [], protectedContent: [] }, human), { code: 'invalid-input' })
  })
})

describe('human feedback', () => {
  it('projects only selected intent dimensions and rejects forged human authors', async () => {
    const { domain, repository } = setup()
    const { image } = await addImage(repository)
    const style = await domain.createStyle({ name: 'A', operationId: 'create' }, human)
    const reference = await domain.confirmReference({ styleId: style.id, imageVersionId: image.id, role: 'positive', intent: { kind: 'dimensions', dimensions: ['color'] }, context: {}, viewEvidence: [{ imageVersionId: image.id, versionKind: 'normalized' }], operationId: 'reference' }, human)
    const labels = domain.referenceJudgments(reference)
    assert.equal(labels.length, 1)
    assert.deepEqual(labels[0]?.judgment, { kind: 'dimension-verdict', dimension: 'color', value: 'accept' })
    await assert.rejects(domain.action('feedback-confirm', { actor: { kind: 'human' }, operationId: 'forged' }, agent), { code: 'invalid-input' })
    await assert.rejects(domain.createStyle({ name: 'fake', operationId: 'agent' }, agent), { code: 'owner-denied' })
  })
  it('keeps one effective head, history and immutable operation retries', async () => {
    const { domain, repository, adapter } = setup()
    const { image } = await addImage(repository)
    const { style, release } = await published(domain)
    const context = { styleId: style.id, standard: { kind: 'release' as const, releaseId: release.id }, usage: { kind: 'none' as const }, taskBriefDigest: contentDigest('mountain') }
    const input = { subject: { kind: 'image' as const, imageVersionId: image.id }, context, judgment: { kind: 'style-verdict' as const, value: 'reject' as const }, viewEvidence: [{ imageVersionId: image.id, versionKind: 'normalized' as const }], scope: 'style-candidate' as const, expectedHead: null, operationId: 'initial' }
    const first = await domain.confirmFeedback(input, human)
    adapter.failNextManifest = true
    const revised = { ...input, judgment: { kind: 'style-verdict' as const, value: 'accept' as const }, expectedHead: first.id, operationId: 'revise' }
    await assert.rejects(domain.confirmFeedback(revised, human), { code: 'storage-commit-failed' })
    assert.equal(domain.require('feedbackThread', first.threadId).headFeedbackId, first.id)
    const second = await domain.confirmFeedback(revised, human)
    assert.equal((await domain.confirmFeedback(revised, human)).id, second.id)
    assert.equal(domain.require('feedbackThread', first.threadId).headFeedbackId, second.id)
    const oldJudgment = domain.require('feedback', first.id).judgment
    assert.equal(oldJudgment.kind, 'style-verdict')
    assert.equal(oldJudgment.kind === 'style-verdict' ? oldJudgment.value : undefined, 'reject')
    await assert.rejects(domain.confirmFeedback({ ...revised, operationId: 'concurrent' }, human), { code: 'revision-conflict' })
  })
  it('keeps task relevance out of style supervision and denies another Session’s pixels', async () => {
    const { domain, repository } = setup()
    const { image } = await addImage(repository, 'private', 'session-a')
    assert.throws(() => domain.authorizedImage(image.id, human), { code: 'owner-denied' })
    assert.throws(() => domain.authorizedImage(image.id, { ...agent, sessionId: 'session-b' }), { code: 'owner-denied' })
    const { image: publicImage } = await addImage(repository, 'public')
    const { style, release } = await published(domain)
    const feedback = await domain.confirmFeedback({ operationId: 'not-needed', subject: { kind: 'image', imageVersionId: publicImage.id }, context: { styleId: style.id, standard: { kind: 'release', releaseId: release.id }, usage: { kind: 'none' }, taskBriefDigest: contentDigest('mountain') }, judgment: { kind: 'task-relevance', value: 'not-needed' }, viewEvidence: [{ imageVersionId: publicImage.id, versionKind: 'normalized' }], scope: 'style-candidate', expectedHead: null }, human)
    assert.equal(feedback.labelEligibility, 'none')
  })
})

describe('splits, evaluation and exports', () => {
  it('exports left, right, tie and neither as distinct preferences while excluding unknown and suggestions', async () => {
    const { domain, repository } = setup()
    const left = await addImage(repository, 'left'), right = await addImage(repository, 'right')
    const { style, release } = await published(domain)
    const split = await domain.createSplit({ operationId: 'preferences-split', assignments: [left.asset, right.asset].map(asset => ({ familyId: asset.familyId, split: 'learning', groupingConfirmed: true })) }, human)
    for (const value of ['left', 'right', 'tie', 'neither', 'unknown'] as const) {
      const context = { styleId: style.id, standard: { kind: 'release' as const, releaseId: release.id }, usage: { kind: 'none' as const }, taskBriefDigest: contentDigest(value) }
      const feedback = await domain.confirmFeedback({ operationId: `preference-${value}`, subject: { kind: 'pair', leftImageVersionId: left.image.id, rightImageVersionId: right.image.id, comparisonSubject: 'color' }, context, judgment: { kind: 'pairwise-preference', value }, scope: 'style-candidate', expectedHead: null, viewEvidence: [left.image, right.image].map(image => ({ imageVersionId: image.id, versionKind: 'normalized' })) }, human)
      assert.equal(feedback.labelEligibility, value === 'unknown' ? 'none' : 'confirmed-candidate')
      if (value === 'left') await domain.addSuggestion({ operationId: 'agent-preference', text: 'The right image may fit.', context }, agent)
    }
    const snapshot = await domain.createExport({ operationId: 'preferences-export', exportKind: 'preference', purpose: 'training', releaseId: release.id, splitId: split.id }, { ...human, sessionId: agent.sessionId! })
    const rows = snapshot.files.find(file => file.name === 'preference.jsonl')!.content.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(rows.map(row => row.judgment.value).sort(), ['left', 'neither', 'right', 'tie'])
    assert.equal(snapshot.exclusions['scope-or-confirmation'], 1)
    assert.equal(snapshot.exclusions['agent-or-model-suggestion'], 1)
    assert.equal(snapshot.resources.every(resource => resource.split === 'learning'), true)
  })
  it('exports only explicitly opted-in generated crop confirmations with their actual geometry', async () => {
    const { domain, repository } = setup()
    const { asset, image } = await addImage(repository, 'crop-parent')
    const { style, release } = await published(domain)
    const usage = await domain.createUsage({ operationId: 'crop-usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 1000, targetHeight: 1000, allowUpscale: false, acceptedFormats: ['png'] }, safeRegions: [], protectedContent: [] }, human)
    const rect = { x: 0, y: 0, width: 1000, height: 1000 }
    const derived = imageVersionSchema.parse({ ...image, id: 'crop-derived', versionKind: 'crop', parentImageVersionId: image.id, geometry: { ...image.geometry, width: 1000, height: 1000 } })
    const crop = cropCandidateSchema.parse({ ...base, kind: 'cropCandidate', id: 'crop-candidate', parentImageVersionId: image.id, derivedImageVersionId: derived.id, runId: 'crop-run', releaseId: release.id, usageRevisionId: usage.id, recipeId: release.recipe.id, requestedRect: { x: 0, y: 0, width: 0.5, height: 0.5 }, effectivePixelRect: rect, geometryResult: 'pass', origin: 'human', data: {} })
    await repository.commit({ aggregateId: 'crop-fixture', operationId: 'crop-fixture', expectedRevision: 0, request: {}, records: [derived, crop], state: {} })
    const split = await domain.createSplit({ operationId: 'crop-learning', assignments: [{ familyId: asset.familyId, split: 'learning', groupingConfirmed: true }] }, human)
    const context = { styleId: style.id, standard: { kind: 'release' as const, releaseId: release.id }, usage: { kind: 'revision' as const, usageRevisionId: usage.id }, taskBriefDigest: contentDigest('crop') }
    const input = { operationId: 'crop-human', subject: { kind: 'crop' as const, parentImageVersionId: image.id, imageVersionId: derived.id, candidateId: crop.id, effectivePixelRect: rect }, context, judgment: { kind: 'crop-confirmation' as const, value: 'confirmed' as const, includeInLearning: false }, scope: 'style-candidate' as const, expectedHead: null, viewEvidence: [{ imageVersionId: derived.id, versionKind: 'crop' as const }] }
    const noLearning = await domain.confirmFeedback(input, human)
    const excluded = await domain.createExport({ operationId: 'crop-excluded', exportKind: 'crop', purpose: 'training', releaseId: release.id, splitId: split.id }, human)
    assert.equal(excluded.feedbackIds.length, 0)
    const included = await domain.confirmFeedback({ ...input, operationId: 'crop-learning-opt-in', expectedHead: noLearning.id, judgment: { ...input.judgment, includeInLearning: true } }, human)
    const snapshot = await domain.createExport({ operationId: 'crop-export', exportKind: 'crop', purpose: 'training', releaseId: release.id, splitId: split.id }, human)
    assert.deepEqual(snapshot.feedbackIds, [included.id])
    const row = JSON.parse(snapshot.files.find(file => file.name === 'crop.jsonl')!.content)
    assert.deepEqual(row.subject.effectivePixelRect, rect)
    assert.equal(row.subject.imageVersionId, derived.id)
    await assert.rejects(domain.confirmFeedback({ ...input, operationId: 'false-crop', expectedHead: included.id, subject: { ...input.subject, imageVersionId: image.id } }, human), { code: 'invalid-input' })
    const dev = await domain.createSplit({ operationId: 'crop-development', assignments: [{ familyId: asset.familyId, split: 'development', groupingConfirmed: true }] }, human)
    const training = await domain.createExport({ operationId: 'crop-no-dev-training', exportKind: 'crop', purpose: 'training', releaseId: release.id, splitId: dev.id }, human)
    assert.equal(training.feedbackIds.length, 0)
    assert.equal(training.exclusions['wrong-split'], 2)
  })
  it('keeps holdout protection after omission and retires historical holdout after disclosure', async () => {
    const { domain, repository } = setup()
    const { asset, image } = await addImage(repository)
    const holdout = await domain.createSplit({ operationId: 'holdout', assignments: [{ familyId: asset.familyId, split: 'holdout', groupingConfirmed: true }] }, human)
    await domain.createSplit({ operationId: 'omit', assignments: [], supersedesSplitId: holdout.id }, human)
    assert.throws(() => domain.assertLearningFamily(asset.familyId), { code: 'constraint-conflict' })
    await assert.rejects(domain.createSplit({ operationId: 'silent-learning', assignments: [{ familyId: asset.familyId, split: 'learning', groupingConfirmed: true }] }, human), { code: 'constraint-conflict' })
    await domain.createSplit({ operationId: 'disclose', assignments: [{ familyId: asset.familyId, split: 'development', groupingConfirmed: true }], uses: [{ familyId: asset.familyId, purpose: 'revealed', at: now }] }, human)
    domain.assertLearningFamily(asset.familyId)
    assert.throws(() => domain.assertSplitUsable(holdout), { code: 'constraint-conflict' })
    const { release } = await published(domain)
    await assert.rejects(domain.createExport({ operationId: 'old-holdout-export', exportKind: 'classification', purpose: 'holdout', releaseId: release.id, splitId: holdout.id, imageVersionIds: [image.id] }, human), { code: 'constraint-conflict' })
  })
  it('merges visually related families without changing source records and rejects old split collisions', async () => {
    const { domain, repository } = setup()
    const first = await addImage(repository, 'burst-1'), second = await addImage(repository, 'burst-2')
    const split = await domain.createSplit({ operationId: 'before-merge', assignments: [{ familyId: first.asset.familyId, split: 'learning', groupingConfirmed: true }, { familyId: second.asset.familyId, split: 'holdout', groupingConfirmed: true }] }, human)
    await assert.rejects(domain.action('family-merge', { operationId: 'agent-merge', familyIds: [first.asset.familyId, second.asset.familyId] }, agent), { code: 'owner-denied' })
    await domain.action('family-merge', { operationId: 'merge-burst', familyIds: [first.asset.familyId, second.asset.familyId] }, human)
    const familyId = domain.familyOf(first.asset.familyId)
    assert.equal(domain.familyOf(second.asset.familyId), familyId)
    assert.equal(domain.authorizedImage(second.image.id, human).asset.familyId, familyId)
    assert.equal(domain.isFamilyConfirmed(familyId), true)
    assert.deepEqual(repository.get('asset', first.asset.id), first.asset)
    assert.equal(repository.list('familyGroup')[0]?.confirmedBy.id, human.id)
    assert.throws(() => domain.assertSplitUsable(split), { code: 'constraint-conflict' })
    await assert.rejects(domain.createSplit({ operationId: 'alias-leak', assignments: [{ familyId: first.asset.familyId, split: 'learning', groupingConfirmed: true }, { familyId: second.asset.familyId, split: 'holdout', groupingConfirmed: true }] }, human), { code: 'constraint-conflict' })
  })
  it('confirms family membership with an independent immutable audit record', async () => {
    const { domain, repository } = setup()
    const asset = assetSchema.parse({ ...base, kind: 'asset', id: 'unreviewed-asset', familyId: 'unreviewed-family', source: { kind: 'local-import', description: 'same source' }, access: { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
    await repository.commit({ aggregateId: 'unreviewed', expectedRevision: 0, operationId: 'unreviewed', request: {}, records: [asset], state: {} })
    const assignment = { familyId: asset.familyId, split: 'learning' as const, groupingConfirmed: true as const }
    await assert.rejects(domain.createSplit({ operationId: 'not-confirmed', assignments: [assignment] }, human), { code: 'constraint-conflict' })
    await domain.action('family-confirm', { operationId: 'confirm-family', familyIds: [asset.familyId] }, human)
    const split = await domain.createSplit({ operationId: 'confirmed-split', assignments: [assignment] }, human)
    assert.equal(split.assignments[0]?.familyId, asset.familyId)
    assert.equal(domain.isFamilyConfirmed(asset.familyId), true)
    assert.deepEqual(repository.get('asset', asset.id), asset)
    assert.equal(repository.list('familyConfirmation')[0]?.confirmedBy.id, human.id)
  })
  it('rejects duplicate family assignments and learning with holdout', async () => {
    const { domain, repository } = setup()
    const { asset } = await addImage(repository)
    await assert.rejects(domain.createSplit({ operationId: 'split', assignments: [{ familyId: asset.familyId, split: 'learning', groupingConfirmed: true }, { familyId: asset.familyId, split: 'holdout', groupingConfirmed: true }] }, human), { code: 'constraint-conflict' })
    await assert.rejects(domain.createSplit({ operationId: 'split2', assignments: [{ familyId: asset.familyId, split: 'holdout', groupingConfirmed: true }], uses: [{ familyId: asset.familyId, purpose: 'learning', at: now }] }, human), { code: 'constraint-conflict' })
  })
  it('refuses turning a calibrated learning family into independent holdout data', async () => {
    const { domain, repository } = setup()
    const { asset, image } = await addImage(repository)
    const style = await domain.createStyle({ name: 'Learning', operationId: 'style' }, human)
    const reference = await domain.confirmReference({ operationId: 'reference', styleId: style.id, imageVersionId: image.id, role: 'positive', intent: { kind: 'overall' }, context: {}, viewEvidence: [{ imageVersionId: image.id, versionKind: 'normalized' }] }, human)
    await domain.saveDraft({ operationId: 'draft', styleId: style.id, expectedRevision: 1, rules: [], referenceIds: [reference.id], feedbackIds: [], conflicts: [], recipe: recipe() }, human)
    await domain.createCandidate({ operationId: 'candidate', styleId: style.id, expectedRevision: 2 }, human)
    await assert.rejects(domain.createSplit({ operationId: 'leaking-split', assignments: [{ familyId: asset.familyId, split: 'holdout', groupingConfirmed: true }] }, human), { code: 'constraint-conflict' })
  })
  it('reports unavailable rates for absent labels while retaining technical failures', () => {
    const metrics = evaluationMetrics([{ imageVersionId: 'a', left: 'pass', right: 'technical-failed', cropReviewed: false, calls: 2, elapsedMs: 5 }])
    assert.equal(metrics['left.acceptance']?.status, 'unavailable')
    assert.deepEqual(metrics['right.technicalFailure'], { status: 'available', numerator: 1, denominator: 1, value: 1 })
    assert.equal(metrics['right.acceptance']?.status, 'unavailable')
  })
  it('keeps failed human positives in recall and reports precision', () => {
    const items = [
      { imageVersionId: 'tp', humanLabel: 'accept' as const, left: 'pass' as const, right: 'pass' as const, cropReviewed: false, calls: 1, elapsedMs: 1 },
      { imageVersionId: 'failed-positive', humanLabel: 'accept' as const, left: 'technical-failed' as const, right: 'needs-review' as const, cropReviewed: false, calls: 1, elapsedMs: 1 },
    ]
    const metrics = evaluationMetrics(items)
    assert.deepEqual(metrics['left.acceptance'], { status: 'available', numerator: 1, denominator: 2, value: 0.5 })
    assert.deepEqual(metrics['left.precision'], { status: 'available', numerator: 1, denominator: 1, value: 1 })
  })
  it('retains improving recall and worsening crop damage with their independent denominators', () => {
    const metrics = evaluationMetrics([
      { imageVersionId: 'one', humanLabel: 'accept', left: 'reject', right: 'pass', cropReviewed: true, leftCrop: 'accepted', rightCrop: 'damaged', calls: 4, elapsedMs: 5 },
      { imageVersionId: 'two', humanLabel: 'accept', left: 'pass', right: 'pass', cropReviewed: true, leftCrop: 'accepted', rightCrop: 'accepted', calls: 4, elapsedMs: 5 },
      { imageVersionId: 'uncertain', humanLabel: 'unknown', left: 'needs-review', right: 'needs-review', cropReviewed: true, leftCrop: 'unknown', rightCrop: 'unknown', calls: 4, elapsedMs: 5 },
    ])
    assert.deepEqual(metrics['left.recall'], { status: 'available', numerator: 1, denominator: 2, value: 0.5 })
    assert.deepEqual(metrics['right.recall'], { status: 'available', numerator: 2, denominator: 2, value: 1 })
    assert.deepEqual(metrics['left.cropDamage'], { status: 'available', numerator: 0, denominator: 2, value: 0 })
    assert.deepEqual(metrics['right.cropDamage'], { status: 'available', numerator: 1, denominator: 2, value: 0.5 })
    assert.deepEqual(metrics['right.cropUnknown'], { status: 'available', numerator: 1, denominator: 3, value: 1 / 3 })
  })
  it('freezes feedback heads and checksums and refuses unauthorized byte exports', async () => {
    const { domain, repository } = setup()
    const { image, asset } = await addImage(repository)
    const { style, release } = await published(domain)
    const split = await domain.createSplit({ operationId: 'split', assignments: [{ familyId: asset.familyId, split: 'learning', groupingConfirmed: true }] }, human)
    const input = { operationId: 'first-feedback', subject: { kind: 'image' as const, imageVersionId: image.id }, context: { styleId: style.id, standard: { kind: 'release' as const, releaseId: release.id }, usage: { kind: 'none' as const }, taskBriefDigest: contentDigest('mountain') }, judgment: { kind: 'style-verdict' as const, value: 'reject' as const }, viewEvidence: [{ imageVersionId: image.id, versionKind: 'normalized' as const }], scope: 'style-candidate' as const, expectedHead: null }
    const feedback = await domain.confirmFeedback(input, human)
    const old = await domain.createExport({ operationId: 'export1', exportKind: 'classification', purpose: 'training', releaseId: release.id, splitId: split.id }, human)
    assert.equal(old.feedbackIds[0], feedback.id)
    const revised = await domain.confirmFeedback({ ...input, operationId: 'revise-feedback', expectedHead: feedback.id, judgment: { kind: 'style-verdict', value: 'accept' } }, human)
    const latest = await domain.createExport({ operationId: 'export2', exportKind: 'classification', purpose: 'training', releaseId: release.id, splitId: split.id }, human)
    assert.equal(latest.feedbackIds[0], revised.id)
    assert.deepEqual(domain.require('export', old.id), old)
    assert.notEqual(old.files[0]?.checksum, latest.files[0]?.checksum)
    await assert.rejects(domain.createExport({ operationId: 'bytes', exportKind: 'classification', purpose: 'training', releaseId: release.id, splitId: split.id, mode: 'with-bytes' }, human), { code: 'owner-denied' })
    const skill = await domain.createExport({ operationId: 'skill', exportKind: 'skill', purpose: 'reference', releaseId: release.id, splitId: split.id }, human)
    assert.match(skill.files.find(f => f.name === 'SKILL.md')?.content ?? '', /resources are unavailable/)
    assert.match(skill.files.find(f => f.name === 'SKILL.md')?.content ?? '', /does not activate itself/)
    const agentExport = await domain.createExport({ operationId: 'agent-export', exportKind: 'classification', purpose: 'training', releaseId: release.id, splitId: split.id }, agent)
    assert.equal(agentExport.actor.kind, 'agent')
    assert.equal(agentExport.feedbackIds[0], revised.id)
    assert.deepEqual(agentExport.access, { kind: 'session-run', sessionId: agent.sessionId })
    assert.throws(() => domain.authorizeExport(agentExport, { ...agent, sessionId: 'session-b' }), { code: 'owner-denied' })
    assert.equal(domain.snapshot({ ...agent, sessionId: 'session-b' }).exports.some(item => item.id === agentExport.id), false)
  })
})
