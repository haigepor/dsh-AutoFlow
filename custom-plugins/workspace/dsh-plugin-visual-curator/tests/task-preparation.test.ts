import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf } from '../src/host/runtime.ts'

const timingSchema = z.object({ policy: z.enum(['native-model', 'bounded']), deadlineEnforced: z.boolean(), configuredDeadlineMs: z.number(), deadlineAt: z.number().optional() })

test('preparation discovers usages without writing records or dispatching requests and rejects changed checked inputs', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 's', name: 'Profile' }))
    await f.action('reference-import', { operationId: 'i', styleId: style.id, expectedRevision: 1, files: [{ name: 'r.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'a', styleId: style.id, buildDataset: true }); await f.jobs.drain()
    const profile = f.repository.list('modelProfile')[0]!
    const count = f.repository.manifests().length, requests = f.http.operations.length
    const missing = z.object({ status: z.string(), missingFields: z.array(z.string()) }).parse(await f.action('task-prepare', { kind: 'search', releaseId: profile.id, taskBrief: 'Green images' }))
    assert.equal(missing.status, 'needs-input'); assert.ok(missing.missingFields.includes('usageRevisionId'))
    assert.equal(f.repository.manifests().length, count); assert.equal(f.http.operations.length, requests)
    const usage = z.object({ id: z.string(), presetId: z.string() }).parse(await f.action('usage-create', { operationId: 'u', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const page = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await f.action('usage-list'))
    assert.equal(page.items[0]?.id, usage.id)
    const preparationSchema = z.object({ status: z.literal('ready'), preparationDigest: z.string(), normalizedInput: z.record(z.string(), z.json()), timing: timingSchema })
    const preparationInput = { kind: 'search', releaseId: profile.id, usageRevisionId: usage.id, taskBrief: 'Green images', targetCount: 1 }
    const prepared = preparationSchema.parse(await f.action('task-prepare', preparationInput))
    const timingExpected = JSON.parse(await readFile(new URL('./fixtures/task-timing.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual(prepared.timing, timingExpected.bounded)
    assert.equal(Object.hasOwn(prepared.normalizedInput, 'timing'), false)
    assert.equal(z.object({ deadlineMs: z.number() }).parse(prepared.normalizedInput.budgets).deadlineMs, prepared.timing.configuredDeadlineMs)
    assert.deepEqual(preparationSchema.parse(await f.action('task-prepare', preparationInput)), prepared, 'Timing metadata must not change the normalized inputs or repeat preparation digest')
    const acceptedConfig = f.service.config
    f.service.updateConfiguration({ ...acceptedConfig, searchScreening: { ...acceptedConfig.searchScreening, enabled: false } })
    const directReview = z.object({ status: z.literal('ready'), summary: z.object({ searchScreening: z.json().optional() }) }).parse(await f.action('task-prepare', { kind: 'search', releaseId: profile.id, usageRevisionId: usage.id, taskBrief: 'Green images', targetCount: 1 }))
    assert.equal(Object.hasOwn(directReview.summary, 'searchScreening'), false)
    assert.equal(f.http.operations.length, requests)
    f.service.updateConfiguration(acceptedConfig)
    assert.equal(f.http.operations.length, requests)
    await assert.rejects(f.action('search-start', { ...prepared.normalizedInput, operationId: 'changed', taskBrief: 'Red images', preparationDigest: prepared.preparationDigest }), { code: 'revision-conflict' })
    const args = { ...prepared.normalizedInput, operationId: 'start', preparationDigest: prepared.preparationDigest }
    const first = await f.action('search-start', args); await f.jobs.drain()
    const runId = z.object({ runId: z.string() }).parse(first).runId
    const runTiming = z.object({ timing: timingSchema }).parse(await f.action('run-get', { runId })).timing
    assert.deepEqual(runTiming, { ...timingExpected.bounded, deadlineAt: dataOf(f.domain.require('run', runId)).budget.deadlineAt })
    const final = z.object({ styleId: z.string(), resultSummary: z.object({ selected: z.number() }), results: z.array(z.object({ kind: z.string(), selection: z.object({ kind: z.literal('selected') }) })) }).parse(await f.action('run-get', { runId, resultFilter: 'selected' }))
    assert.equal(final.styleId, style.id); assert.equal(final.resultSummary.selected, 1); assert.equal(final.results.length, 1); assert.equal(final.results[0]?.kind, 'crop')
    const allPage = z.object({ pageToken: z.string() }).parse(await f.action('run-get', { runId, resultFilter: 'all', pageSize: 1 }))
    await assert.rejects(f.action('run-get', { runId, resultFilter: 'selected', pageSize: 1, pageToken: allPage.pageToken }))
    assert.equal(z.object({ runId: z.string() }).parse(await f.action('search-start', args)).runId, z.object({ runId: z.string() }).parse(first).runId)
    f.service.updateConfiguration({ ...acceptedConfig, vision: { ...acceptedConfig.vision, backend: 'native' } })
    const nativePrepared = preparationSchema.parse(await f.action('task-prepare', preparationInput))
    assert.deepEqual(nativePrepared.timing, timingExpected.native)
    assert.deepEqual(nativePrepared.normalizedInput, prepared.normalizedInput, 'Route timing is read metadata, not a new accepted start parameter')
    assert.deepEqual(preparationSchema.parse(await f.action('task-prepare', preparationInput)), nativePrepared)
    assert.equal(z.object({ timing: timingSchema }).parse(await f.action('run-get', { runId })).timing.policy, 'bounded', 'Existing runs keep the policy of their saved configuration')
    const nativeArgs = { ...nativePrepared.normalizedInput, operationId: 'native-timing', preparationDigest: nativePrepared.preparationDigest }
    const nativeId = z.object({ runId: z.string() }).parse(await f.action('search-start', nativeArgs)).runId
    await f.jobs.drain()
    const savedBudget = dataOf(f.domain.require('run', nativeId)).budget
    const nativeView = z.object({ timing: timingSchema }).parse(await f.action('run-get', { runId: nativeId }))
    assert.deepEqual(nativeView.timing, timingExpected.native)
    assert(savedBudget.deadlineAt > 0, 'Native historical budget counters stay intact even though their deadline is not enforced')
    assert.deepEqual(dataOf(f.domain.require('run', nativeId)).budget, savedBudget)
    assert.equal(z.object({ runId: z.string() }).parse(await f.action('search-start', nativeArgs)).runId, nativeId)
    f.service.updateConfiguration(acceptedConfig)
    await assert.rejects(f.action('usage-save', { operationId: 'stale', presetId: usage.presetId, expectedCurrentRevisionId: 'wrong', name: 'Changed', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }), { code: 'revision-conflict' })
    const next = z.object({ id: z.string() }).parse(await f.action('usage-save', { operationId: 'next', presetId: usage.presetId, expectedCurrentRevisionId: usage.id, name: 'Square v2', output: { aspectP: 1, aspectQ: 1, targetWidth: 120, targetHeight: 120, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    assert.notEqual(next.id, usage.id)
    assert.deepEqual(z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await f.action('usage-list')).items.map(item => item.id), [next.id])
    assert.deepEqual(z.object({ usages: z.array(z.object({ usageRevisionId: z.string() })) }).parse(await f.action('snapshot')).usages.map(item => item.usageRevisionId), [next.id])
    await assert.rejects(f.action('search-start', { ...args, operationId: 'old-preparation' }), { code: 'revision-conflict' })
    assert.equal(z.object({ runId: z.string() }).parse(await f.action('search-start', args)).runId, runId)
  } finally { await f.cleanup() }
})
