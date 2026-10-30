import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf } from '../src/host/runtime.ts'
import { fileChecksum } from '../src/domain/repository.ts'
import { readFile } from 'node:fs/promises'

async function recognized(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const { id } = z.object({ id: z.string() }).parse(await f.action('style-create', { name: 'Automatic profile', operationId: 'auto-style' }))
  await f.action('reference-import', { operationId: 'auto-import', styleId: id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'auto-analysis', styleId: id, buildDataset: true }))
  await f.jobs.drain()
  assert.equal(f.domain.require('run', runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', runId)).error))
  return { styleId: id, runId }
}

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
    await f.service.action({ operation: 'export-start', args: { operationId: 'session-profile-export', kind: 'style', purpose: 'reference', releaseId: profile.id } }, actor, new AbortController().signal)
    await f.jobs.drain()
    const exported = f.repository.list('profileExport')[0]!
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
