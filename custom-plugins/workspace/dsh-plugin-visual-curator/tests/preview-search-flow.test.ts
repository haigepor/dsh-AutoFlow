import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { CuratorDomain } from '../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { resolveConfig } from '../src/host/config.ts'
import { createSearchWorker } from '../src/host/search-workflow.ts'
import { RunEngine, dataOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { projectRun } from '../src/host/projection.ts'
import { matchStyle } from '../src/host/style-execution.ts'
import { AssetFiles, CompatibleVisionProvider, type HttpClient } from '../src/media/index.ts'
import { UnsplashApi, UnsplashSourceProvider } from '../src/media/unsplash.ts'
import { modelProfileSchema, recipeSchema, styleSchema, draftSchema } from '../src/shared/model.ts'
import { searchOutputSchema } from '../src/shared/search-launch.ts'
import { FixtureJobs } from './helpers/service-fixture.ts'

const base = { schemaVersion: 1, profileId: 'preview-test', createdAt: '2026-10-29T00:00:00.000Z' }
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'fixture', model: 'fixture', vendorVersion: null, promptVersion: 'visual-curator-rules-v2', outputSchemaVersion: 'v1', preprocessingVersion: 'v1', referenceStrategy: { maxImages: 4, maxBytes: 1000000 }, preferenceScale: { min: 0, max: 1, weights: { subject: 1, color: 1, composition: 1 } }, styleMatching: { version: 2, minSatisfiedRatio: 0.75 }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const rules = (['subject', 'color', 'composition'] as const).map(dimension => ({ ruleId: dimension, dimension, statement: `Match the reference ${dimension}.`, condition: {}, strength: 'preferred' as const, stage: 'source' as const, check: { kind: 'visual' as const, criterion: `Inspect ${dimension}.` }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'suggested' as const } }))
const profile = modelProfileSchema.parse({ ...base, id: 'model-profile-preview', kind: 'modelProfile', styleId: 'style', draftId: 'draft', draftRevision: 1, access: { kind: 'profile-library' }, analysisRunId: 'analysis', referenceDigest: `sha256-v1:${'a'.repeat(64)}`, contentDigest: `sha256-v1:${'b'.repeat(64)}`, revision: 1, model: 'fixture', matchingPrompt: 'A complete vehicle in an environmental portrait.', rules, references: [], recipe, groups: [], options: rules.map(rule => ({ rule, enabled: true, groupId: null, selectionSource: 'model', sourceStatement: rule.statement, reason: 'consistent' })) })

test('preview output is an explicit output choice without a crop usage', () => {
  assert.deepEqual(searchOutputSchema.parse({ kind: 'preview' }), { kind: 'preview' })
})

test('known violations reject even when the remaining unknown rule cannot reach the threshold', () => {
  const result = matchStyle(profile, [{ ruleId: 'subject', result: 'violated' }, { ruleId: 'color', result: 'violated' }, { ruleId: 'composition', result: 'unknown' }], 0.75)
  assert.equal(result.verdict, 'not-matched')
  assert.equal(matchStyle(profile, rules.map(rule => ({ ruleId: rule.ruleId, result: 'unknown' })), 0.75).verdict, 'unknown')
})

async function fixture(block = false) {
  const root = await mkdtemp(join(tmpdir(), 'visual-preview-flow-'))
  const repository = new DomainRepository(base.profileId, new MemoryDomainAdapter())
  const domain = new CuratorDomain(base.profileId, repository)
  const jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
  const config = resolveConfig({ source: { provider: 'unsplash' }, limits: { maxRetryAttempts: 0, maxSearchPages: 4, maxVisionCalls: 8, pageSize: 2 } })
  const files = new AssetFiles(root, { maxFileBytes: 1000000, maxPixels: 1000000, maxDimension: 2000, previewMaxDimension: 200, maxStorageBytes: 10000000 })
  files.read = async () => { throw new Error('Preview flow must not read local subject pixels') }
  const queries: string[] = [], remoteInputs: string[] = []
  let downloads = 0
  let entered!: () => void
  const reviewing = new Promise<void>(resolve => { entered = resolve })
  const source = new UnsplashSourceProvider(new UnsplashApi({ async request(path, params) {
    assert.equal(path, '/search/photos')
    queries.push(String(params.query))
    const ids = params.query === 'broad car photography' ? ['portrait', 'portrait-again'] : ['matching-car']
    return { results: ids.map(id => ({ id, width: 1200, height: 800, premium: true, urls: { small: `https://images.unsplash.com/photo-${id}`, regular: `https://images.unsplash.com/photo-${id}` } })), total_pages: 2 }
  } }))
  const http: HttpClient = { async request(url, request) {
    assert.equal(url, 'https://vision.example.test/chat')
    const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).or(z.string()) })) }).parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8')))
    const content = body.messages.find(message => message.role === 'user')!.content
    assert.ok(Array.isArray(content))
    const input = z.object({ input: z.object({ stage: z.string(), images: z.array(z.object({ imageVersionId: z.string(), remoteUrl: z.string() })), rules: z.array(z.object({ ruleId: z.string() })) }) }).parse(JSON.parse(content[0]!.text!)).input
    const subject = input.images[0]!
    remoteInputs.push(subject.remoteUrl); entered()
    if (block) await new Promise<void>((_resolve, reject) => { request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }) })
    const good = subject.remoteUrl.includes('matching-car')
    const output = { ruleResults: input.rules.map(rule => ({ ruleId: rule.ruleId, status: good ? 'satisfied' : rule.ruleId === 'composition' ? 'unknown' : 'violated', source: 'inferred', reason: good ? 'The complete vehicle matches the reference style.' : 'A person and camera dominate the image.', evidenceImageVersionIds: [subject.imageVersionId] })), cropPotential: 'unknown', preferenceScores: rules.map(rule => ({ dimension: rule.dimension, score: good ? 0.9 : 0.1 })), taskRelevance: 'relevant' }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  } }
  const vision = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/chat', model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1000000, maxRequestBytes: 1000000, maxOutputTokens: 2000, temperature: 0 }, http)
  const worker = createSearchWorker({ domain, files, source: async () => source, vision: async () => vision, media: () => ({ async request() { downloads++; throw new Error('Preview mode must not download originals') } }), crop: async () => { throw new Error('Preview mode must not crop') } })
  const actor = { kind: 'human' as const, id: 'owner', profileId: base.profileId }
  const style = styleSchema.parse({ ...base, id: 'style', kind: 'style', name: 'Vehicle references', archived: false, draftId: 'draft', revision: 1, committedReleaseIds: [], defaultReleaseId: null, nextReleaseNumber: 1 })
  const draft = draftSchema.parse({ ...base, id: 'draft', kind: 'draft', styleId: 'style', revision: 1, status: 'editing', rules: [], referenceIds: [], feedbackIds: [], conflicts: [] })
  await repository.commit({ aggregateId: 'fixture', expectedRevision: 0, operationId: 'seed', request: {}, records: [style, draft, profile], state: {} })
  const spec: ExecutionSpec = { kind: 'search', config, input: { taskBrief: 'Find complete vehicle environmental portraits.', queries: ['broad car photography', 'red car autumn forest'], targetCount: 1 }, fixed: { release: toJson(profile), output: { kind: 'preview' }, executionRecipe: toJson(recipe) }, specDigest: 'fixture' }
  return { root, repository, domain, engine, jobs, actor, worker, spec, queries, remoteInputs, reviewing, get downloads() { return downloads }, cleanup: async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('real search worker rotates query pages, reviews preview URLs and retains links without downloading originals', async () => {
  const f = await fixture()
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-flow')
    await f.jobs.drain()
    const run = f.domain.require('run', started.id), view = projectRun(f.domain, run, f.actor)
    assert.equal(run.status, 'completed')
    assert.equal(dataOf(run).counts.qualified, 1)
    assert.deepEqual(f.queries, ['broad car photography', 'red car autumn forest'])
    assert.deepEqual(f.remoteInputs.map(url => new URL(url).pathname), ['/photo-portrait', '/photo-matching-car'])
    assert.equal(f.downloads, 0)
    assert.equal(dataOf(run).budget.downloadBytes, 0)
    assert.equal(f.repository.list('assessment').find(row => row.verdict === 'reject')?.technicalStatus, 'completed')
    assert.equal(f.repository.list('assessment').some(row => row.verdict === 'needs-review'), false)
    assert.equal(view.delivery, undefined)
    assert.equal(view.results[0]?.selection?.kind, 'selected')
    assert.equal(f.repository.list('asset').some(asset => asset.originalBlob !== undefined), false)
    assert.deepEqual(await readdir(f.root), [])
  } finally { await f.cleanup() }
})

test('cancelling the real background engine aborts an in-flight preview review and preserves its terminal state', async () => {
  const f = await fixture(true)
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-cancel')
    await f.reviewing
    await f.engine.control(started.id, 'cancel', f.actor)
    await f.jobs.drain()
    assert.equal(f.domain.require('run', started.id).status, 'cancelled')
    assert.equal(f.downloads, 0)
    assert.equal(f.repository.list('selection').length, 0)
  } finally { await f.cleanup() }
})
