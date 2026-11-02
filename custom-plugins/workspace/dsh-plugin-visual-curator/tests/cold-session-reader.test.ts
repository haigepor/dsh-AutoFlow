/** Persisted Session metadata authorizes historical reads without restoring live agents. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { assetSchema, imageVersionSchema, recipeSchema, runSchema, selectionSchema, type Rule } from '../src/shared/model.ts'
import { toJson } from '../src/host/runtime.ts'
import { searchBatchPageSchema } from '../src/shared/search-batches.ts'
import type { Limits } from '../src/host/config.ts'

const ownSession = SessionId('persisted-owner'), otherSession = SessionId('persisted-other')
const grantSchema = z.object({ sessionToken: z.string(), expiresAt: z.number() })

async function coldFixture(limits: Partial<Limits> = {}) {
  const f = await serviceFixture(undefined, limits)
  const root = join(f.root, 'sessions')
  const writer = new Context()
  try {
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    for (const id of [ownSession, otherSession]) {
      const handle = await writer.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false })
      try { await handle.append([{ type: 'turn/start', seq: SessionSeq(0), time: Date.now(), data: { turn: 1 } }]) }
      finally { await handle.close() }
    }
  } finally { await writer.fiber.dispose() }
  const reader = new Context()
  await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  new SessionStore(reader)
  f.host.get = reader.get.bind(reader); f.host.sessions = reader.sessions
  await f.service.initialize()
  return { ...f, reader, cleanup: async () => { await reader.fiber.dispose(); await f.cleanup() } }
}

async function savedBatch(f: Awaited<ReturnType<typeof coldFixture>>) {
  const base = { schemaVersion: 1, profileId: f.profileId, createdAt: '2026-10-30T00:00:00.000Z' }
  const style = await f.domain.createStyle({ operationId: 'cold-style', name: 'Stored search' }, f.actor)
  const recipe = recipeSchema.parse({ ...base, kind: 'recipe', id: 'cold-recipe', visionRevision: 'fixture', model: 'fixture', vendorVersion: null, promptVersion: 'fixture', outputSchemaVersion: 'fixture', preprocessingVersion: 'fixture', referenceStrategy: { maxImages: 1, maxBytes: 1_000_000 }, preferenceScale: { min: 0, max: 4, weights: {} }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
  const rule: Rule = { ruleId: 'cold-rule', dimension: 'color', statement: 'Prefer natural colors', condition: {}, strength: 'preferred', stage: 'source', check: { kind: 'visual', criterion: 'natural colors' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'confirmed', actor: { kind: 'authenticated-human', id: f.actor.id, confirmedAt: base.createdAt, confirmationMethod: 'client-action' } } }
  await f.domain.saveDraft({ operationId: 'cold-draft', styleId: style.id, expectedRevision: 1, rules: [rule], recipe, referenceIds: [], feedbackIds: [], conflicts: [] }, f.actor)
  const candidate = await f.domain.createCandidate({ operationId: 'cold-candidate', styleId: style.id, expectedRevision: 2 }, f.actor)
  const release = await f.domain.publishStyle({ operationId: 'cold-release', styleId: style.id, candidateId: candidate.id, expectedRevision: 3 }, f.actor)
  await f.action('reference-import', { operationId: 'cold-pixels', styleId: style.id, expectedRevision: 4, files: [{ name: 'cold.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  const sourceImage = f.repository.list('imageVersion').find(image => image.versionKind === 'normalized')!
  const sourceAsset = f.domain.require('asset', sourceImage.assetId)
  const records = [ownSession, otherSession, SessionId('missing-session')].flatMap((sessionId, index) => {
    const asset = assetSchema.parse({ ...sourceAsset, id: `cold-asset-${index}`, familyId: `cold-family-${index}`, access: { kind: 'session-run', sessionId } })
    const image = imageVersionSchema.parse({ ...sourceImage, id: `cold-image-${index}`, assetId: asset.id })
    const run = runSchema.parse({ ...base, kind: 'run', id: `cold-run-${index}`, owner: { kind: 'session', sessionId }, revision: 1, status: 'completed', stage: 'reviewing', spec: toJson({ kind: 'search', config: f.service.config, input: { taskBrief: 'Stored historical search', targetCount: 1 }, fixed: { release }, specDigest: 'cold-spec' }), data: { attemptId: 'historical', attempts: 1, budget: { vision: 0, search: 0, downloadBytes: 0, deadlineAt: 1 }, checkpoint: {}, counts: { candidates: 1, qualified: 1 }, warnings: [], resultIds: [], requestIds: [] } })
    const selection = selectionSchema.parse({ ...base, kind: 'selection', id: `cold-selection-${index}`, runId: run.id, imageVersionId: image.id, assessmentId: 'historical-assessment', qualification: 'auto-qualified', rank: 0, warnings: [] })
    return [asset, image, run, selection]
  })
  await f.repository.commit({ aggregateId: 'cold-history', expectedRevision: 0, operationId: 'cold-history', request: {}, records, state: {} })
  return { styleId: style.id, imageId: 'cold-image-0', foreignImageId: 'cold-image-1', runId: 'cold-run-0' }
}

test('persisted cold Sessions can read their saved batches and pixels while absent and foreign authority remains denied', async () => {
  const f = await coldFixture()
  try {
    const history = await savedBatch(f)
    assert.equal(f.reader.sessions.get(ownSession), undefined)
    assert.ok(await f.reader.sessionPersistence.stat(ownSession))
    const grant = grantSchema.parse(await f.action('session-open', { sessionId: ownSession }))
    const batches = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: history.styleId }))
    const own = batches.batches.find(batch => batch.runId === history.runId)!
    assert.equal(own.unavailable, false); assert.equal(own.images.length, 1)
    assert.equal(batches.batches.find(batch => batch.runId === 'cold-run-2')?.unavailable, true)
    assert.ok(new URL(own.images[0]!.previewPath, 'https://owner.example').searchParams.get('sessionToken'))
    const served = await f.service.resource(new Request(new URL(own.images[0]!.previewPath, 'https://owner.example')))
    assert.equal(served.status, 200); assert.ok((await served.arrayBuffer()).byteLength > 0)
    const run = z.object({ runId: z.string() }).parse(await f.action('run-get', { runId: history.runId, sessionToken: grant.sessionToken }))
    assert.equal(run.runId, history.runId)
    await assert.rejects(f.action('session-open', { sessionId: 'missing-session' }), { code: 'owner-denied' })
    const denied = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=${history.foreignImageId}&sessionToken=${grant.sessionToken}`))
    assert.equal(denied.status, 403)
    await assert.rejects(f.action('run-get', { runId: 'cold-run-1', sessionToken: grant.sessionToken }), { code: 'owner-denied' })
    await assert.rejects(f.action('run-control', { runId: history.runId, command: 'stop', sessionToken: grant.sessionToken }), { code: 'owner-denied' })
    await assert.rejects(f.action('style-create', { operationId: 'forbidden-cold-write', name: 'No write', sessionToken: grant.sessionToken }), { code: 'owner-denied' })
    assert.equal(f.repository.list('style').length, 1)
    assert.equal(f.reader.sessions.get(ownSession), undefined, 'read authority must not restore a live Session')
    assert.equal(f.jobs.hooks.length, 0); assert.equal(f.http.operations.length, 0)
  } finally { await f.cleanup() }
})

test('on-demand style evidence uses the same Session resource grant as workspace snapshots', async () => {
  const f = await coldFixture()
  try {
    const styleId = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'scoped-profile', name: 'Scoped profile' })).id
    await f.action('reference-import', { operationId: 'scoped-profile-reference', styleId, expectedRevision: 1, files: [{ name: 'negative.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'negative', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'scoped-profile-analysis', styleId, buildDataset: true }); await f.jobs.drain()
    const grant = grantSchema.parse(await f.action('session-open', { sessionId: ownSession }))
    const detail = z.object({ modelProfile: z.object({ samples: z.array(z.object({ role: z.string(), image: z.object({ previewPath: z.string() }) })) }) }).parse(await f.action('style-get', { styleId, sessionToken: grant.sessionToken }))
    const sample = detail.modelProfile.samples[0]!, url = new URL(sample.image.previewPath, 'https://owner.example')
    assert.equal(sample.role, 'negative')
    assert.equal(url.searchParams.get('sessionToken'), grant.sessionToken)
    assert.equal((await f.service.resource(new Request(url))).status, 200)
    url.searchParams.set('sessionToken', 'unavailable-grant')
    assert.equal((await f.service.resource(new Request(url))).status, 403)
    assert.equal(f.reader.sessions.get(ownSession), undefined)
  } finally { await f.cleanup() }
})

test('expired cold Session grants cannot read saved pixels or task metadata', async () => {
  const f = await coldFixture({ sessionGrantTtlMs: 2 })
  try {
    const grant = grantSchema.parse(await f.action('session-open', { sessionId: ownSession }))
    while (Date.now() <= grant.expiresAt) await delay(Math.max(1, grant.expiresAt - Date.now() + 1))
    await assert.rejects(f.action('conversation-runs', { sessionId: ownSession, sessionToken: grant.sessionToken }), { code: 'owner-denied' })
    const response = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=not-read&sessionToken=${grant.sessionToken}`))
    assert.equal(response.status, 403)
    assert.equal(f.reader.sessions.get(ownSession), undefined); assert.equal(f.jobs.hooks.length, 0)
  } finally { await f.cleanup() }
})

test('cold metadata checks stay within the selected batch page and inspect each Session once', async () => {
  const f = await coldFixture({ pageSize: 1 })
  try {
    const history = await savedBatch(f), seen: string[] = []
    const original = f.reader.sessionPersistence.stat.bind(f.reader.sessionPersistence)
    f.reader.sessionPersistence.stat = async (id, options) => { seen.push(id); return original(id, options) }
    const first = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: history.styleId }))
    assert.equal(first.batches.length, 1)
    assert.deepEqual(seen, ['missing-session'], 'unseen persistent Sessions must not add metadata IO to this page')
    seen.length = 0
    const selected = searchBatchPageSchema.parse(await f.action('search-batches', { styleId: history.styleId, batchId: history.runId }))
    assert.equal(selected.batches[0]?.images.length, 1)
    assert.deepEqual(seen, [ownSession])
    assert.equal(f.reader.sessions.get(ownSession), undefined); assert.equal(f.jobs.hooks.length, 0)
  } finally { await f.cleanup() }
})

test('a failed persistence stat never falls back to profile-wide historical authority', async () => {
  const f = await coldFixture()
  try {
    const history = await savedBatch(f)
    const grant = grantSchema.parse(await f.action('session-open', { sessionId: ownSession }))
    const original = f.reader.sessionPersistence.stat.bind(f.reader.sessionPersistence)
    const failure = new Error('fixture persistence stat failure')
    f.reader.sessionPersistence.stat = async (id, options) => { if (id === ownSession) throw failure; return original(id, options) }
    await assert.rejects(f.action('session-open', { sessionId: ownSession }), error => error === failure)
    await assert.rejects(f.action('conversation-runs', { sessionId: ownSession, sessionToken: grant.sessionToken }), error => error === failure)
    await assert.rejects(f.action('search-batches', { styleId: history.styleId }), error => error === failure)
    const response = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=${history.imageId}&sessionToken=${grant.sessionToken}`))
    assert.notEqual(response.status, 200)
    assert.notEqual(z.object({ code: z.string() }).parse(await response.json()).code, 'owner-denied', 'a backend read failure must not be reported as a nonexistent or unauthorized Session')
    assert.equal(f.reader.sessions.get(ownSession), undefined); assert.equal(f.jobs.hooks.length, 0)
  } finally { await f.cleanup() }
})
