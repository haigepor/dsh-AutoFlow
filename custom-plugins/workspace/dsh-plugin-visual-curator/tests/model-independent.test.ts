/** Saved reference data and task-selected reviewers through real service workflows and provider requests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { CuratorService } from '../src/host/service.ts'
import { DomainRepository } from '../src/domain/repository.ts'
import { CuratorDomain } from '../src/domain/curator.ts'
import { reviewerRevision } from '../src/host/config.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { planReferenceAnalysis, validObservationReuse } from '../src/host/reference-state.ts'
import { recipeSchema, styleStandardSchema } from '../src/shared/model.ts'

const identity = z.object({ id: z.string() }), started = z.object({ runId: z.string() })
const stateSchema = z.object({ digest: z.string(), total: z.number(), pending: z.number(), reusable: z.number(), changed: z.number(), entries: z.array(z.object({ state: z.string() })) })
const preparationSchema = z.object({ status: z.literal('ready'), preparationDigest: z.string(), normalizedInput: z.record(z.string(), z.json()), summary: z.object({ executionRecipe: recipeSchema }) })

async function analyzed(f: Awaited<ReturnType<typeof serviceFixture>>) {
  const styleId = identity.parse(await f.action('style-create', { operationId: 'style', name: 'Portable reference data' })).id
  await f.action('reference-import', { operationId: 'reference', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
  await f.action('reference-analyze', { operationId: 'analysis', styleId, buildDataset: true }); await f.jobs.drain()
  const profile = f.repository.list('modelProfile')[0]!
  assert.ok(profile)
  assert.equal(f.domain.require('run', profile.analysisRunId).status, 'completed')
  const usageId = identity.parse(await f.action('usage-create', { operationId: 'usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] })).id
  const args = { releaseId: profile.id, usageRevisionId: usageId, sourceId: 'images', taskBrief: 'Find muted green images.', queries: ['muted green landscape'], targetCount: 1 }
  return { styleId, profile, args }
}

test('changing reviewer retains analyzed references and export bytes while new search and crop use the selected model', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId, profile, args } = await analyzed(f)
    const original = structuredClone(profile), observations = structuredClone(f.repository.list('observation'))
    await f.action('export-start', { operationId: 'export-before', kind: 'style', purpose: 'reference', releaseId: profile.id }); await f.jobs.drain()
    const files = f.repository.list('profileExport')[0]!.files
    f.service.updateConfiguration({ ...f.service.config, vision: { ...f.service.config.vision, model: 'review-model-b', vendorVersion: 'b-v2' } })
    const state = stateSchema.parse(await f.action('reference-state', { styleId }))
    assert.deepEqual([state.total, state.reusable, state.pending, state.changed], [1, 1, 0, 0])
    const prepared = preparationSchema.parse(await f.action('task-prepare', { kind: 'search', ...args }))
    assert.equal(prepared.summary.executionRecipe.model, 'review-model-b')
    assert.equal(prepared.summary.executionRecipe.visionRevision, reviewerRevision(f.service.config))
    assert.notEqual(prepared.summary.executionRecipe.id, original.recipe.id)
    const models: string[] = [], send = f.http.request.bind(f.http)
    f.http.request = async (url, request) => {
      if (url.startsWith('https://vision.example.test')) models.push(z.object({ model: z.string() }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).model)
      return send(url, request)
    }
    const { runId } = started.parse(await f.action('search-start', { ...prepared.normalizedInput, operationId: 'search-b', preparationDigest: prepared.preparationDigest }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', runId)).error))
    assert.ok(models.length > 0); assert.ok(models.every(model => model === 'review-model-b'))
    const search = specOf(f.domain.require('run', runId)), effectiveRecipe = recipeSchema.parse(search.fixed.executionRecipe)
    assert.equal(styleStandardSchema.parse(search.fixed.release).recipe.model, 'fixture')
    assert.equal(search.config.vision.model, 'review-model-b')
    assert.ok(f.repository.list('assessment').filter(row => row.runId === runId).every(row => row.recipeId === effectiveRecipe.id))
    const imageId = f.repository.list('imageVersion').find(row => row.versionKind === 'normalized')!.id
    const crop = started.parse(await f.action('crop-start', { ...args, operationId: 'crop-b', imageVersionIds: [imageId] }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', crop.runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', crop.runId)).error))
    assert.equal(recipeSchema.parse(specOf(f.domain.require('run', crop.runId)).fixed.executionRecipe).model, 'review-model-b')
    await f.action('export-start', { operationId: 'export-after', kind: 'style', purpose: 'reference', releaseId: profile.id }); await f.jobs.drain()
    assert.ok(f.repository.list('profileExport').every(row => JSON.stringify(row.files) === JSON.stringify(files)))
    assert.deepEqual(f.domain.require('modelProfile', profile.id), original)
    assert.deepEqual(f.repository.list('observation'), observations)
    const actual = { referenceStates: state.entries.map(entry => entry.state), reusable: state.reusable, pending: state.pending, changed: state.changed,
      profileModel: original.model, executionModel: search.config.vision.model, actualRequestModels: [...new Set(models)], searchStatus: f.domain.require('run', runId).status,
      cropStatus: f.domain.require('run', crop.runId).status, profileUnchanged: true, observationsUnchanged: true, exportFilesUnchanged: true }
    assert.deepEqual(actual, JSON.parse(await readFile(new URL('./fixtures/model-independent.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

test('incremental analysis can reuse another model’s observations while full reanalysis and changed evidence still require confirmation', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId, profile } = await analyzed(f), observations = structuredClone(f.repository.list('observation'))
    const before = stateSchema.parse(await f.action('reference-state', { styleId }))
    f.service.updateConfiguration({ ...f.service.config, vision: { ...f.service.config.vision, model: 'review-model-b' } })
    const state = stateSchema.parse(await f.action('reference-state', { styleId }))
    assert.notEqual(state.digest, before.digest, 'An explicit reanalysis confirmation must still name the current reviewer')
    await assert.rejects(f.action('reference-analyze', { operationId: 'stale-confirmation', styleId, buildDataset: true, analysisMode: 'all', planDigest: before.digest }), { code: 'revision-conflict' })
    const index = f.http.operations.length
    const incremental = started.parse(await f.action('reference-analyze', { operationId: 'incremental-b', styleId, buildDataset: true, analysisMode: 'pending', planDigest: state.digest }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', incremental.runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', incremental.runId)).error))
    assert.deepEqual(f.http.operations.slice(index), ['summarize:'])
    assert.deepEqual(f.repository.list('observation'), observations)
    const spec = specOf(f.domain.require('run', incremental.runId))
    assert.equal(validObservationReuse(f.domain, spec.fixed, planReferenceAnalysis(f.domain, styleId, f.actor, recipeSchema.parse(spec.fixed.recipe)).reused, f.actor), true)
    const changed = planReferenceAnalysis(f.domain, styleId, f.actor, { ...profile.recipe, preprocessingVersion: 'changed-image-processing' })
    assert.deepEqual([changed.view.changed, changed.view.reusable], [1, 0])
    const rules = planReferenceAnalysis(f.domain, styleId, f.actor, { ...profile.recipe, promptVersion: 'changed-analysis-instructions' })
    assert.deepEqual([rules.view.changed, rules.view.reusable], [1, 0])
    await assert.rejects(f.action('reference-analyze', { operationId: 'unconfirmed', styleId, buildDataset: true, analysisMode: 'all' }), { code: 'constraint-conflict' })
    const confirmed = stateSchema.parse(await f.action('reference-state', { styleId })), calls = f.http.operations.length
    await f.action('reference-analyze', { operationId: 'full-b', styleId, buildDataset: true, analysisMode: 'all', planDigest: confirmed.digest }); await f.jobs.drain()
    assert.deepEqual(f.http.operations.slice(calls), ['analyze:', 'summarize:'])
    assert.equal(f.repository.list('observation').length, 2)
    assert.deepEqual(f.domain.require('observation', observations[0]!.id), observations[0])
  } finally { await f.cleanup() }
})

test('changing the chosen model after preparation requires preparing the new task again', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const { styleId, args } = await analyzed(f)
    const prepared = preparationSchema.parse(await f.action('task-prepare', { kind: 'search', ...args }))
    f.service.updateConfiguration({ ...f.service.config, vision: { ...f.service.config.vision, model: 'review-model-b' } })
    await assert.rejects(f.action('search-start', { ...prepared.normalizedInput, operationId: 'changed-model', preparationDigest: prepared.preparationDigest }), { code: 'revision-conflict' })
    assert.equal(stateSchema.parse(await f.action('reference-state', { styleId })).reusable, 1)
    assert.equal(f.repository.list('run').filter(run => specOf(run).kind === 'search').length, 0)
  } finally { await f.cleanup() }
})

test('a paused search resumes with its accepted reviewer after a service restart and a new model selection', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let restarted: CuratorService | undefined
  try {
    const { args } = await analyzed(f), send = f.http.request.bind(f.http), entered = Promise.withResolvers<void>()
    let hold = true
    const models: string[] = []
    f.http.request = async (url, request) => {
      if (url.startsWith('https://vision.example.test')) {
        models.push(z.object({ model: z.string() }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).model)
        if (hold) {
          entered.resolve()
          await new Promise<void>((resolve, reject) => { request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }); request.signal!.throwIfAborted() })
        }
      }
      return send(url, request)
    }
    const { runId } = started.parse(await f.action('search-start', { ...args, operationId: 'paused-a' }))
    await entered.promise
    await f.action('run-control', { runId, command: 'pause' })
    assert.equal(f.domain.require('run', runId).status, 'paused')
    const frozen = structuredClone(specOf(f.domain.require('run', runId)))
    await f.service.dispose(); hold = false
    restarted = new CuratorService(f.host, { ...f.service.config, vision: { ...f.service.config.vision, model: 'review-model-b' } }, { openDomain: async files => new CuratorDomain(f.profileId, new DomainRepository(f.profileId, f.adapter), { verifyImage: async image => { await files.verifyReference(image.blob) } }), providers: f.providers })
    await restarted.initialize()
    await restarted.action({ operation: 'run-control', args: { runId, command: 'resume' } }, f.actor, new AbortController().signal)
    await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run).error))
    assert.deepEqual(specOf(run), frozen)
    assert.ok(models.length > 1); assert.ok(models.every(model => model === 'fixture'))
    assert.equal(restarted.config.vision.model, 'review-model-b')
  } finally { await restarted?.dispose(); await f.cleanup() }
})
