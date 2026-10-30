/** Analysis reads verify shared dependencies once, without retaining trust across operations. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { CuratorDomain } from '../src/domain/curator.ts'
import { contentDigest, DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { CuratorService } from '../src/host/service.ts'
import { analysisDetailSchema, analysisInputSchema } from '../src/shared/analysis-process.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import type { RecordKind, RecordOf } from '../src/shared/model.ts'

class ObservedAdapter extends MemoryDomainAdapter {
  manifestReads = 0
  readonly reads = new Map<string, number>()
  override manifests() { this.manifestReads++; return super.manifests() }
  override readRecord(key: string) { this.reads.set(key, (this.reads.get(key) ?? 0) + 1); return super.readRecord(key) }
  resetReads(): void { this.manifestReads = 0; this.reads.clear() }
}

class ObservedRepository extends DomainRepository {
  readonly listReads = new Map<string, number>()
  override list<K extends RecordKind>(kind: K): RecordOf<K>[] { this.listReads.set(kind, (this.listReads.get(kind) ?? 0) + 1); return super.list(kind) }
}

async function savedAnalysis() {
  const f = await serviceFixture()
  await f.service.initialize()
  const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'read-style', name: 'Read fixture' }))
  await f.action('reference-import', { operationId: 'read-image', styleId: style.id, expectedRevision: 1, files: [{ name: 'read.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'read-analysis', styleId: style.id }))
  await f.jobs.drain()
  const adapter = new ObservedAdapter()
  const kinds = ['style', 'draft', 'run', 'asset', 'imageVersion', 'reference', 'observation', 'request'] as const
  const records = kinds.flatMap(kind => f.repository.list(kind))
  const pointers = records.map(record => {
    const digest = contentDigest(record), key = `${record.kind}-${digest.slice(10)}`
    adapter.records.set(key, record)
    return { key, kind: record.kind, id: record.id, digest }
  })
  adapter.commits.set('read-fixture', { schemaVersion: 1, profileId: f.profileId, aggregateId: 'read-fixture', revision: 1, records: pointers, receipts: {}, state: {} })
  const repository = new ObservedRepository(f.profileId, adapter), domain = new CuratorDomain(f.profileId, repository)
  const service = new CuratorService(f.host, f.service.config, { openDomain: async () => domain, providers: { source: async () => { throw new Error('Read fixture cannot search') }, vision: async () => { throw new Error('Read fixture cannot dispatch a model') }, media: () => f.http } })
  await service.initialize()
  const action = (operation: string, args: Record<string, string>) => service.action({ operation, args }, f.actor, new AbortController().signal)
  return { adapter, repository, service, action, runId, styleId: style.id, requestId: f.repository.list('request')[0]!.id, actor: f.actor, cleanup: async () => { await service.dispose(); await f.cleanup() } }
}

test('analysis preflight verifies one snapshot and reads feedback without assembling the full workspace', async () => {
  const f = await savedAnalysis()
  try {
    f.adapter.resetReads(); f.repository.listReads.clear()
    const plan = z.object({ total: z.number() }).parse(await f.action('reference-state', { styleId: f.styleId }))
    assert.equal(plan.total, 1)
    assert.equal(f.adapter.manifestReads, 1)
    for (const kind of ['style', 'usage', 'split', 'evaluation', 'export', 'suggestion']) assert.equal(f.repository.listReads.get(kind) ?? 0, 0, `${kind} is unrelated to analysis preflight`)
  } finally { await f.cleanup() }
})

test('analysis admission shares dependency verification and releases its snapshot before resolving the provider', async () => {
  const f = await savedAnalysis()
  try {
    const { digest: planDigest } = z.object({ digest: z.string() }).parse(await f.action('reference-state', { styleId: f.styleId }))
    f.adapter.resetReads(); f.repository.listReads.clear()
    await assert.rejects(f.service.action({ operation: 'reference-analyze', args: { styleId: f.styleId, operationId: 'read-admission', buildDataset: true, planDigest } }, f.actor, new AbortController().signal), /Read fixture cannot dispatch a model/)
    assert.ok(f.adapter.manifestReads <= 3, 'reference preparation does not reverify every image dependency')
    for (const kind of ['style', 'usage', 'evaluation', 'export', 'suggestion']) assert.equal(f.repository.listReads.get(kind) ?? 0, 0, `${kind} is unrelated to analysis admission`)
  } finally { await f.cleanup() }
})

test('analysis detail reads one manifest snapshot and verifies each saved dependency once', async () => {
  const f = await savedAnalysis()
  try {
    f.adapter.resetReads()
    const detail = analysisDetailSchema.parse(await f.action('analysis-detail', { runId: f.runId }))
    assert.equal(detail.images.length, 1)
    assert.equal(detail.observations.length, 1)
    assert.equal(detail.requests.length, 1)
    assert.equal(f.adapter.manifestReads, 1)
    assert.ok([...f.adapter.reads.values()].every(count => count === 1))
    assert.ok(!JSON.stringify(detail.requests).includes('inputText'))
    const [key, image] = [...f.adapter.records].find(([, record]) => record.kind === 'imageVersion' && record.id === detail.images[0]!.imageVersionId)!
    assert.equal(image.kind, 'imageVersion')
    f.adapter.records.set(key, { ...image, createdAt: '2026-10-01T00:00:00.000Z' })
    await assert.rejects(f.action('analysis-detail', { runId: f.runId }), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})

test('analysis input loads only its authorized request in a fresh read snapshot', async () => {
  const f = await savedAnalysis()
  try {
    f.adapter.resetReads()
    const input = analysisInputSchema.parse(await f.action('analysis-input', { runId: f.runId, requestId: f.requestId }))
    assert.equal(input.requestId, f.requestId)
    assert.equal(input.images.length, 1)
    assert.equal(f.adapter.manifestReads, 1)
    assert.ok([...f.adapter.reads.values()].every(count => count === 1))
    f.adapter.resetReads()
    await assert.rejects(f.service.action({ operation: 'analysis-input', args: { runId: f.runId, requestId: f.requestId } }, { ...f.actor, profileId: 'foreign-profile' }, new AbortController().signal), { code: 'owner-denied' })
    assert.ok([...f.adapter.reads.keys()].every(key => !key.startsWith('request-')))
  } finally { await f.cleanup() }
})

test('analysis follow initialization verifies the run once and releases its snapshot before stream observation', async () => {
  const f = await savedAnalysis()
  const follow = () => f.service.followAnalysis(new Request('http://127.0.0.1/api/visual-curator/analysis-stream', { method: 'POST', body: JSON.stringify({ operation: 'analysis-follow', args: { runId: f.runId } }) }))
  try {
    f.adapter.resetReads()
    const response = await follow(), reader = response.body!.getReader()
    assert.equal(response.status, 200)
    assert.equal(f.adapter.manifestReads, 1)
    assert.equal([...f.adapter.reads.values()].reduce((sum, count) => sum + count, 0), 1)
    const frame = await reader.read()
    assert.ok(frame.value)
    const [key, run] = [...f.adapter.records].find(([, record]) => record.kind === 'run')!
    assert.equal(run.kind, 'run')
    f.adapter.records.set(key, { ...run, createdAt: '2026-10-01T00:00:00.000Z' })
    assert.equal((await follow()).status, 400)
    await reader.cancel()
  } finally { await f.cleanup() }
})
