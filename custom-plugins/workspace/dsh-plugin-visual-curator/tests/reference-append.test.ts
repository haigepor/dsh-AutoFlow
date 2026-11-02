/** Incremental imports preserve reference ownership, per-image durability and revision checks. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { CuratorDomain } from '../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { assetSchema, imageVersionSchema, referenceSchema, releaseSchema, type CuratorRecord } from '../src/shared/model.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

async function fixture(prefix = 4) {
  const f = await serviceFixture(); await f.service.initialize()
  const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'append-style', name: 'Append references' }))
  await f.action('reference-import', { operationId: 'append-seed', styleId: style.id, expectedRevision: 1, files: [{ name: 'seed.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  const seed = f.repository.list('reference')[0]!, image = f.domain.require('imageVersion', seed.imageVersionId)
  const images = Array.from({ length: prefix + 3 }, (_, index) => imageVersionSchema.parse({ ...image, id: `append-image-${index}` }))
  const references = images.slice(0, prefix).map((image, index) => referenceSchema.parse({ ...seed, id: `append-prefix-${index}`, imageVersionId: image.id, feedbackThreadIds: [] }))
  await f.repository.commit({ aggregateId: 'append-fixture', expectedRevision: 0, operationId: 'append-fixture', request: {}, records: [...images, ...references], state: {} })
  const current = f.domain.require('style', style.id), draft = f.domain.require('draft', current.draftId)
  await f.domain.saveDraft({ operationId: 'append-prefix', styleId: style.id, expectedRevision: current.revision, rules: draft.rules, referenceIds: references.map(row => row.id), feedbackIds: [], conflicts: [] }, f.actor)
  const additions = []
  for (const [index, image] of images.slice(prefix).entries()) additions.push(await f.domain.confirmReference({ operationId: `append-new-${index}`, styleId: style.id, imageVersionId: image.id, role: index === 1 ? 'negative' : 'positive', intent: { kind: 'overall' }, context: {}, viewEvidence: [{ imageVersionId: image.id, versionKind: image.versionKind }] }, f.actor))
  return { ...f, styleId: style.id, image, references, additions, revision: f.domain.require('style', style.id).revision }
}

test('one import batch authorizes its immutable prefix once and commits every added image independently', async () => {
  const f = await fixture(32), authorize = f.domain.authorizedImage.bind(f.domain), prefix = new Set(f.references.map(reference => reference.imageVersionId))
  let oldChecks = 0, newChecks = 0
  f.domain.authorizedImage = (id, actor) => { if (prefix.has(id)) oldChecks++; else newChecks++; return authorize(id, actor) }
  try {
    const batch = f.domain.beginReferenceAppend(f.styleId, f.revision, f.actor)
    for (const [index, reference] of f.additions.entries()) {
      const result = await batch.append(reference.id, `append-row-${index}`, f.revision + index)
      assert.equal(result.referenceIds.length, 33 + index)
      assert.deepEqual(batch.findByImage(reference.imageVersionId), reference)
    }
    assert.equal(oldChecks, 32); assert.equal(newChecks, 3)
    assert.equal(f.domain.require('style', f.styleId).revision, f.revision + 3)
    assert.equal(f.domain.referenceJudgments(f.additions[1]!).at(0)?.judgment.kind, 'style-verdict')
    assert.equal(f.additions[1]!.role, 'negative')
  } finally { f.domain.authorizedImage = authorize; await f.cleanup() }
})

test('append replay returns its original draft and conflicting reference identities do not write', async () => {
  const f = await fixture()
  try {
    const batch = f.domain.beginReferenceAppend(f.styleId, f.revision, f.actor), first = f.additions[0]!
    const committed = await batch.append(first.id, 'append-once', f.revision)
    assert.deepEqual(await batch.append(first.id, 'append-once', f.revision), committed)
    await assert.rejects(batch.append(f.additions[1]!.id, 'append-once', f.revision), { code: 'operation-conflict' })
    const second = await batch.append(f.additions[1]!.id, 'append-next', f.revision + 1)
    assert.equal(second.referenceIds.length, f.references.length + 2)
    assert.equal(f.domain.require('style', f.styleId).revision, f.revision + 2)
  } finally { await f.cleanup() }
})

test('an appender rejects Agents, other profiles, concurrent removals and archival', async () => {
  const f = await fixture()
  try {
    assert.throws(() => f.domain.beginReferenceAppend(f.styleId, f.revision, { ...f.actor, kind: 'agent' }), { code: 'owner-denied' })
    assert.throws(() => f.domain.beginReferenceAppend(f.styleId, f.revision, { ...f.actor, profileId: 'another-profile' }), { code: 'owner-denied' })
    const batch = f.domain.beginReferenceAppend(f.styleId, f.revision, f.actor), style = f.domain.require('style', f.styleId), draft = f.domain.require('draft', style.draftId)
    await f.domain.saveDraft({ operationId: 'remove-prefix', styleId: style.id, expectedRevision: style.revision, rules: draft.rules, referenceIds: draft.referenceIds.slice(1), feedbackIds: draft.feedbackIds, conflicts: draft.conflicts }, f.actor)
    await assert.rejects(batch.append(f.additions[0]!.id, 'after-removal', f.revision), { code: 'revision-conflict' })
    await assert.rejects(batch.append(f.additions[0]!.id, 'after-removal-latest-revision', f.revision + 1), { code: 'revision-conflict' })
    const current = f.domain.require('style', style.id), active = f.domain.beginReferenceAppend(style.id, current.revision, f.actor)
    await f.domain.archiveStyle({ operationId: 'archive-target', styleId: style.id, expectedRevision: current.revision }, f.actor)
    await assert.rejects(active.append(f.additions[0]!.id, 'after-archive', current.revision), { code: 'revision-conflict' })
    assert.equal(f.domain.require('draft', style.draftId).referenceIds.length, f.references.length - 1)
  } finally { await f.cleanup() }
})

test('a competing edit committed after append validation still wins the revision check', async () => {
  const f = await fixture(), commit = f.repository.commit.bind(f.repository), admitted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const batch = f.domain.beginReferenceAppend(f.styleId, f.revision, f.actor)
    f.repository.commit = async input => { if (input.operationId === 'racing-append') { admitted.resolve(); await release.promise }; return commit(input) }
    const writing = assert.rejects(batch.append(f.additions[0]!.id, 'racing-append', f.revision), { code: 'revision-conflict' })
    await admitted.promise
    const style = f.domain.require('style', f.styleId), draft = f.domain.require('draft', style.draftId)
    await f.domain.saveDraft({ operationId: 'competing-edit', styleId: style.id, expectedRevision: style.revision, rules: draft.rules, referenceIds: [], feedbackIds: draft.feedbackIds, conflicts: draft.conflicts }, f.actor)
    release.resolve(); await writing
    assert.deepEqual(f.domain.require('draft', style.draftId).referenceIds, [])
  } finally { release.resolve(); f.repository.commit = commit; await f.cleanup() }
})

test('private prefix images are checked again with the captured Session actor on every append', async () => {
  const f = await fixture(), actor = { ...f.actor, sessionId: 'append-owner-session' }, authorize = f.domain.authorizedImage.bind(f.domain)
  try {
    const original = f.domain.require('asset', f.image.assetId), asset = assetSchema.parse({ ...original, id: 'private-prefix-asset', access: { kind: 'session-run', sessionId: actor.sessionId } })
    const image = imageVersionSchema.parse({ ...f.image, id: 'private-prefix-image', assetId: asset.id }), reference = referenceSchema.parse({ ...f.references[0]!, id: 'private-prefix-reference', imageVersionId: image.id })
    await f.repository.commit({ aggregateId: 'private-prefix', expectedRevision: 0, operationId: 'private-prefix', request: {}, records: [asset, image, reference], state: {} })
    const style = f.domain.require('style', f.styleId), draft = f.domain.require('draft', style.draftId)
    await f.domain.saveDraft({ operationId: 'private-prefix-link', styleId: style.id, expectedRevision: style.revision, rules: draft.rules, referenceIds: [reference.id], feedbackIds: [], conflicts: [] }, actor)
    let privateChecks = 0, revoked = false
    f.domain.authorizedImage = (id, reader) => { if (id === image.id) { privateChecks++; assert.equal(reader.sessionId, 'append-owner-session'); if (revoked) throw Object.assign(new Error('Permission revoked'), { code: 'owner-denied' }) }; return authorize(id, reader) }
    const revision = f.domain.require('style', f.styleId).revision, batch = f.domain.beginReferenceAppend(f.styleId, revision, actor)
    actor.sessionId = 'another-session'
    await batch.append(f.additions[0]!.id, 'private-first', revision)
    revoked = true
    await assert.rejects(batch.append(f.additions[1]!.id, 'private-second', revision + 1), { code: 'owner-denied' })
    await assert.rejects(batch.append(f.additions[0]!.id, 'private-first', revision), { code: 'owner-denied' })
    assert.throws(() => batch.findByImage(image.id), { code: 'owner-denied' })
    assert.equal(privateChecks, 5)
    assert.equal(f.domain.require('draft', style.draftId).referenceIds.length, 2)
  } finally { f.domain.authorizedImage = authorize; await f.cleanup() }
})

test('missing committed prefix pointers invalidate append without removing checksum checks from real reads', async () => {
  const f = await fixture(), adapter = new MemoryDomainAdapter(), repository = new DomainRepository(f.profileId, adapter), domain = new CuratorDomain(f.profileId, repository)
  try {
    const records: CuratorRecord[] = [...f.repository.list('style'), ...f.repository.list('draft'), ...f.repository.list('reference'), ...f.repository.list('imageVersion'), ...f.repository.list('asset')]
    await repository.commit({ aggregateId: 'append-copy', expectedRevision: 0, operationId: 'append-copy', request: {}, records, state: {} })
    const batch = domain.beginReferenceAppend(f.styleId, f.revision, f.actor), manifest = adapter.commits.get('append-copy')!
    const missing = manifest.records.find(pointer => pointer.id === f.references[0]!.id)!
    manifest.records = manifest.records.filter(pointer => pointer !== missing); adapter.records.delete(missing.key)
    await assert.rejects(batch.append(f.additions[0]!.id, 'missing-prefix', f.revision), { code: 'reference-unavailable' })
    const imagePointer = manifest.records.find(pointer => pointer.kind === 'imageVersion')!
    const image = adapter.records.get(imagePointer.key)!
    adapter.records.set(imagePointer.key, { ...image, createdAt: '2020-01-01T00:00:00.000Z' })
    assert.throws(() => domain.authorizedImage(imagePointer.id, f.actor), { code: 'reference-unavailable' })
  } finally { await repository.close(); await f.cleanup() }
})

test('release pixel checks deduplicate complete blobs within one invocation while retaining every reference progress event', async () => {
  const f = await fixture(), asset = f.domain.require('asset', f.image.assetId), checked: string[] = []
  const domain = new CuratorDomain(f.profileId, f.repository, { verifyImage: async image => { checked.push(image.blob.storageRef) } })
  try {
    const accepted = z.object({ id: z.string() }).parse(await f.action('candidate-create', { operationId: 'verify-candidate', styleId: f.styleId, expectedRevision: f.revision }))
    const source = f.domain.require('candidate', accepted.id)
    const release = releaseSchema.parse({ schemaVersion: 1, profileId: f.profileId, kind: 'release', id: 'verify-release', createdAt: source.createdAt, styleId: source.styleId, draftId: source.draftId, draftRevision: source.draftRevision, rules: source.rules, references: source.references, recipe: source.recipe, contentDigest: source.contentDigest, releaseNumber: 1, candidateSnapshotId: source.id, changeSummary: '', confirmedBy: { kind: 'authenticated-human', id: f.actor.id, confirmationMethod: 'client-action', confirmedAt: source.createdAt }, validation: { status: 'provisional', evaluationIds: [], sampleCount: 0, limitations: [] } })
    const progress: number[] = []
    await domain.verifyRelease(release, f.actor, { verified: async completed => { progress.push(completed) } })
    assert.equal(checked.length, 1); assert.deepEqual(progress, [1, 2, 3, 4])
    await domain.verifyRelease(release, f.actor)
    assert.equal(checked.length, 2, 'another operation must verify pixels again')
    const different = imageVersionSchema.parse({ ...f.image, id: 'different-storage-image', blob: { ...f.image.blob, storageRef: `${f.image.blob.storageRef}-other` } })
    const privateAsset = assetSchema.parse({ ...asset, id: 'private-verify-asset', access: { kind: 'session-run', sessionId: 'foreign-session' } }), privateImage = imageVersionSchema.parse({ ...f.image, id: 'private-verify-image', assetId: privateAsset.id })
    await f.repository.commit({ aggregateId: 'verify-variants', expectedRevision: 0, operationId: 'verify-variants', request: {}, records: [different, privateAsset, privateImage], state: {} })
    const pair = { ...release, references: [release.references[0]!, { ...release.references[1]!, reference: { ...release.references[1]!.reference, imageVersionId: different.id } }] }
    checked.length = 0; await domain.verifyRelease(pair, f.actor); assert.equal(checked.length, 2)
    const forbidden = { ...pair, references: [pair.references[0]!, { ...pair.references[1]!, reference: { ...pair.references[1]!.reference, imageVersionId: privateImage.id } }] }
    await assert.rejects(domain.verifyRelease(forbidden, f.actor), { code: 'owner-denied' })
    const changedDigest = { ...release, references: [release.references[0]!, { ...release.references[1]!, imageDigest: 'changed-digest' }] }
    await assert.rejects(domain.verifyRelease(changedDigest, f.actor), { code: 'reference-unavailable' })
    const lifetime = new AbortController()
    await assert.rejects(domain.verifyRelease(release, f.actor, { signal: lifetime.signal, verified: async () => { lifetime.abort() } }), { name: 'AbortError' })
  } finally { await f.cleanup() }
})
