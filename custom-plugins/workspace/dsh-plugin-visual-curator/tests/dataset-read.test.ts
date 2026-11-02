/** Package reads reuse verified derivatives while authorization and committed-record integrity stay live. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createDatasetReads, readDataset } from '../src/host/datasets.ts'
import { ModelProfiles } from '../src/domain/model-profile.ts'
import { contentDigest, fileChecksum, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { deleteTaskHistory } from '../src/host/task-history.ts'
import { RunEngine } from '../src/host/runtime.ts'
import { CuratorError } from '../src/shared/errors.ts'
import { exportSchema, profileExportSchema, type ProfileExport } from '../src/shared/model.ts'
import { datasetDetailSchema, datasetListSchema } from '../src/shared/datasets.ts'
import { profileProjectionFixture } from './helpers/profile-projection-fixture.ts'

async function exported(count = 41) {
  const f = await profileProjectionFixture(count)
  try {
    const profile = f.repository.list('modelProfile').find(item => item.styleId === f.styleIds[0])!
    const artifact = await new ModelProfiles(f.domain).export(profile, 'read-package', f.actor)
    return { ...f, profile, artifact }
  } catch (error) { await f.cleanup(); throw error }
}
const sampleLines = (artifact: ProfileExport) => new Set(artifact.files.find(file => file.name === 'samples.jsonl')!.content.trim().split('\n'))
const bundle = (value: unknown): boolean => !!value && typeof value === 'object' && 'formatVersion' in value && value.formatVersion === 2 && 'export' in value && 'files' in value

test('warm sample pages reuse full parsing without listing other packages and reauthorize their image links', async context => {
  const f = await exported(), lines = sampleLines(f.artifact)
  const parsing = context.mock.method(JSON, 'parse'), listing = context.mock.method(f.repository, 'list')
  const parsedSamples = () => parsing.mock.calls.filter(call => typeof call.arguments[0] === 'string' && lines.has(call.arguments[0])).length
  try {
    const first = datasetDetailSchema.parse(await f.action('dataset-get', { id: f.artifact.id }))
    assert.equal(first.samples.length, 20); assert.equal(first.sampleTotal, 41); assert.equal(parsedSamples(), 41)
    const next = datasetDetailSchema.parse(await f.action('dataset-get', { id: f.artifact.id, pageToken: first.nextSamplePageToken! }))
    assert.equal(next.samples.length, 20); assert.notEqual(next.samples[0]?.referenceId, first.samples[0]?.referenceId)
    const negative = datasetDetailSchema.parse(await f.action('dataset-get', { id: f.artifact.id, sampleRole: 'negative' }))
    assert.equal(negative.samples.length, 5); assert.equal(parsedSamples(), 41)
    await f.repository.commit({ aggregateId: 'unrelated-progress', expectedRevision: 0, operationId: 'unrelated-progress', request: {}, state: {}, records: [] })
    await f.action('dataset-get', { id: f.artifact.id }); assert.equal(parsedSamples(), 41)
    assert.ok(listing.mock.calls.every(call => !['profileExport', 'modelProfile', 'run'].includes(call.arguments[0])))
    const authorize = context.mock.method(f.domain, 'authorizedImage', () => { throw new CuratorError('owner-denied', 'fixture-access', 'Fixture image access was revoked.') })
    const revoked = datasetDetailSchema.parse(await f.action('dataset-get', { id: f.artifact.id }))
    assert.equal(authorize.mock.callCount(), 20); assert.equal(parsedSamples(), 41)
    assert.ok(revoked.samples.every(sample => sample.unavailable && !sample.previewPath))
  } finally { await f.cleanup() }
})

test('list size reuse is exact and returned detail mutations cannot modify retained package data', async context => {
  const f = await exported(5), serializing = context.mock.method(JSON, 'stringify')
  const encodedPackages = () => serializing.mock.calls.filter(call => bundle(call.arguments[0])).length
  const cache = createDatasetReads(() => ({ ttlMs: 1000, maxViews: 2, maxBytes: 1024 * 1024 })), engine = new RunEngine(f.repository, f.jobs)
  try {
    const first = datasetListSchema.parse(await f.action('datasets-list', { styleId: f.profile.styleId }))
    assert.equal(encodedPackages(), 1)
    const again = datasetListSchema.parse(await f.action('datasets-list', { styleId: f.profile.styleId }))
    assert.deepEqual(again, first); assert.equal(encodedPackages(), 1)
    const download = await f.service.resource(new Request(`https://fixture.invalid/api/visual-curator/resource?exportId=${f.artifact.id}`))
    assert.equal(first.entries[0]?.byteLength, (await download.arrayBuffer()).byteLength)
    const read = () => readDataset(f.domain, engine, f.actor, { id: f.artifact.id }, { pageSize: 20, maxExportPreviewChars: 64 }, cache)
    const original = read(), observation = structuredClone(original.samples[0]!.observations[0]!.value)
    original.samples[0]!.observations[0]!.value = 'caller mutation'; original.files[0]!.preview = 'caller mutation'; original.resources.total = -1
    assert.notEqual(read().files[0]?.preview, 'caller mutation'); assert.deepEqual(read().samples[0]!.observations[0]!.value, observation)
    assert.equal(read().resources.total, f.artifact.resources.length)
    const files = f.artifact.files.map(file => {
      if (file.name !== 'samples.jsonl') return file
      const rows = file.content.trim().split('\n'), sample = z.object({ inferred: z.array(z.object({ value: z.json() }).passthrough()) }).passthrough().parse(JSON.parse(rows[0]!))
      sample.inferred[0]!.value = { detail: { color: 'blue' }, labels: ['original'] }; rows[0] = JSON.stringify(sample)
      const content = rows.join('\n') + '\n'; return { ...file, content, checksum: fileChecksum(content) }
    })
    const nested = profileExportSchema.parse({ ...f.artifact, id: 'nested-observation-package', files })
    await f.repository.commit({ aggregateId: nested.id, expectedRevision: 0, operationId: nested.id, request: {}, state: {}, records: [nested] })
    const readNested = () => readDataset(f.domain, engine, f.actor, { id: nested.id }, { pageSize: 20, maxExportPreviewChars: 64 }, cache)
    const value = readNested().samples[0]!.observations[0]!.value
    assert.ok(value && typeof value === 'object' && !Array.isArray(value))
    const detail = value.detail, labels = value.labels
    assert.ok(detail && typeof detail === 'object' && !Array.isArray(detail)); assert.ok(Array.isArray(labels))
    detail.color = 'caller mutation'; labels.push('caller mutation')
    assert.deepEqual(readNested().samples[0]!.observations[0]!.value, { detail: { color: 'blue' }, labels: ['original'] })
  } finally { cache.dispose(); await f.cleanup() }
})

test('cache TTL, entry and byte ceilings, disabling and disposal bound retained package parsing', async context => {
  const f = await exported(5), lines = sampleLines(f.artifact), parsing = context.mock.method(JSON, 'parse')
  const copy = profileExportSchema.parse({ ...f.artifact, id: 'read-package-copy' })
  await f.repository.commit({ aggregateId: 'read-copy', expectedRevision: 0, operationId: 'read-copy', request: {}, state: {}, records: [copy] })
  const engine = new RunEngine(f.repository, f.jobs)
  let now = 0
  const cache = createDatasetReads(() => ({ ttlMs: 100, maxViews: 1, maxBytes: 1024 * 1024 }), () => now)
  const count = () => parsing.mock.calls.filter(call => typeof call.arguments[0] === 'string' && lines.has(call.arguments[0])).length
  const read = (id: string, reader = cache) => readDataset(f.domain, engine, f.actor, { id }, { pageSize: 20, maxExportPreviewChars: 64 }, reader)
  try {
    read(f.artifact.id); read(f.artifact.id); assert.equal(count(), 5)
    read(copy.id); read(f.artifact.id); assert.equal(count(), 15)
    now = 101; read(f.artifact.id); assert.equal(count(), 20)
    cache.dispose(); read(f.artifact.id); read(f.artifact.id); assert.equal(count(), 30)
    for (const maxBytes of [0, 1]) {
      const limited = createDatasetReads(() => ({ ttlMs: 100, maxViews: 2, maxBytes }))
      const before = count(); read(f.artifact.id, limited); read(f.artifact.id, limited)
      assert.equal(count(), before + 10); limited.dispose()
    }
    const disabled = createDatasetReads(() => ({ ttlMs: 0, maxViews: 2, maxBytes: 1024 * 1024 }))
    const before = count(); read(f.artifact.id, disabled); read(f.artifact.id, disabled)
    assert.equal(count(), before + 10); disabled.dispose()
  } finally { cache.dispose(); await f.cleanup() }
})

test('immutable packages and their cursors stay distinct while storage tampering cannot hit the cache', async () => {
  const f = await exported()
  try {
    const first = datasetDetailSchema.parse(await f.action('dataset-get', { id: f.artifact.id }))
    const files = f.artifact.files.map(file => {
      if (file.name !== 'samples.jsonl') return file
      const rows = file.content.trim().split('\n'), sample = z.object({ inferred: z.array(z.object({ value: z.json() }).passthrough()) }).passthrough().parse(JSON.parse(rows[0]!))
      sample.inferred[0]!.value = 'updated frozen observation'; rows[0] = JSON.stringify(sample)
      const content = rows.join('\n') + '\n'; return { ...file, content, checksum: fileChecksum(content) }
    })
    const immutable = profileExportSchema.parse({ ...f.artifact, files }), originalAggregate = `profile-export:${f.artifact.id}`
    await assert.rejects(f.repository.commit({ aggregateId: originalAggregate, expectedRevision: f.repository.manifest(originalAggregate)!.revision, operationId: 'replace-immutable', request: {}, state: {}, records: [immutable] }), { code: 'constraint-conflict' })
    const changed = profileExportSchema.parse({ ...immutable, id: 'replacement-package' }), aggregateId = 'replacement-package'
    await f.repository.commit({ aggregateId, expectedRevision: 0, operationId: 'replace-package', request: {}, state: { id: changed.id }, records: [changed] })
    const current = datasetDetailSchema.parse(await f.action('dataset-get', { id: changed.id }))
    assert.equal(current.samples[0]?.observations[0]?.value, 'updated frozen observation')
    await assert.rejects(f.action('dataset-get', { id: changed.id, pageToken: first.nextSamplePageToken! }), { code: 'invalid-input' })
    const adapter: unknown = Reflect.get(f.repository, 'adapter')
    assert.ok(adapter instanceof MemoryDomainAdapter)
    const pointer = f.repository.manifest(aggregateId)!.records.find(record => record.id === changed.id)!
    const tampered = profileExportSchema.parse({ ...changed, files: changed.files.map((file, index) => index ? file : { ...file, content: file.content + 'tampered' }) })
    adapter.records.set(pointer.key, tampered)
    await assert.rejects(f.action('dataset-get', { id: changed.id }), { code: 'reference-unavailable' })
    const manifest = adapter.commits.get(aggregateId)!
    adapter.commits.set(aggregateId, { ...manifest, records: manifest.records.map(record => record.id === changed.id ? { ...record, digest: contentDigest(tampered) } : record) })
    await assert.rejects(f.action('dataset-get', { id: changed.id }), { code: 'reference-unavailable' })
    adapter.records.delete(pointer.key)
    await assert.rejects(f.action('dataset-get', { id: changed.id }), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})

test('artifact and run ids resolve directly while hidden runs and foreign owners remain unavailable', async () => {
  const f = await exported(5), engine = new RunEngine(f.repository, f.jobs)
  try {
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('export-start', { operationId: 'direct-run', kind: 'style', purpose: 'reference', releaseId: f.profile.id }))
    await f.jobs.drain()
    const row = datasetListSchema.parse(await f.action('datasets-list', { styleId: f.profile.styleId })).entries.find(entry => entry.runId === runId)!
    assert.equal(datasetDetailSchema.parse(await f.action('dataset-get', { id: runId })).entry.id, runId)
    assert.equal(datasetDetailSchema.parse(await f.action('dataset-get', { id: row.exportId! })).entry.id, row.exportId)
    await deleteTaskHistory(f.repository, f.domain.require('run', runId), 'hide-dataset-run')
    await assert.rejects(f.action('dataset-get', { id: runId }), { code: 'owner-denied' })
    assert.equal(datasetDetailSchema.parse(await f.action('dataset-get', { id: row.exportId! })).entry.id, row.exportId)
    const privateActor = { ...f.actor, sessionId: 'private-dataset-session' }, privatePackage = await new ModelProfiles(f.domain).export(f.profile, 'private-read', privateActor)
    const cache = createDatasetReads(() => ({ ttlMs: 1000, maxViews: 2, maxBytes: 1024 * 1024 }))
    try {
      readDataset(f.domain, engine, privateActor, { id: privatePackage.id }, { pageSize: 20, maxExportPreviewChars: 64 }, cache)
      assert.throws(() => readDataset(f.domain, engine, f.actor, { id: privatePackage.id }, { pageSize: 20, maxExportPreviewChars: 64 }, cache), { code: 'owner-denied' })
      assert.throws(() => readDataset(f.domain, engine, { ...f.actor, profileId: 'another-profile' }, { id: privatePackage.id }, { pageSize: 20, maxExportPreviewChars: 64 }, cache), { code: 'owner-denied' })
    } finally { cache.dispose() }
  } finally { await f.cleanup() }
})

test('export HEAD authorizes without generating preview or download JSON and GET remains identical', async context => {
  const f = await exported(5), serializing = context.mock.method(JSON, 'stringify')
  const previews = () => serializing.mock.calls.filter(call => { const value: unknown = call.arguments[0]; return !!value && typeof value === 'object' && 'exportId' in value && 'preview' in value }).length
  const packages = () => serializing.mock.calls.filter(call => bundle(call.arguments[0])).length
  try {
    const url = `https://fixture.invalid/api/visual-curator/resource?exportId=${f.artifact.id}`
    const authorize = context.mock.method(f.domain, 'authorizedImage')
    const head = await f.service.resource(new Request(url, { method: 'HEAD' }))
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0)
    assert.equal(authorize.mock.callCount(), 5); assert.equal(previews(), 0); assert.equal(packages(), 0)
    const downloaded = await f.service.resource(new Request(url)), body = await downloaded.json()
    assert.equal(downloaded.status, 200); assert.equal(packages(), 1); assert.equal(previews(), 0)
    assert.deepEqual(body, { formatVersion: 2, export: f.artifact.id, files: f.artifact.files, resources: [] })
    const privateActor = { ...f.actor, sessionId: 'private-head-session' }, privatePackage = await new ModelProfiles(f.domain).export(f.profile, 'private-head', privateActor)
    const denied = await f.service.resource(new Request(`https://fixture.invalid/api/visual-curator/resource?exportId=${privatePackage.id}`, { method: 'HEAD' }))
    assert.equal(denied.status, 403)
  } finally { await f.cleanup() }
})

test('byte-bearing export HEAD validates referenced pixels without building a body or reading the workspace', async context => {
  const f = await exported(1)
  try {
    const image = f.domain.require('imageVersion', f.profile.references[0]!.reference.imageVersionId), asset = f.domain.require('asset', image.assetId)
    const record = exportSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'byte-export', kind: 'export', access: { kind: 'profile-library' }, formatVersion: 1, exportKind: 'classification', purpose: 'reference', releaseId: f.profile.id, splitId: 'fixture-split', feedbackIds: [], feedbackHeads: {}, mode: 'with-bytes', actor: { kind: 'authenticated-human', id: f.actor.id, confirmationMethod: 'client-action', confirmedAt: '2026-11-02T00:00:00Z' }, createdAt: '2026-11-02T00:00:00Z',
      resources: [{ assetId: asset.id, imageVersionId: image.id, digest: image.blob.digest, familyId: asset.familyId, split: 'learning' }], files: f.artifact.files, exclusions: {} })
    await f.repository.commit({ aggregateId: 'byte-export', expectedRevision: 0, operationId: 'byte-export', request: {}, state: {}, records: [record] })
    const snapshot = context.mock.method(f.domain, 'snapshot', () => { throw new Error('A download must not build the complete workspace') }), serializing = context.mock.method(JSON, 'stringify')
    const bodies = () => serializing.mock.calls.filter(call => { const value: unknown = call.arguments[0]; return !!value && typeof value === 'object' && 'export' in value && value.export === record.id && 'resources' in value }).length
    const url = `https://fixture.invalid/api/visual-curator/resource?exportId=${record.id}`
    const head = await f.service.resource(new Request(url, { method: 'HEAD' }))
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0); assert.equal(bodies(), 0)
    const downloaded = await f.service.resource(new Request(url)), body = z.object({ files: z.array(z.object({ name: z.string(), content: z.string(), checksum: z.string() })), resources: z.array(z.object({ base64: z.string() })) }).parse(await downloaded.json())
    assert.equal(downloaded.status, 200); assert.equal(bodies(), 1); assert.deepEqual(body.files, f.artifact.files)
    assert.equal(body.resources[0]?.base64, f.http.image.toString('base64')); assert.equal(snapshot.mock.callCount(), 0)
  } finally { await f.cleanup() }
})
