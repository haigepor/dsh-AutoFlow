/** Selected-role observations consolidate into one immutable full package without interrupting searches of saved versions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { datasetListSchema } from '../src/shared/datasets.ts'
import { referenceStateSchema, selectAnalysisReferences } from '../src/shared/reference-state.ts'
import { observationRole, referenceRoleInstruction } from '../src/host/analysis-selection.ts'
import { ModelProfiles } from '../src/domain/model-profile.ts'
import { CuratorError } from '../src/shared/errors.ts'

const identity = z.object({ id: z.string() }), started = z.object({ runId: z.string() })
const modelRequest = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }))]) })) })
function prompt(body: Uint8Array) {
  const content = modelRequest.parse(JSON.parse(Buffer.from(body).toString('utf8'))).messages.find(message => message.role === 'user')!.content
  assert.ok(Array.isArray(content))
  return z.object({ input: z.object({ operation: z.string(), taskBrief: z.string(), images: z.array(z.object({ imageVersionId: z.string() })) }) }).parse(JSON.parse(content[0]!.text!)).input
}

async function collection(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const styleId = identity.parse(await f.action('style-create', { operationId: 'style', name: 'Positive and negative references' })).id
  await f.action('reference-import', { operationId: 'references', styleId, expectedRevision: 1, files: [
    { name: 'positive.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] },
    { name: 'negative.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'negative', intent: 'overall', dimensions: [] },
  ] })
  return styleId
}

test('positive-only then negative-only analysis retains both sets, uses distinct prompts and automatically pins the consolidated dataset', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = await collection(f), send = f.http.request.bind(f.http), roles: string[] = [], instructions: string[] = []
    f.http.request = async (url, request) => {
      if (url.startsWith('https://vision.example.test')) {
        const input = prompt(request.body!)
        if (input.operation === 'analyze') {
          const brief = z.object({ analysisRole: z.string(), instruction: z.string() }).parse(JSON.parse(input.taskBrief))
          roles.push(brief.analysisRole); instructions.push(brief.instruction)
          const expectedRole = brief.analysisRole
          assert.ok(input.images.every(image => f.repository.list('reference').some(ref => ref.imageVersionId === image.imageVersionId && ref.role === expectedRole)))
        }
      }
      return send(url, request)
    }
    const positive = started.parse(await f.action('reference-analyze', { operationId: 'positive', styleId, analysisScope: 'positive' }))
    await f.jobs.drain()
    const partial = f.domain.require('run', positive.runId)
    assert.equal(partial.status, 'completed', JSON.stringify(dataOf(partial).error))
    assert.deepEqual(f.http.operations, ['analyze:', 'summarize:'])
    const observationPackage = f.repository.list('profileExport')[0]!
    assert.equal(observationPackage.sampleScope, 'observations')
    assert.equal(observationPackage.resources.length, 1)
    assert.equal(dataOf(partial).checkpoint.observationDatasetId, observationPackage.id)
    assert.equal(f.repository.list('modelProfile')[0]!.rules.length, 0)
    assert.equal(datasetListSchema.parse(await f.action('datasets-list', { styleId, reusableOnly: true })).total, 0)
    const partialDetail = z.object({ task: z.object({ observed: z.number(), total: z.number(), awaitingReferences: z.number() }) }).parse(await f.action('analysis-detail', { runId: positive.runId }))
    assert.deepEqual(partialDetail.task, { observed: 1, total: 1, awaitingReferences: 1 })
    const firstObservation = structuredClone(f.repository.list('observation')[0]!)
    const negative = started.parse(await f.action('reference-analyze', { operationId: 'negative', styleId, buildDataset: true, analysisScope: 'negative' }))
    await f.jobs.drain()
    const complete = f.domain.require('run', negative.runId)
    assert.equal(complete.status, 'completed', JSON.stringify(dataOf(complete).error))
    assert.deepEqual(roles, ['positive', 'negative'])
    assert.match(instructions[0]!, /POSITIVE style references/); assert.match(instructions[1]!, /NEGATIVE counterexamples/)
    assert.doesNotMatch(instructions[0]!, /These are NEGATIVE/)
    assert.deepEqual(f.domain.require('observation', firstObservation.id), firstObservation)
    assert.deepEqual(f.http.operations, ['analyze:', 'summarize:', 'analyze:', 'summarize:'])
    const profile = f.repository.list('modelProfile').find(item => item.analysisRunId === negative.runId)!, artifact = f.repository.list('profileExport').find(item => item.modelProfileId === profile.id)!
    assert.ok(artifact, 'A completed full analysis must publish its checksummed dataset without another click')
    assert.equal(artifact.modelProfileId, profile.id)
    assert.equal(dataOf(complete).checkpoint.finalDatasetId, artifact.id)
    const exported = JSON.parse(artifact.files.find(file => file.name === 'style-profile.json')!.content)
    assert.ok(exported.matchingPrompt.length > 0)
    assert.equal(profile.references.length, 2)
    assert.deepEqual(JSON.parse(f.http.summaryInputs[1]!).samples.map((sample: { role: string }) => sample.role).sort(), ['negative', 'positive'])
    assert.deepEqual(f.domain.require('profileExport', observationPackage.id), observationPackage)
    await f.action('export-start', { operationId: 'later-negative-observations', kind: 'style', purpose: 'reference', releaseId: profile.id, sampleScope: 'negative' }); await f.jobs.drain()
    const page = datasetListSchema.parse(await f.action('datasets-list', { styleId }))
    assert.equal(page.entries[0]!.exportId, artifact.id)
    assert.equal(page.entries[0]!.isFinal, true)
    assert.equal(page.entries[0]!.stale, false)
    assert.equal(page.entries[1]!.sampleScope, 'negative')
    const plan = referenceStateSchema.parse(await f.action('reference-state', { styleId }))
    assert.equal(selectAnalysisReferences(plan, 'positive').reusable, 1)
    assert.equal(selectAnalysisReferences(plan, 'negative').reusable, 1)
    assert.equal(new ModelProfiles(f.domain).isFresh(profile, f.actor, 'wrong-finalizing-run'), true)
    const actual = { observedRoles: roles, perImageCalls: 2, summaryCalls: f.http.summaryInputs.length, partialPackageScope: observationPackage.sampleScope, retainedPositiveObservation: true, fullDatasetReferences: profile.references.length,
      finalRowScope: page.entries[0]!.sampleScope, finalRowPinned: page.entries[0]!.isFinal, laterObservationScope: page.entries[1]!.sampleScope, matchingPromptSaved: !!exported.matchingPrompt }
    assert.deepEqual(actual, JSON.parse(await readFile(new URL('./fixtures/analysis-selection.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

test('reanalyzing one role preserves the other role and empty or invalid role selections spend no calls', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = await collection(f)
    await f.action('reference-analyze', { operationId: 'all', styleId, buildDataset: true }); await f.jobs.drain()
    const plan = referenceStateSchema.parse(await f.action('reference-state', { styleId }))
    const positiveIds = new Set<string>(plan.entries.filter(entry => entry.role === 'positive').map(entry => entry.imageVersionId))
    const original = f.repository.list('observation').find(observation => positiveIds.has(observation.imageVersionId))!
    const offset = f.http.operations.length
    await f.action('reference-analyze', { operationId: 'negative-again', styleId, buildDataset: true, analysisMode: 'all', analysisScope: 'negative', planDigest: plan.digest }); await f.jobs.drain()
    assert.deepEqual(f.http.operations.slice(offset), ['analyze:', 'summarize:'])
    assert.deepEqual(f.domain.require('observation', original.id), original)
    await assert.rejects(f.action('reference-analyze', { operationId: 'invalid-scope', styleId, buildDataset: true, analysisScope: 'invented' }), { code: 'invalid-input' })
    assert.equal(observationRole([{ role: 'positive' }, { role: 'negative' }]), 'mixed')
    assert.match(referenceRoleInstruction('mixed'), /CONFLICTING/)
  } finally { await f.cleanup() }
})

test('negative-only collections retain counterexamples without fabricating a target style or complete package', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = identity.parse(await f.action('style-create', { operationId: 's', name: 'Counterexamples' })).id
    await f.action('reference-import', { operationId: 'negative-reference', styleId, expectedRevision: 1, files: [{ name: 'n.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'negative', intent: 'overall', dimensions: [] }] })
    await assert.rejects(f.action('reference-analyze', { operationId: 'empty-positive', styleId, buildDataset: true, analysisScope: 'positive' }), { code: 'invalid-input' })
    assert.equal(f.http.operations.length, 0)
    const { runId } = started.parse(await f.action('reference-analyze', { operationId: 'negative-only', styleId, buildDataset: true, analysisScope: 'negative' })); await f.jobs.drain()
    assert.equal(f.domain.require('run', runId).status, 'completed')
    assert.equal(dataOf(f.domain.require('run', runId)).checkpoint.analysisNeedsPositiveReferences, true)
    assert.equal(f.repository.list('observation').length, 1)
    const saved = f.repository.list('profileExport')[0]!
    assert.equal(saved.sampleScope, 'observations')
    assert.equal(saved.resources.length, 1)
    assert.equal(dataOf(f.domain.require('run', runId)).checkpoint.observationDatasetId, saved.id)
    assert.equal(datasetListSchema.parse(await f.action('datasets-list', { styleId, reusableOnly: true })).total, 0)
    assert.deepEqual(f.http.operations, ['analyze:', 'summarize:'])
  } finally { await f.cleanup() }
})

test('ordinary analysis automatically organizes and saves positive and undecided collections even with the legacy false flag', async () => {
  for (const role of ['positive', 'undecided'] as const) {
    const f = await serviceFixture(); await f.service.initialize()
    try {
      const styleId = identity.parse(await f.action('style-create', { operationId: 'ordinary-style', name: 'Automatic dataset' })).id
      await f.action('reference-import', { operationId: 'ordinary-reference', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role, intent: 'overall', dimensions: [] }] })
      const { runId } = started.parse(await f.action('reference-analyze', { operationId: 'ordinary-analysis', styleId, ...(role === 'undecided' ? { buildDataset: false } : {}) })); await f.jobs.drain()
      const run = f.domain.require('run', runId), saved = f.repository.list('profileExport')[0]!
      assert.equal(run.status, 'completed', JSON.stringify(dataOf(run).error))
      assert.deepEqual(f.http.operations, ['analyze:', 'summarize:'])
      assert.ok(saved)
      assert.equal(saved.resources.length, 1)
      assert.equal(saved.sampleScope ?? 'all', role === 'positive' ? 'all' : 'observations')
      assert.equal(specOf(run).input.buildDataset, true)
    } finally { await f.cleanup() }
  }
})

test('failed automatic package commits resume from saved induction without another model call or duplicate dataset', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const commit = f.repository.commit.bind(f.repository)
  try {
    const styleId = await collection(f)
    let fail = true
    f.repository.commit = async input => {
      if (fail && input.records.some(record => record.kind === 'profileExport')) { fail = false; throw new CuratorError('storage-commit-failed', 'storage-commit', 'Injected dataset write failure before publication.', { retryable: true, storage: { operation: 'manifest', code: 'EBUSY', attempts: 1, disposition: 'retryable' } }) }
      return commit(input)
    }
    const { runId } = started.parse(await f.action('reference-analyze', { operationId: 'retry-package', styleId, buildDataset: true })); await f.jobs.drain()
    const failed = f.domain.require('run', runId)
    assert.equal(failed.status, 'failed')
    assert.equal(dataOf(failed).error?.stage, 'dataset-export')
    assert.equal(dataOf(failed).error?.retryable, true)
    assert.equal(f.repository.list('observation').length, 2)
    assert.equal(f.repository.list('profileExport').length, 0)
    const paidCalls = f.http.operations.length
    await f.action('run-control', { runId, command: 'resume' }); await f.jobs.drain()
    assert.equal(f.domain.require('run', runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', runId)).error))
    assert.equal(f.http.operations.length, paidCalls)
    assert.equal(f.repository.list('profileExport').length, 1)
    assert.ok(dataOf(f.domain.require('run', runId)).checkpoint.finalDatasetId)
  } finally { f.repository.commit = commit; await f.cleanup() }
})

test('a collection changed during analysis retains observations and reports that no current dataset was saved', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = await collection(f), send = f.http.request.bind(f.http)
    let changed = false
    f.http.request = async (url, request) => {
      if (!changed && url.startsWith('https://vision.example.test') && prompt(request.body!).operation === 'summarize') {
        changed = true
        await f.action('reference-import', { operationId: 'late-reference', styleId, expectedRevision: f.domain.require('style', styleId).revision, files: [{ name: 'late-positive.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
      }
      return await send(url, request)
    }
    const { runId } = started.parse(await f.action('reference-analyze', { operationId: 'changed-collection', styleId })); await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.status, 'failed')
    assert.equal(dataOf(run).error?.code, 'revision-conflict')
    assert.equal(dataOf(run).error?.stage, 'dataset-export')
    assert.equal(f.repository.list('observation').length, 2)
    assert.ok(dataOf(run).checkpoint.styleAnalysis)
    assert.equal(f.repository.list('profileExport').length, 0)
  } finally { await f.cleanup() }
})

test('saved full datasets remain usable while a newer analysis is running or paused, with current model selection', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = await collection(f)
    await f.action('reference-analyze', { operationId: 'baseline', styleId, buildDataset: true }); await f.jobs.drain()
    const dataset = f.repository.list('profileExport')[0]!, profile = f.domain.require('modelProfile', dataset.modelProfileId)
    await f.action('reference-import', { operationId: 'new-reference', styleId, expectedRevision: f.domain.require('style', styleId).revision, files: [{ name: 'new.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    assert.equal(new ModelProfiles(f.domain).isFresh(profile, f.actor), false)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), send = f.http.request.bind(f.http)
    f.http.request = async (url, request) => {
      if (url.startsWith('https://vision.example.test') && prompt(request.body!).operation === 'analyze') {
        entered.resolve()
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(request.signal!.reason)
          request.signal!.addEventListener('abort', abort, { once: true })
          release.promise.then(() => { request.signal!.removeEventListener('abort', abort); resolve() })
          request.signal!.throwIfAborted()
        })
      }
      return send(url, request)
    }
    const analysisIndex = f.jobs.hooks.length
    const analysis = started.parse(await f.action('reference-analyze', { operationId: 'working', styleId, buildDataset: true }))
    await Promise.race([entered.promise, f.jobs.hooks[analysisIndex]!.done.then(() => { throw new Error('Analysis ended before reaching the request barrier') })])
    f.service.updateConfiguration({ ...f.service.config, vision: { ...f.service.config.vision, model: 'different-reviewer' } })
    const usageId = identity.parse(await f.action('usage-create', { operationId: 'usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] })).id
    const args = { releaseId: profile.id, datasetId: dataset.id, usageRevisionId: usageId, taskBrief: 'Find muted green candidates.', sourceId: 'images', queries: ['green'], targetCount: 1 }
    for (const status of ['running', 'paused'] as const) {
      if (status === 'paused') {
        await f.action('run-control', { runId: analysis.runId, command: 'pause', waitForCompletion: false })
        release.resolve(); await f.jobs.hooks[analysisIndex]!.done
      }
      const prepared = z.object({ status: z.literal('ready') }).parse(await f.action('task-prepare', { kind: 'search', ...args }))
      assert.equal(prepared.status, 'ready')
      const index = f.jobs.hooks.length
      const search = started.parse(await f.action('search-start', { ...args, operationId: `search-${status}` }))
      await f.jobs.hooks[index]!.done
      assert.equal(f.domain.require('run', search.runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', search.runId)).error))
      const spec = specOf(f.domain.require('run', search.runId))
      assert.equal(spec.config.vision.model, 'different-reviewer')
      assert.equal(spec.input.datasetId, dataset.id)
      assert.equal(f.domain.require('run', analysis.runId).status, status)
    }
    await assert.rejects(f.action('search-start', { ...args, operationId: 'wrong-package', datasetId: 'missing' }), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})
