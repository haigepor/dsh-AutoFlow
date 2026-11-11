/** Terminal wallpaper resources retain Session authorization and rotate only after grant expiry. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { assetSchema, imageVersionSchema, runSchema, type CuratorRecord } from '../src/shared/model.ts'
import { wallpaperSettingsSchema, wallpaperViewSchema } from '../src/shared/wallpaper.ts'
import { toJson } from '../src/host/runtime.ts'
import { largeWallpaperView } from './fixtures/wallpaper-transport.ts'

test('single-item wallpaper reads retain full counts and history while paging only their own resources', async context => {
  const f = await serviceFixture(undefined, { pageSize: 20 })
  try {
    await f.service.initialize()
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'detail-style', name: 'Wallpaper detail window' }))
    await f.action('reference-import', { operationId: 'detail-reference', styleId, expectedRevision: 1, files: [{ name: 'source.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const original = f.repository.list('imageVersion').find(image => image.versionKind === 'normalized')!, saved = largeWallpaperView(), records: CuratorRecord[] = []
    const statuses = ['passed', 'needs-review', 'technical-failed', 'queued'] as const
    const items = Array.from({ length: 20 }, (_, index) => {
      const id = `detail-image-${index}`
      const attempts = saved.state.items[0]!.attempts.map((attempt, round) => ({ ...attempt, plan: { ...attempt.plan, imageVersionId: id }, canvasId: `${id}-round-${round}-canvas`, analysisId: `${id}-round-${round}-analysis`, simulationId: `${id}-round-${round}-simulation`, outputId: `${id}-round-${round}-output` }))
      for (const key of [id, ...attempts.flatMap(attempt => [attempt.canvasId, attempt.analysisId, attempt.simulationId, attempt.outputId])]) {
        const image = imageVersionSchema.parse({ ...original, id: key, versionKind: key === id ? 'normalized' : 'composition', parentImageVersionId: key === id ? original.id : id })
        records.push(image)
        if (key !== 'detail-image-0') records.push(imageVersionSchema.parse({ ...image, id: `${key}:preview`, versionKind: 'preview', parentImageVersionId: image.id }))
      }
      return { ...saved.state.items[0]!, imageVersionId: id, originalId: id, status: statuses[index % statuses.length]!, attempts }
    })
    const base = { schemaVersion: 1, profileId: f.profileId, createdAt: '2026-11-06T00:00:00.000Z', kind: 'run', revision: 1, status: 'completed', stage: 'reviewing', owner: { kind: 'profile' } }
    const data = { attemptId: 'saved', attempts: 1, budget: { vision: 0, search: 0, downloadBytes: 0, deadlineAt: 1 }, checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] }
    const source = runSchema.parse({ ...base, id: 'detail-source', spec: toJson({ kind: 'search', config: f.service.config, input: { targetCount: 20 }, fixed: {}, specDigest: 'detail-source' }), data })
    const state = { ...saved.state, sourceRunId: source.id, items }
    const child = runSchema.parse({ ...base, id: 'detail-child', spec: toJson({ kind: 'crop', config: f.service.config, input: { workflow: 'wallpaper-v1', sourceRunId: source.id }, fixed: { wallpaper: saved.settings }, specDigest: 'detail-child' }), data: { ...data, checkpoint: { wallpaper: state } } })
    await f.repository.commit({ aggregateId: 'wallpaper-detail-window', expectedRevision: 0, operationId: 'seed-detail-window', request: {}, records: [...records, source, child], state: {} })
    const read = async (args: { limit?: number; offset?: number } = {}) => {
      const response = await f.service.data(new Request('https://owner.example/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'wallpaper-read', args: { sourceRunId: source.id, ...args } }) }))
      assert.equal(response.status, 200)
      const body = await response.text()
      return { view: wallpaperViewSchema.parse(z.object({ value: z.unknown() }).parse(JSON.parse(body)).value), wireBytes: Buffer.byteLength(body) }
    }
    const full = await read(), first = await read({ limit: 1 }), second = await read({ limit: 1, offset: 1 })
    context.diagnostic(JSON.stringify({ measurement: 'wallpaper-detail-http-bytes', total: 20, attemptsPerItem: 3, defaultItems: full.view.state.items.length, limitedItems: first.view.state.items.length, fullBytes: full.wireBytes, firstBytes: first.wireBytes, secondBytes: second.wireBytes }))
    assert.equal(full.view.state.items.length, 20, 'omitting limit retains the configured page size')
    assert.equal(first.view.state.items.length, 1)
    assert.equal(second.view.state.items.length, 1)
    assert.equal(first.view.offset, 0); assert.equal(second.view.offset, 1)
    assert.equal(first.view.total, 20); assert.equal(second.view.total, 20)
    assert.deepEqual(first.view.counts, full.view.counts); assert.deepEqual(second.view.counts, full.view.counts)
    for (const status of statuses) assert.equal(first.view.counts[status], 5)
    assert.deepEqual(first.view.state.items[0], full.view.state.items[0]); assert.deepEqual(second.view.state.items[0], full.view.state.items[1])
    assert.equal(new URL(first.view.sourceImages['detail-image-0']!.previewPath, 'https://owner.example').searchParams.get('preview'), 'thumbnail')
    for (const page of [first.view, second.view]) {
      const item = page.state.items[0]!, ids = [item.originalId!, ...item.attempts.flatMap(attempt => [attempt.analysisId!, attempt.simulationId!, attempt.outputId!])]
      assert.equal(item.attempts.length, 3)
      assert.deepEqual(new Set(Object.keys(page.resources)), new Set(ids))
      assert.deepEqual(new Set(Object.keys(page.previewResources)), new Set(ids))
      assert.deepEqual(Object.keys(page.sourceImages), [item.originalId!])
    }
    assert(Object.keys(first.view.resources).every(id => !(id in second.view.resources)))
    assert(first.wireBytes < full.wireBytes / 10, 'the one-item detail does not retain sibling histories')
    assert.deepEqual((await read({ limit: 20 })).view, full.view)
    for (const limit of [0, 21, 1.5]) {
      const response = await f.service.data(new Request('https://owner.example/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'wallpaper-read', args: { sourceRunId: source.id, limit } }) }))
      assert.equal(response.ok, false, `limit ${limit} must be rejected`)
    }
    assert.equal(f.http.operations.length, 0)
    assert.deepEqual(f.domain.require('run', child.id), child)
  } finally { await f.cleanup() }
})

test('a fresh wallpaper HTTP read replaces expired Session URLs without extending their original grant', async context => {
  const f = await serviceFixture(undefined, { sessionGrantTtlMs: 100 }), sessions = new SessionStore(new Context()), sessionId = SessionId('wallpaper-expiry-session')
  sessions.create(sessionId, { meta: { cwd: f.root } }); f.host.sessions.get = id => sessions.get(id)
  try {
    await f.service.initialize()
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'expiry-style', name: 'Expiry fixture' }))
    await f.action('reference-import', { operationId: 'expiry-reference', styleId, expectedRevision: 1, files: [{ name: 'source.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const original = f.repository.list('imageVersion').find(image => image.versionKind === 'normalized')!, originalAsset = f.domain.require('asset', original.assetId)
    const asset = assetSchema.parse({ ...originalAsset, id: 'session-wallpaper-asset', familyId: 'session-wallpaper-family', access: { kind: 'session-run', sessionId } })
    const image = imageVersionSchema.parse({ ...original, id: 'session-wallpaper-image', assetId: asset.id })
    const base = { schemaVersion: 1, profileId: f.profileId, createdAt: '2026-11-06T00:00:00.000Z', kind: 'run', revision: 1, status: 'completed', stage: 'reviewing' }
    const data = { attemptId: 'saved', attempts: 1, budget: { vision: 0, search: 0, downloadBytes: 0, deadlineAt: 1 }, checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] }
    const source = runSchema.parse({ ...base, id: 'session-wallpaper-source', owner: { kind: 'session', sessionId }, spec: toJson({ kind: 'search', config: f.service.config, input: {}, fixed: {}, specDigest: 'saved-source' }), data })
    const state = { version: 1, sourceRunId: source.id, skillVersion: 'saved-skill', budgetStopped: false, items: [{ imageVersionId: image.id, originalId: image.id, familyId: asset.familyId, status: 'passed', edits: 0, attempts: [] }] }
    const child = runSchema.parse({ ...base, id: 'session-wallpaper-child', owner: { kind: 'profile' }, spec: toJson({ kind: 'crop', config: f.service.config, input: { workflow: 'wallpaper-v1', sourceRunId: source.id }, fixed: { wallpaper: wallpaperSettingsSchema.parse({}), sourceSessionId: sessionId }, specDigest: 'saved-child' }), data: { ...data, checkpoint: { wallpaper: state } } })
    await f.repository.commit({ aggregateId: 'wallpaper-expiry-fixture', expectedRevision: 0, operationId: 'seed-expiry', request: {}, records: [asset, image, source, child], state: {} })
    let now = Date.now(); context.mock.method(Date, 'now', () => now)
    const read = async () => {
      const response = await f.service.data(new Request('https://owner.example/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'wallpaper-read', args: { sourceRunId: source.id, limit: 1 } }) }))
      assert.equal(response.status, 200)
      return wallpaperViewSchema.parse(z.object({ value: z.unknown() }).parse(await response.json()).value)
    }
    const first = await read(), oldUrl = first.resources[image.id]!
    assert.equal(first.resourceExpiresAt, now + 100)
    assert.equal((await f.service.resource(new Request(new URL(oldUrl, 'https://owner.example')))).status, 200)
    now += 99
    const unexpired = await read()
    assert.equal(unexpired.resources[image.id], oldUrl, 'A read does not extend or rotate an unexpired grant')
    assert.equal(unexpired.resourceExpiresAt, first.resourceExpiresAt)
    now += 2
    assert.equal((await f.service.resource(new Request(new URL(oldUrl, 'https://owner.example')))).status, 403)
    const refreshed = await read(), newUrl = refreshed.resources[image.id]!
    assert.equal(refreshed.resourceExpiresAt, now + 100)
    assert.notEqual(newUrl, oldUrl)
    assert.equal((await f.service.resource(new Request(new URL(newUrl, 'https://owner.example')))).status, 200)
    assert.equal((await f.service.resource(new Request(new URL(oldUrl, 'https://owner.example')))).status, 403)
    assert.equal(f.http.operations.length, 0)
    context.diagnostic('TTL=100ms: old resource 200→403; new wallpaper HTTP read rotates token and new resource=200; no model calls')
  } finally { await f.cleanup() }
})
