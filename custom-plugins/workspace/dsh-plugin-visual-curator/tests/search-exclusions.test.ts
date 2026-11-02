import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import sharp from 'sharp'
import { z } from 'zod'
import { CuratorDomain } from '../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { remoteReferenceBlob } from '../src/media/remote-reference.ts'
import { assetSchema, imageVersionSchema, modelProfileSchema, recipeSchema, referenceSnapshotSchema, runSchema, selectionSchema, type DomainActor } from '../src/shared/model.ts'
import { freezeSearchExclusions, imageExclusion, searchHistoryRuns, searchSourceKey, sourceExclusion } from '../src/host/search-exclusions.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { sourceIdentity } from '../src/host/providers.ts'
import { dataOf, toJson } from '../src/host/runtime.ts'

const base = { schemaVersion: 1, profileId: 'exclusion-test', createdAt: '2026-11-02T00:00:00.000Z' }
const actor: DomainActor = { kind: 'human', id: 'owner', profileId: base.profileId }
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'test', model: 'test', vendorVersion: null, promptVersion: 'test', outputSchemaVersion: '1', preprocessingVersion: '1', referenceStrategy: { maxImages: 4, maxBytes: 1000 }, preferenceScale: { min: 0, max: 1, weights: {} }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const profile = modelProfileSchema.parse({ ...base, id: 'profile', kind: 'modelProfile', styleId: 'style', draftId: 'draft', draftRevision: 1, access: { kind: 'profile-library' }, analysisRunId: 'analysis', referenceDigest: `sha256-v1:${'a'.repeat(64)}`, contentDigest: `sha256-v1:${'b'.repeat(64)}`, revision: 1, model: 'test', matchingPrompt: '', rules: [], references: [], recipe, groups: [], options: [] })

test('source identity distinguishes exact providers and photo ids while Unsplash stays stable across account changes', () => {
  const one = { providerId: 'unsplash', providerAssetId: 'photo-a', accountIdentity: 'account-a' }
  assert.equal(searchSourceKey(one), searchSourceKey({ ...one, accountIdentity: 'account-b' }))
  assert.notEqual(searchSourceKey(one), searchSourceKey({ ...one, providerAssetId: 'photo-b' }))
  assert.notEqual(searchSourceKey(one), searchSourceKey({ ...one, providerId: 'other-provider' }))
  const privateSource = { ...one, providerId: 'private-provider' }
  assert.notEqual(searchSourceKey(privateSource), searchSourceKey({ ...privateSource, accountIdentity: 'account-b' }))
})

test('frozen references cover both roles and never treat a remote URL descriptor as a pixel digest', async () => {
  const domain = new CuratorDomain(base.profileId, new DomainRepository(base.profileId, new MemoryDomainAdapter()))
  const source = { kind: 'provider' as const, providerId: 'unsplash', providerAssetId: 'negative-photo', accountIdentity: 'account-a', description: 'Negative', obtainedAt: base.createdAt }
  const negativeAsset = assetSchema.parse({ ...base, id: 'negative-asset', kind: 'asset', familyId: 'negative', source, access: { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
  const blob = remoteReferenceBlob({ providerId: 'unsplash', photoId: source.providerAssetId, accountId: source.accountIdentity, url: 'https://images.unsplash.com/photo-negative?w=900', thumbnailUrl: 'https://images.unsplash.com/photo-negative?w=320' })
  const negative = imageVersionSchema.parse({ ...base, id: 'negative-image', kind: 'imageVersion', assetId: negativeAsset.id, versionKind: 'remote-reference', blob, geometry: { width: 900, height: 600, colorSpace: 'unverified', processorVersion: 'test' } })
  const positiveAsset = assetSchema.parse({ ...negativeAsset, id: 'positive-asset', familyId: 'positive', source: { kind: 'local-import', description: 'Positive pixels' } })
  const positive = imageVersionSchema.parse({ ...negative, id: 'positive-image', assetId: positiveAsset.id, versionKind: 'normalized', blob: { digest: 'c'.repeat(64), byteLength: 10, mime: 'image/png', storageRef: 'blobs/positive' } })
  await domain.repository.commit({ aggregateId: 'images', expectedRevision: 0, operationId: 'images', request: {}, records: [negativeAsset, negative, positiveAsset, positive], state: {} })
  const snapshot = (image: typeof negative, role: 'positive' | 'negative') => referenceSnapshotSchema.parse({ reference: { ...base, id: `reference-${role}`, kind: 'reference', styleId: 'style', imageVersionId: image.id, role, intent: { kind: 'overall' }, context: {}, feedbackThreadIds: [] }, imageDigest: image.blob.digest, familyId: role, feedbackIds: [] })
  const original = modelProfileSchema.parse({ ...profile, references: [snapshot(negative, 'negative'), snapshot(positive, 'positive')] })
  const policy = freezeSearchExclusions(domain, original, actor, [])
  assert.equal(sourceExclusion(policy, { ...source, accountIdentity: 'account-b' }), 'negative-reference')
  assert.equal(policy.digests[blob.digest], undefined)
  assert.equal(policy.digests[positive.blob.digest], 'reference')
  const changed = modelProfileSchema.parse({ ...original, references: [snapshot(positive, 'positive')] })
  assert.equal(Object.keys(freezeSearchExclusions(domain, changed, actor, []).sources).length, 0)
  assert.equal(Object.keys(policy.sources).length, 1, 'A later reference edit must not mutate an accepted policy')
  assert.equal(imageExclusion(policy, positive, positiveAsset), 'reference')
  assert.equal(sourceExclusion(undefined, source), undefined)
})

test('history is collection scoped, ignores nonselected candidates and requires the original image reader', async () => {
  const domain = new CuratorDomain(base.profileId, new DomainRepository(base.profileId, new MemoryDomainAdapter()))
  const asset = assetSchema.parse({ ...base, id: 'private-asset', kind: 'asset', familyId: 'private', source: { kind: 'provider', providerId: 'unsplash', providerAssetId: 'private-photo', accountIdentity: 'private-account', description: 'Private photo', obtainedAt: base.createdAt }, access: { kind: 'session-run', sessionId: 'original-session' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
  const image = imageVersionSchema.parse({ ...base, id: 'private-image', kind: 'imageVersion', assetId: asset.id, versionKind: 'normalized', blob: { digest: 'd'.repeat(64), byteLength: 20, mime: 'image/png', storageRef: 'blobs/private' }, geometry: { width: 100, height: 100, colorSpace: 'srgb', processorVersion: 'test' } })
  const run = runSchema.parse({ ...base, id: 'prior-run', kind: 'run', owner: { kind: 'session', sessionId: 'original-session' }, revision: 1, status: 'completed', stage: 'finalizing', spec: { kind: 'search', fixed: { release: { styleId: 'style' } } }, data: {} })
  const unselected = runSchema.parse({ ...run, id: 'unselected-run' })
  const selected = selectionSchema.parse({ ...base, id: 'selected', kind: 'selection', runId: run.id, imageVersionId: image.id, assessmentId: 'assessment', qualification: 'auto-qualified', rank: 0, warnings: [] })
  await domain.repository.commit({ aggregateId: 'prior', expectedRevision: 0, operationId: 'prior', request: {}, records: [asset, image, run, unselected, selected], state: {} })
  assert.deepEqual(searchHistoryRuns(domain, 'style').map(item => item.id), [run.id])
  assert.deepEqual(searchHistoryRuns(domain, 'other-style'), [])
  assert.throws(() => freezeSearchExclusions(domain, profile, actor, [{ run, actor }]), { code: 'owner-denied' })
  const policy = freezeSearchExclusions(domain, profile, actor, [{ run, actor: { ...actor, sessionId: 'original-session' } }])
  assert.equal(sourceExclusion(policy, { providerId: 'unsplash', providerAssetId: 'private-photo', accountIdentity: 'new-account' }), 'previous-selection')
  assert.equal(policy.digests[image.blob.digest], 'previous-selection')
})

test('the human preparation path may exclude readable collection history while a free Agent cannot acquire another Session’s images', async () => {
  const f = await serviceFixture(), context = new Context(), sessions = new SessionStore(context)
  try {
    await f.service.initialize()
    for (const id of ['private-session', 'agent-session']) sessions.create(SessionId(id), { meta: { cwd: f.root } })
    f.host.sessions.get = id => sessions.get(id)
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'History access' }))
    const reference = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#314f77' } }).png().toBuffer()
    await f.action('reference-import', { operationId: 'reference', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: reference.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'analysis', styleId: style.id, buildDataset: true }); await f.jobs.drain()
    const standard = f.repository.list('modelProfile')[0]!, analysis = f.domain.require('run', standard.analysisRunId), source = sourceIdentity(f.service.config)
    const blob = { digest: createHash('sha256').update(f.http.image).digest('hex'), byteLength: f.http.image.length, mime: 'image/png', storageRef: 'private-history-not-read' }
    const asset = assetSchema.parse({ schemaVersion: 1, profileId: f.profileId, createdAt: base.createdAt, id: 'history-asset', kind: 'asset', familyId: 'history', source: { kind: 'provider', ...source, providerAssetId: 'one', description: 'Prior selection', obtainedAt: base.createdAt }, access: { kind: 'session-run', sessionId: 'private-session' }, originalBlob: blob, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
    const image = imageVersionSchema.parse({ schemaVersion: 1, profileId: f.profileId, createdAt: base.createdAt, id: 'history-image', kind: 'imageVersion', assetId: asset.id, versionKind: 'normalized', blob, geometry: { width: 400, height: 200, colorSpace: 'srgb', processorVersion: 'fixture' } })
    const run = runSchema.parse({ ...analysis, id: 'history-search', owner: { kind: 'session', sessionId: 'private-session' }, status: 'completed', spec: { kind: 'search', config: f.service.config, input: {}, fixed: { release: toJson(standard) }, specDigest: 'history' } })
    const selection = selectionSchema.parse({ schemaVersion: 1, profileId: f.profileId, createdAt: base.createdAt, id: 'history-selection', kind: 'selection', runId: run.id, imageVersionId: image.id, assessmentId: 'history-assessment', qualification: 'auto-qualified', rank: 0, warnings: [] })
    await f.repository.commit({ aggregateId: 'history', expectedRevision: 0, operationId: 'history', request: {}, records: [asset, image, run, selection], state: {} })
    const args = { releaseId: standard.id, sourceId: source.providerId, taskBrief: 'Find a different image.', targetCount: 1, output: { kind: 'original' } }
    const human = z.object({ runId: z.string() }).parse(await f.action('search-start', { ...args, operationId: 'human-search' })); await f.jobs.drain()
    assert.equal(dataOf(f.domain.require('run', human.runId)).counts.excludedPrevious, 1)
    assert.equal(f.repository.list('selection').filter(item => item.runId === human.runId).length, 0)
    const agent = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...args, operationId: 'agent-search' } }, { kind: 'agent', id: 'agent-session', sessionId: 'agent-session', profileId: f.profileId }, new AbortController().signal)); await f.jobs.drain()
    assert.equal(dataOf(f.domain.require('run', agent.runId)).counts.excludedPrevious, 0)
    assert.equal(f.repository.list('selection').filter(item => item.runId === agent.runId).length, 1)
  } finally { await f.cleanup(); await context.fiber.dispose() }
})
