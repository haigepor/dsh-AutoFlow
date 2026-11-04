import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf } from '../src/host/runtime.ts'
import { fileChecksum, MemoryDomainAdapter, type CommitInput } from '../src/domain/repository.ts'
import { ModelProfiles } from '../src/domain/model-profile.ts'
import { profileProjectionFixture } from './helpers/profile-projection-fixture.ts'
import { readFile } from 'node:fs/promises'
import { createCuratorStore } from '../src/client/store.ts'
import { profileSaveReceiptSchema } from '../src/shared/profile-selection.ts'
import sharp from 'sharp'

async function recognized(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const { id } = z.object({ id: z.string() }).parse(await f.action('style-create', { name: 'Automatic profile', operationId: 'auto-style' }))
  const reference = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#617a48' } }).png().toBuffer()
  await f.action('reference-import', { operationId: 'auto-import', styleId: id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: reference.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'auto-analysis', styleId: id, buildDataset: true }))
  await f.jobs.drain()
  assert.equal(f.domain.require('run', runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', runId)).error))
  return { styleId: id, runId }
}

test('rule selection saves and reconciliation retain loaded observations without workspace reads', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const operations: string[] = []
  const store = createCuratorStore({ invoke: (operation, args) => { operations.push(operation); return f.action(operation, args) } })
  try {
    const { styleId, runId } = await recognized(f)
    await store.reload()
    await store.reconcileProfile(styleId)
    const before = store.getSnapshot(), original = before.snapshot!.styles.find(style => style.styleId === styleId)!.modelProfile!
    operations.length = 0
    const saved = profileSaveReceiptSchema.parse(await store.execute('profile-save', { operationId: 'quick-selection', styleId, analysisRunId: runId, expectedProfileId: original.id, changes: [{ ruleId: original.options[0]!.rule.ruleId, enabled: false }] }))
    const after = store.getSnapshot(), profile = after.snapshot!.styles.find(style => style.styleId === styleId)!.modelProfile!
    assert.deepEqual(operations, ['profile-save'])
    assert.equal(profile.id, saved.id)
    assert.equal(profile.options[0]!.enabled, false)
    assert.strictEqual(profile.samples, original.samples)
    assert.strictEqual(profile.summary, original.summary)
    assert.strictEqual(after.snapshot!.images, before.snapshot!.images)
    assert.strictEqual(after.referencePages[styleId], before.referencePages[styleId])
    const latest = profileSaveReceiptSchema.parse(await f.action('profile-save', { operationId: 'outside-selection', styleId, analysisRunId: runId, expectedProfileId: profile.id, changes: [{ ruleId: profile.options[0]!.rule.ruleId, enabled: true }] }))
    operations.length = 0
    await store.reconcileProfile(styleId)
    const reconciled = store.getSnapshot().snapshot!.styles.find(style => style.styleId === styleId)!.modelProfile!
    assert.deepEqual(operations, ['profile-current'])
    assert.equal(reconciled.id, latest.id)
    assert.equal(reconciled.options[0]!.enabled, true)
    assert.strictEqual(reconciled.samples, original.samples)
    assert.equal('samples' in saved, false)
  } finally { store.dispose(); await f.cleanup() }
})

test('profile freshness checks authorize every image while verifying shared records once per read', async context => {
  const f = await profileProjectionFixture(41)
  try {
    const profile = f.repository.list('modelProfile').find(row => row.styleId === f.styleIds[0])!, profiles = new ModelProfiles(f.domain)
    const adapter: unknown = Reflect.get(f.repository, 'adapter')
    assert.ok(adapter instanceof MemoryDomainAdapter)
    const reads = context.mock.method(adapter, 'readRecord'), authorized = context.mock.method(f.domain, 'authorizedImage')
    assert.equal(profiles.isFresh(profile, f.actor), true)
    assert.equal(authorized.mock.calls.filter(call => profile.references.some(ref => ref.reference.imageVersionId === call.arguments[0])).length, profile.references.length)
    assert.equal(reads.mock.calls.filter(call => call.result?.kind === 'asset').length, 1)
    reads.mock.resetCalls()
    assert.equal(profiles.isFresh(profile, f.actor), true)
    assert.equal(reads.mock.calls.filter(call => call.result?.kind === 'asset').length, 1, 'Independent reads must verify the shared record again')
    const imageId = profile.references[0]!.reference.imageVersionId, manifest = f.repository.manifests().find(row => row.records.some(record => record.kind === 'imageVersion' && record.id === imageId))!, pointer = manifest.records.find(record => record.kind === 'imageVersion' && record.id === imageId)!
    const image = f.domain.require('imageVersion', imageId)
    adapter.records.set(pointer.key, { ...image, geometry: { ...image.geometry, width: image.geometry.width + 1 } })
    assert.throws(() => profiles.isFresh(profile, f.actor), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})

test('a reference change during selection commit is visible in the returned freshness receipt', async context => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId, runId } = await recognized(f), profile = f.repository.list('modelProfile')[0]!, commit = f.repository.commit.bind(f.repository)
    context.mock.method(f.repository, 'commit', async (input: CommitInput) => {
      const result = await commit(input)
      if (input.operationId === 'concurrent-selection') {
        const style = f.domain.require('style', styleId)
        await f.action('reference-import', { operationId: 'concurrent-reference', styleId, expectedRevision: style.revision, files: [{ name: 'late-reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'negative', intent: 'overall', dimensions: [] }] })
      }
      return result
    })
    const saved = profileSaveReceiptSchema.parse(await f.action('profile-save', { operationId: 'concurrent-selection', styleId, analysisRunId: runId, expectedProfileId: profile.id, changes: [{ ruleId: profile.options[0]!.rule.ruleId, enabled: false }] }))
    assert.equal(saved.stale, true)
    await assert.rejects(f.action('profile-save', { operationId: 'after-concurrent-reference', styleId, analysisRunId: runId, expectedProfileId: saved.id, changes: [{ ruleId: profile.options[0]!.rule.ruleId, enabled: true }] }), { code: 'revision-conflict' })
  } finally { await f.cleanup() }
})

test('completed vision analysis automatically adopts traceable rules and exports reference data without human publication or split confirmation', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId, runId } = await recognized(f)
    const profile = f.repository.list('modelProfile')[0]
    assert.ok(profile, 'Analysis must persist its automatic model profile')
    assert.equal(profile.analysisRunId, runId)
    assert.ok(profile.rules.length > 0)
    assert.ok(profile.rules.every(rule => rule.confirmation.status === 'suggested'))
    assert.equal(f.repository.list('release').length, 0)
    assert.equal(f.repository.list('split').length, 0)
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).rules.length, 0)
    const { runId: exportRun } = z.object({ runId: z.string() }).parse(await f.action('export-start', { operationId: 'auto-export', kind: 'style', purpose: 'reference', releaseId: profile.id, mode: 'references-only' }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', exportRun).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', exportRun)).error))
    const exported = f.repository.list('profileExport')[0]!
    assert.equal(exported.modelProfileId, profile.id)
    assert.equal(exported.analysisRunId, runId)
    const content = JSON.parse(exported.files.find(file => file.name === 'style-profile.json')!.content)
    assert.equal(content.formatVersion, 2)
    assert.equal(content.ruleSource, 'model-adopted')
    assert.ok(content.activeRules.length)
    assert.equal('confirmedBy' in content, false)
    const expected = JSON.parse(await readFile(new URL('./fixtures/model-profile.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ formatVersion: content.formatVersion, ruleSource: content.ruleSource, ruleConfirmations: content.activeRules.map((rule: { confirmation: { status: string } }) => rule.confirmation.status), files: exported.files.map(file => file.name), humanReleaseCount: f.repository.list('release').length, splitCount: f.repository.list('split').length }, expected)
    for (const file of exported.files) assert.equal(fileChecksum(file.content), file.checksum)
    const response = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?exportId=${exported.id}`))
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(await response.text()).formatVersion, 2)
  } finally { await f.cleanup() }
})

test('automatic profiles start style-guided search with the same immutable rules and reject an empty selection', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId, runId } = await recognized(f)
    const profile = f.repository.list('modelProfile')[0]!
    const usage = z.object({ id: z.string() }).parse(await f.action('usage-create', { operationId: 'auto-usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const job = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'auto-search', releaseId: profile.id, usageRevisionId: usage.id, sourceId: 'images', taskBrief: 'Muted green images', queries: ['green'], targetCount: 1 }))
    await f.jobs.drain()
    const run = f.domain.require('run', job.runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run).error))
    assert.ok(f.repository.list('assessment').some(row => row.standard?.kind === 'modelProfile' && row.standard.id === profile.id))
    const saved = z.object({ id: z.string() }).parse(await f.action('profile-save', { operationId: 'disable-all', styleId, analysisRunId: runId, expectedProfileId: profile.id, changes: profile.options.map(option => ({ ruleId: option.rule.ruleId, enabled: false })) }))
    await assert.rejects(f.action('export-start', { operationId: 'empty-export', kind: 'style', purpose: 'reference', releaseId: saved.id }), { code: 'constraint-conflict' })
  } finally { await f.cleanup() }
})

test('an Agent export of a library profile remains Session-owned and cannot be read through another Session or the unscoped resource route', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    await recognized(f)
    const profile = f.repository.list('modelProfile')[0]!
    const actor = { kind: 'agent' as const, id: 'agent-a', profileId: f.profileId, sessionId: 'session-a' }
    const { runId } = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'export-start', args: { operationId: 'session-profile-export', kind: 'style', purpose: 'reference', releaseId: profile.id } }, actor, new AbortController().signal))
    await f.jobs.drain()
    const exported = f.repository.list('profileExport').find(row => dataOf(f.domain.require('run', runId)).resultIds.includes(row.id))!
    assert.deepEqual(exported.access, { kind: 'session-run', sessionId: 'session-a' })
    await assert.rejects(f.service.action({ operation: 'export-get', args: { exportId: exported.id } }, { ...actor, sessionId: 'session-b' }, new AbortController().signal), { code: 'owner-denied' })
    assert.equal((await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?exportId=${exported.id}`))).status, 403)
  } finally { await f.cleanup() }
})

test('profile edits create immutable versions, reject stale writers and retain model authorship', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId, runId } = await recognized(f)
    const original = f.repository.list('modelProfile')[0]!
    const rule = original.options[0]!
    const args = { operationId: 'edit-profile', styleId, analysisRunId: runId, expectedProfileId: original.id, changes: [{ ruleId: rule.rule.ruleId, enabled: true, statement: 'Prefer soft green photographs.' }] }
    const result = z.object({ id: z.string() }).parse(await f.action('profile-save', args))
    const updated = f.domain.require('modelProfile', result.id)
    assert.notEqual(updated.id, original.id)
    assert.equal(f.domain.require('modelProfile', original.id).options[0]!.rule.statement, rule.rule.statement)
    assert.equal(updated.options[0]!.rule.statement, 'Prefer soft green photographs.')
    assert.equal(updated.options[0]!.selectionSource, 'user')
    assert.equal(updated.options[0]!.rule.confirmation.status, 'suggested')
    assert.equal(z.object({ id: z.string() }).parse(await f.action('profile-save', args)).id, updated.id)
    await assert.rejects(f.action('profile-save', { ...args, operationId: 'stale-profile-writer' }), { code: 'revision-conflict' })
    await assert.rejects(f.action('profile-save', { ...args, operationId: 'unknown-rule', expectedProfileId: updated.id, changes: [{ ruleId: 'foreign-rule', enabled: true }] }), { code: 'invalid-input' })
    await assert.rejects(f.action('export-start', { operationId: 'model-training', kind: 'classification', purpose: 'training', releaseId: updated.id }), { code: 'constraint-conflict' })
    const style = f.domain.require('style', styleId)
    await f.action('reference-import', { operationId: 'new-reference', styleId, expectedRevision: style.revision, files: [{ name: 'another.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'negative', intent: 'overall', dimensions: [] }] })
    await assert.rejects(f.action('export-start', { operationId: 'stale-profile-export', kind: 'style', purpose: 'reference', releaseId: updated.id }), { code: 'revision-conflict' })
  } finally { await f.cleanup() }
})

test('failed cross-image organization retains private diagnostics and retries only the saved observation matrix', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId } = await recognized(f)
    const original = f.repository.list('modelProfile')[0]!
    const observationIds = f.repository.list('observation').map(row => row.id)
    f.http.mode = 'foreign-summary-evidence'
    const failed = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { styleId, operationId: 'failed-organization', buildDataset: true }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', failed.runId).status, 'failed')
    const rejected = f.repository.list('request').find(row => row.runId === failed.runId && row.state === 'outcome-unknown')!
    assert.ok(JSON.stringify(rejected.data).includes('invalid-image-evidence-or-dimensions'))
    const snapshot = z.object({ styles: z.array(z.object({ modelProfile: z.object({ id: z.string(), stale: z.boolean(), samples: z.array(z.unknown()) }) })) }).parse(await f.action('snapshot'))
    assert.equal(snapshot.styles[0]!.modelProfile.id, original.id)
    assert.equal(snapshot.styles[0]!.modelProfile.stale, false)
    assert.equal(JSON.stringify(await f.action('snapshot')).includes('invalid-image-evidence-or-dimensions'), false)
    const previousCalls = f.http.operations.length
    f.http.mode = 'pass'
    const resumed = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { styleId, operationId: 'retry-organization', buildDataset: true }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', resumed.runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', resumed.runId)).error))
    assert.deepEqual(f.http.operations.slice(previousCalls), ['summarize:'])
    assert.deepEqual(f.repository.list('observation').map(row => row.id), observationIds)
    assert.equal(f.repository.list('modelProfile').length, 2)
  } finally { await f.cleanup() }
})
