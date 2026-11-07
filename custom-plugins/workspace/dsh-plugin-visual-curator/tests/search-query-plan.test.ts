import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessmentSchema, requestSchema, type Json } from '../src/shared/model.ts'
import { chooseSearchQuery } from '../src/host/search-query-plan.ts'
import { planSearch } from '../src/host/search-planning.ts'
import { searchQueryGuidance, searchQueryPlanningGuidance } from '../src/host/search-guidance.ts'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/repository.ts'
import { CuratorDomain } from '../src/domain/curator.ts'
import { resolveConfig } from '../src/host/config.ts'
import { RunEngine, dataOf, specOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { CompatibleVisionProvider, type VisionInput } from '../src/media/vision.ts'
import { FixtureJobs } from './helpers/service-fixture.ts'
import { z } from 'zod'

function assessment(imageId: string, taskRelevance: 'relevant' | 'irrelevant' | 'unknown', subjectFocusVerdict?: 'matched' | 'not-matched' | 'unknown') {
  return assessmentSchema.parse({ schemaVersion: 1, profileId: 'query-test', id: `assessment-${imageId}`, createdAt: '2026-10-31T00:00:00.000Z', kind: 'assessment', imageVersionId: imageId, runId: 'run', stage: 'final', releaseId: 'release', recipeId: 'recipe', reviewBundleId: 'bundle', technicalStatus: 'completed', verdict: 'reject', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: { taskRelevance, ...(subjectFocusVerdict === undefined ? {} : { subjectFocusVerdict }) } })
}

for (const verdict of ['not-matched', 'unknown'] as const) test(`v3 subject focus ${verdict} does not inherit a positive overall relevance signal`, () => {
  const index = chooseSearchQuery({ pages: [{ index: 0, ids: ['v3'], done: ['v3'], empty: false }, { index: 1, ids: ['legacy'], done: ['legacy'], empty: false }], nextQuery: 0, queryCount: 2, imageId: id => id, assessments: [assessment('v3', 'relevant', verdict), assessment('legacy', 'relevant')], selections: [] })
  assert.equal(index, 1)
})

test('a matched v3 subject also requires relevant task evidence and preserves legacy relevance behavior', () => {
  const pages = [{ index: 0, ids: ['first'], done: ['first'], empty: false }, { index: 1, ids: ['second'], done: ['second'], empty: false }]
  assert.equal(chooseSearchQuery({ pages, nextQuery: 0, queryCount: 2, imageId: id => id, assessments: [assessment('first', 'irrelevant', 'matched'), assessment('second', 'relevant')], selections: [] }), 1)
  assert.equal(chooseSearchQuery({ pages, nextQuery: 0, queryCount: 2, imageId: id => id, assessments: [assessment('first', 'unknown'), assessment('second', 'relevant', 'matched')], selections: [] }), 1)
})

test('unseen directions outrank a fetched page with no new source identities', () => {
  assert.equal(chooseSearchQuery({ pages: [{ index: 0, ids: [], done: [], empty: true }, { index: 1, ids: [], done: [], empty: false }], nextQuery: 0, queryCount: 2, imageId: () => undefined, assessments: [], selections: [] }), 1)
})

async function planningFixture(legacy?: 'receipt' | 'checkpoint' | 'wrong-task' | 'wrong-digest' | 'missing-receipt' | 'changed-checkpoint' | 'uncommitted-checkpoint' | 'malformed-receipt', queries = ['car forest', 'car mountain road']) {
  const repository = new DomainRepository('planning-test', new MemoryDomainAdapter()), domain = new CuratorDomain(repository.profileId, repository), jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
  const config = resolveConfig({ source: { provider: 'unsplash' }, limits: { maxRetryAttempts: 0, maxSearchPages: 3, maxVisionCalls: 4 } })
  const spec: ExecutionSpec = { kind: 'search', config, input: { taskBrief: '寻找以汽车为主体的图片，可选森林或山路，低饱和光线作为视觉偏好。', queries: ['car forest'], targetCount: 10 }, fixed: { executionInstructions: 'Subject: car. Alternative scenes: forest or mountain road. Lighting is a visual preference.', output: { kind: 'preview' } }, specDigest: contentDigest('query-planning-fixture') }
  const briefs: { task: string; requirement: string; seedQueries: string[]; maxQueries: number }[] = []
  const vision = new CompatibleVisionProvider({ endpoint: 'https://planning.example.test/chat', model: 'fixture', supportsMultiImage: true, maxImages: 4, maxImageBytes: 1_000_000, maxRequestBytes: 1_000_000, maxOutputTokens: 1000, temperature: 0 }, { async request(_url, request) {
    const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]) })) }).parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8')))
    const content = body.messages.find(message => message.role === 'user')!.content
    assert.ok(Array.isArray(content))
    const prompt = z.object({ input: z.object({ taskBrief: z.string() }) }).parse(JSON.parse(content[0]!.text!))
    briefs.push(z.object({ task: z.string(), requirement: z.string(), seedQueries: z.array(z.string()), maxQueries: z.number() }).parse(JSON.parse(prompt.input.taskBrief)))
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ queries, rationale: '保留汽车主体，使用森林与山路两种方向。' }) }, finish_reason: 'stop' }] })) }
  } })
  const previous = { queries: ['汽车 森林 低饱和', '汽车 山路 摄影'], rationale: '已经付费保存的旧规划。' }
  let effective: unknown
  const actor = { kind: 'human' as const, id: 'planning-owner', profileId: repository.profileId }
  return { repository, domain, jobs, engine, spec, briefs, previous, get effective() { return effective }, async run() {
    const run = await engine.create(spec, actor, async ctx => {
      if (legacy) {
        const brief = JSON.stringify({ task: legacy === 'wrong-task' ? '寻找建筑图片。' : spec.input.taskBrief, style: spec.fixed.executionInstructions, seedQueries: spec.input.queries, source: config.source.provider, maxQueries: 3, targetCount: spec.input.targetCount, output: spec.fixed.output, wallpaper: false, limits: { maxSearchPages: config.limits.maxSearchPages, maxCandidates: config.limits.maxCandidates }, requirement: 'Saved earlier query-planning instructions.' })
        const input: VisionInput = { requestId: `search-plan:${ctx.runId}`, taskBrief: brief, rules: [], images: [] }, bundle = toJson(vision.describeRequest(input, 'plan-search')), digest = contentDigest(bundle)
        const receipt = requestSchema.parse({ schemaVersion: 1, profileId: repository.profileId, id: 'prior-plan', createdAt: '2026-11-07T00:00:00.000Z', kind: 'request', runId: ctx.runId, state: legacy === 'uncommitted-checkpoint' ? 'outcome-unknown' : 'committed', requestDigest: legacy === 'wrong-digest' ? contentDigest('different-request') : digest, data: legacy === 'malformed-receipt' ? {} : { bundle, output: previous } })
        await ctx.ledger.reserve('vision')
        const checkpoint: Record<string, Json> = ['checkpoint', 'missing-receipt', 'changed-checkpoint', 'uncommitted-checkpoint'].includes(legacy) ? { searchPlan: toJson({ ...previous, ...(legacy === 'changed-checkpoint' ? { queries: ['unrecorded replacement'] } : {}), version: 1, requestDigest: digest }) } : {}
        await ctx.save('planning', { checkpoint, requestIds: legacy === 'missing-receipt' ? [] : [receipt.id] }, legacy === 'missing-receipt' ? [] : [receipt])
      }
      const planned = await planSearch(ctx, domain, vision)
      effective = planned.spec.input.queries
      return 'target-met'
    }, 'query-planning')
    await jobs.drain()
    return domain.require('run', run.id)
  }, async cleanup() { await engine.dispose() } }
}

test('automatic planning shares concise subject-first English guidance while retaining the Chinese task and diverse bounded directions', async () => {
  const f = await planningFixture()
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'target-met')
    assert.equal(f.briefs[0]!.task, f.spec.input.taskBrief)
    assert.match(f.briefs[0]!.requirement, /short English queries/)
    assert.match(f.briefs[0]!.requirement, /subject first and add one enabled scene or style anchor/)
    assert.match(f.briefs[0]!.requirement, /taskBrief and pixel review instead of a long search sentence/)
    assert.ok(f.briefs[0]!.requirement.includes(searchQueryPlanningGuidance))
    assert.ok(searchQueryGuidance.includes(searchQueryPlanningGuidance))
    assert.deepEqual(f.effective, ['car forest', 'car mountain road'])
    assert.equal(f.briefs[0]!.maxQueries, 3)
    assert.deepEqual(specOf(run).input.queries, ['car forest'], 'Planning never mutates the caller\'s frozen query input')
    assert.equal(dataOf(run).budget.vision, 1)
  } finally { await f.cleanup() }
})

for (const mode of ['receipt', 'checkpoint'] as const) test(`saved legacy planning ${mode} replays its exact directions without another paid request`, async () => {
  const f = await planningFixture(mode)
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'target-met')
    assert.deepEqual(f.effective, f.previous.queries)
    assert.equal(f.briefs.length, 0)
    assert.equal(dataOf(run).budget.vision, 1)
    assert.deepEqual(z.object({ queries: z.array(z.string()) }).parse(dataOf(run).checkpoint.searchPlan).queries, f.previous.queries)
  } finally { await f.cleanup() }
})

for (const mode of ['wrong-task', 'wrong-digest', 'missing-receipt', 'changed-checkpoint', 'uncommitted-checkpoint', 'malformed-receipt'] as const) test(`a ${mode} planning record fails without replacing it with another paid plan`, async () => {
  const f = await planningFixture(mode)
  try {
    const run = await f.run()
    assert.equal(run.status, 'failed')
    assert.equal(dataOf(run).error?.code, 'reference-unavailable')
    assert.equal(f.briefs.length, 0)
    assert.equal(dataOf(run).budget.vision, 1)
  } finally { await f.cleanup() }
})

for (const queries of [['car forest', 'car road', 'car desert', 'car snow'], ['car forest', 'CAR FOREST']]) test(`planning rejects ${queries.length === 4 ? 'over-budget' : 'duplicate'} directions without launching retrieval`, async () => {
  const f = await planningFixture(undefined, queries)
  try {
    const run = await f.run()
    assert.equal(run.status, 'failed')
    assert.equal(dataOf(run).error?.code, 'vision-invalid-output')
    assert.equal(f.briefs.length, 1)
    assert.equal(dataOf(run).checkpoint.searchPlan, undefined)
    assert.equal(dataOf(run).budget.vision, 1)
  } finally { await f.cleanup() }
})
