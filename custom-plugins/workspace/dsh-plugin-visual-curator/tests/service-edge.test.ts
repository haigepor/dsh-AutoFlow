import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { CuratorError } from '../src/shared/errors.ts'
import type { Json } from '../src/shared/model.ts'
import type { CommitInput } from '../src/domain/repository.ts'
import { dataOf } from '../src/host/runtime.ts'
import { AssetFiles } from '../src/media/index.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const identified = z.object({ id: z.string() })
type Fixture = Awaited<ReturnType<typeof serviceFixture>>

async function standard(fixture: Fixture) {
  const style = identified.parse(await fixture.action('style-create', { operationId: 'create', name: 'Frozen standard' }))
  const imported = z.object({ results: z.array(z.object({ imageVersionId: z.string() })) }).parse(await fixture.action('reference-import', { operationId: 'import', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] }))
  const candidate = identified.parse(await fixture.action('candidate-create', { operationId: 'candidate', styleId: style.id, expectedRevision: 2 }))
  const release = identified.parse(await fixture.action('release-publish', { operationId: 'publish', styleId: style.id, expectedRevision: 3, candidateId: candidate.id }))
  const usage = identified.parse(await fixture.action('usage-create', { operationId: 'usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
  const imageVersionId = imported.results[0]?.imageVersionId
  assert.ok(imageVersionId)
  return { styleId: style.id, releaseId: release.id, usageRevisionId: usage.id, imageVersionId }
}

test('repeating an accepted task operation ID returns its original Run without adding jobs', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const fixed = await standard(fixture)
    const args = { operationId: 'search-operation', releaseId: fixed.releaseId, usageRevisionId: fixed.usageRevisionId, taskBrief: 'Muted image.', sourceId: 'images', targetCount: 1 }
    const first = z.object({ runId: z.string() }).parse(await fixture.action('search-start', args))
    await fixture.jobs.drain()
    const again = z.object({ runId: z.string() }).parse(await fixture.action('search-start', args))
    assert.equal(first.runId, again.runId)
    assert.equal(fixture.jobs.hooks.length, 1)
    await assert.rejects(fixture.action('search-start', { ...args, taskBrief: 'Different task.' }), { code: 'operation-conflict' })
    assert.equal(fixture.jobs.hooks.length, 1)
  } finally { await fixture.cleanup() }
})

test('Agent-created Run and provider assets retain Session ownership; another Session cannot read or cancel them', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const fixed = await standard(fixture)
    const actor = { kind: 'agent' as const, id: 'agent', profileId: fixture.profileId, sessionId: 'session-a' }
    const args = { operationId: 'agent-search', releaseId: fixed.releaseId, usageRevisionId: fixed.usageRevisionId, taskBrief: 'Muted image.', sourceId: 'images', targetCount: 1 }
    const started = z.object({ runId: z.string() }).parse(await fixture.service.action({ operation: 'search-start', args }, actor, new AbortController().signal))
    await fixture.jobs.drain()
    assert.deepEqual(fixture.domain.require('run', started.runId).owner, { kind: 'session', sessionId: 'session-a' })
    const providerAssets = fixture.repository.list('asset').filter(asset => asset.source.kind === 'provider')
    assert.ok(providerAssets.length > 0)
    assert.ok(providerAssets.every(asset => asset.access.kind === 'session-run' && asset.access.sessionId === actor.sessionId))
    await assert.rejects(fixture.service.action({ operation: 'run-get', args: { runId: started.runId } }, { ...actor, sessionId: 'session-b' }, new AbortController().signal), { code: 'owner-denied' })
    await assert.rejects(fixture.service.action({ operation: 'run-control', args: { runId: started.runId, command: 'cancel' } }, { ...actor, sessionId: 'session-b' }, new AbortController().signal), { code: 'owner-denied' })
    const before = fixture.jobs.hooks.length
    await assert.rejects(fixture.service.action({ operation: 'search-start', args: { ...args, operationId: 'unowned' } }, { kind: 'agent', id: 'agent', profileId: fixture.profileId }, new AbortController().signal), { code: 'owner-denied' })
    assert.equal(fixture.jobs.hooks.length, before)
  } finally { await fixture.cleanup() }
})

test('human reads cannot authorize Session resources with only a Run/image ID, query Session ID or fabricated channel token', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const fixed = await standard(fixture)
    const actor = { kind: 'agent' as const, id: 'agent', profileId: fixture.profileId, sessionId: 'session-a' }
    const args = { operationId: 'private-resource', releaseId: fixed.releaseId, usageRevisionId: fixed.usageRevisionId, taskBrief: 'Muted image.', sourceId: 'images', targetCount: 1 }
    const started = z.object({ runId: z.string() }).parse(await fixture.service.action({ operation: 'search-start', args }, actor, new AbortController().signal))
    await fixture.jobs.drain()
    assert.equal(fixture.http.operations.length, 0, 'a missing original Session must prevent every visual provider call')
    const image = fixture.repository.list('imageVersion').find(image => {
      const asset = fixture.domain.require('asset', image.assetId)
      return asset.access.kind === 'session-run' && image.versionKind === 'normalized'
    })
    assert.ok(image)
    await assert.rejects(fixture.action('run-get', { runId: started.runId, sessionId: actor.sessionId }), { code: 'owner-denied' })
    await assert.rejects(fixture.service.action({ operation: 'run-get', args: { runId: started.runId } }, { ...fixture.actor, sessionId: actor.sessionId }, new AbortController().signal), { code: 'owner-denied' })
    await assert.rejects(fixture.action('session-open', { sessionId: actor.sessionId }), { code: 'owner-denied' }, 'a fabricated Session ID absent from actual Session storage cannot grant access')
    for (const extra of ['', `&sessionId=${actor.sessionId}`, `&sessionId=${actor.sessionId}&sessionToken=fabricated-token`]) {
      const response = await fixture.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=${image.id}${extra}`))
      assert.equal(response.status, 403)
    }
  } finally { await fixture.cleanup() }
})

test('manual completion validates exact source pixels before job creation and repeats the same confirmed operation idempotently', async t => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const fixed = await standard(fixture)
    const args = { operationId: 'manual-invalid', releaseId: fixed.releaseId, usageRevisionId: fixed.usageRevisionId, imageVersionId: fixed.imageVersionId, rect: { x: 0, y: 0, width: 0.01, height: 1 }, allowWarning: true, includeInLearning: false }
    await assert.rejects(fixture.action('manual-crop-confirm', args), { code: 'invalid-input' })
    assert.equal(fixture.jobs.hooks.length, 0)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const valid = { ...args, operationId: 'manual-valid', rect: { x: 0.25, y: 0, width: 0.5, height: 1 } }
    const first = z.object({ runId: z.string() }).parse(await fixture.action('manual-crop-confirm', valid))
    await fixture.jobs.drain()
    t.mock.timers.tick(1000)
    const again = z.object({ runId: z.string() }).parse(await fixture.action('manual-crop-confirm', valid))
    assert.equal(first.runId, again.runId)
    assert.equal(fixture.jobs.hooks.length, 1)
    assert.equal(fixture.repository.list('feedback').filter(feedback => feedback.judgment.kind === 'crop-confirmation').length, 0)
  } finally { await fixture.cleanup() }
})

test('import recovers completed item/draft commits when only its final batch receipt failed', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const style = identified.parse(await fixture.action('style-create', { operationId: 'style', name: 'Import recovery' }))
    const args: Record<string, Json> = { operationId: 'import-recovery', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] }
    const original = fixture.repository.commit.bind(fixture.repository)
    let fail = true
    fixture.repository.commit = async (input: CommitInput) => {
      if (fail && input.aggregateId === 'import-batch:import-recovery' && input.operationId === 'import-recovery') { fail = false; throw new CuratorError('storage-commit-failed', 'import', 'Injected batch receipt failure.') }
      return await original(input)
    }
    await assert.rejects(fixture.action('reference-import', args), { code: 'storage-commit-failed' })
    assert.equal(fixture.repository.list('asset').length, 1)
    assert.equal(fixture.repository.list('reference').length, 1)
    const retried = z.object({ results: z.array(z.object({ ok: z.boolean(), imageVersionId: z.string() })) }).parse(await fixture.action('reference-import', args))
    assert.equal(retried.results[0]?.ok, true)
    assert.equal(fixture.repository.list('asset').length, 1)
    assert.equal(fixture.repository.list('reference').length, 1)
    assert.equal(fixture.domain.require('style', style.id).revision, 2)
  } finally { await fixture.cleanup() }
})

test('a changed deployment cannot run an old recipe and a new publication retains both immutable recipes', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const fixed = await standard(fixture)
    const old = fixture.domain.require('release', fixed.releaseId)
    const original = structuredClone(old.recipe)
    fixture.service.config.vision.model = 'changed-deployment-model'
    await assert.rejects(fixture.action('search-start', { operationId: 'changed-config', releaseId: fixed.releaseId, usageRevisionId: fixed.usageRevisionId, taskBrief: 'Subject.', sourceId: 'images', targetCount: 1 }), { code: 'constraint-conflict' })
    assert.equal(fixture.jobs.hooks.length, 0)
    const candidate = identified.parse(await fixture.action('candidate-create', { operationId: 'new-recipe-candidate', styleId: fixed.styleId, expectedRevision: 4 }))
    const next = identified.parse(await fixture.action('release-publish', { operationId: 'new-recipe-release', styleId: fixed.styleId, expectedRevision: 5, candidateId: candidate.id }))
    assert.deepEqual(fixture.domain.require('release', fixed.releaseId).recipe, original)
    assert.equal(fixture.domain.require('release', next.id).recipe.model, 'changed-deployment-model')
    assert.notEqual(fixture.domain.require('release', next.id).recipe.id, original.id)
    assert.equal(fixture.domain.require('release', next.id).releaseNumber, old.releaseNumber + 1)
    assert.equal(fixture.domain.require('style', fixed.styleId).defaultReleaseId, null)
  } finally { await fixture.cleanup() }
})

test('Agent export runs offline with Session ownership and unauthorized byte exports never produce a complete package', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const fixed = await standard(fixture)
    const asset = fixture.domain.require('asset', fixture.domain.require('imageVersion', fixed.imageVersionId).assetId)
    const split = identified.parse(await fixture.action('split-create', { operationId: 'split', assignments: [{ familyId: asset.familyId, split: 'learning', groupingConfirmed: true }] }))
    const actor = { kind: 'agent' as const, id: 'agent', profileId: fixture.profileId, sessionId: 'session-a' }
    const args = { operationId: 'agent-export', kind: 'style', purpose: 'reference', releaseId: fixed.releaseId, splitId: split.id, mode: 'references-only' }
    const started = z.object({ runId: z.string() }).parse(await fixture.service.action({ operation: 'export-start', args }, actor, new AbortController().signal))
    await fixture.jobs.drain()
    const run = fixture.domain.require('run', started.runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run)))
    assert.equal(fixture.http.operations.length, 0)
    const snapshot = fixture.domain.require('export', dataOf(run).resultIds[0] ?? '')
    assert.equal(snapshot.actor.kind, 'agent')
    await assert.rejects(fixture.service.action({ operation: 'export-get', args: { exportId: snapshot.id } }, { ...actor, sessionId: 'session-b' }, new AbortController().signal), { code: 'owner-denied' })
    const unauthorized = z.object({ runId: z.string() }).parse(await fixture.action('export-start', { ...args, operationId: 'unauthorized-bytes', mode: 'with-bytes' }))
    await fixture.jobs.drain()
    const failed = fixture.domain.require('run', unauthorized.runId)
    assert.equal(failed.status, 'failed')
    assert.equal(dataOf(failed).error?.code, 'owner-denied')
    assert.equal(fixture.repository.list('export').length, 1)
  } finally { await fixture.cleanup() }
})

test('an export uses its accepted feedback heads even when the user revises a judgment before background dispatch', async () => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  try {
    const fixed = await standard(fixture)
    const asset = fixture.domain.require('asset', fixture.domain.require('imageVersion', fixed.imageVersionId).assetId)
    const split = identified.parse(await fixture.action('split-create', { operationId: 'split', assignments: [{ familyId: asset.familyId, split: 'learning', groupingConfirmed: true }] }))
    const context = { styleId: fixed.styleId, standard: { kind: 'release', releaseId: fixed.releaseId }, usage: { kind: 'none' }, taskBriefDigest: '' }
    const feedbackArgs = { subject: { kind: 'image', imageVersionId: fixed.imageVersionId }, context, judgment: { kind: 'style-verdict', value: 'accept' }, viewEvidence: [{ imageVersionId: fixed.imageVersionId, versionKind: 'normalized' }], scope: 'style-candidate', expectedHead: null }
    const first = identified.parse(await fixture.action('feedback-confirm', { ...feedbackArgs, operationId: 'accept' }))
    const start = fixture.jobs.start
    let dispatch: (() => void) | undefined
    fixture.jobs.start = spec => { dispatch = () => { start(spec) }; return brandString<JobId>('deferred-export') }
    const handle = z.object({ runId: z.string() }).parse(await fixture.action('export-start', { operationId: 'fixed-head-export', kind: 'classification', purpose: 'training', releaseId: fixed.releaseId, splitId: split.id, mode: 'references-only' }))
    const revised = identified.parse(await fixture.action('feedback-confirm', { ...feedbackArgs, operationId: 'reject', expectedHead: first.id, judgment: { kind: 'style-verdict', value: 'reject' } }))
    assert.ok(dispatch)
    fixture.jobs.start = start
    dispatch()
    await fixture.jobs.drain()
    const run = fixture.domain.require('run', handle.runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run)))
    const snapshot = fixture.domain.require('export', dataOf(run).resultIds[0] ?? '')
    assert.ok(snapshot.feedbackIds.includes(first.id))
    assert.ok(!snapshot.feedbackIds.includes(revised.id))
  } finally { await fixture.cleanup() }
})

test('unload cancels and drains a foreground import before closing the writer or publishing late results', async t => {
  const fixture = await serviceFixture(); await fixture.service.initialize()
  let enter!: () => void, release!: () => void, observeAbort!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve }), aborted = new Promise<void>(resolve => { observeAbort = resolve })
  const original = AssetFiles.prototype.importBytes
  // This file runs sequentially; the test-owned method patch is restored before another fixture starts.
  t.mock.method(AssetFiles.prototype, 'importBytes', async function(this: AssetFiles, bytes: Uint8Array, mime?: string, signal?: AbortSignal) {
    enter()
    if (signal?.aborted) observeAbort()
    else signal?.addEventListener('abort', observeAbort, { once: true })
    await gate
    return await original.call(this, bytes, mime, signal)
  })
  let importing: Promise<unknown> | undefined, disposing: Promise<void> | undefined
  try {
    const style = identified.parse(await fixture.action('style-create', { operationId: 'foreground-style', name: 'Foreground import' }))
    importing = fixture.action('reference-import', { operationId: 'foreground-import', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await entered
    disposing = fixture.service.dispose()
    const first = await Promise.race([aborted.then(() => 'aborted'), disposing.then(() => 'disposed')])
    assert.equal(first, 'aborted', 'disposal must signal admitted foreground work before it can finish')
    release()
    const results = await Promise.allSettled([importing, disposing])
    assert.equal(results[0]?.status, 'rejected')
    assert.equal(fixture.repository.list('asset').length, 0)
    assert.equal(fixture.repository.list('reference').length, 0)
    assert.equal(fixture.repository.list('feedback').length, 0)
  } finally {
    release(); await Promise.allSettled([...(importing ? [importing] : []), ...(disposing ? [disposing] : [])]); await fixture.cleanup()
  }
})
