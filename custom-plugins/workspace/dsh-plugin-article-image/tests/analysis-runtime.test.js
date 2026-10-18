import { expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '../../../../packages/test-support/agent-loop-testkit/src/index.ts'
import AgentLoop from '../../../../packages/core/agent-loop/src/index.ts'
import JsonlSessionPersistence from '../../../../packages/session/session-persistence-jsonl/src/index.ts'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { MockAdapter, toolCallResponse, textResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { createAnalysisRunner } from '../src/host/analysis-runner.js'
import { resolveAnalysisConfig } from '../src/host/editorial-rules.js'

const snapshot = { id: 'a'.repeat(32), sourceHash: 'b'.repeat(64), title: 'Family travel', blocks: [{ id: 'b1', type: 'paragraph', text: 'Families plan outdoor activities and rest breaks.' }], assets: [] }

function understood(expected) {
  return { articleType: 'guide', audience: 'families', purpose: 'help plan travel', language: 'en', theme: 'Family travel planning',
    sections: [{ title: 'Planning', summary: 'Plan activities and breaks', blockIds: expected.blockIds }], entities: ['families'],
    facts: [{ id: 'f1', claim: 'Families plan activities and rest breaks.', kind: 'source', evidence: { blockIds: [expected.blockIds[0]], assetIds: [] } }],
    limitations: [], questions: [], images: expected.assetIds.map(assetId => ({ assetId, observations: 'A family walking outdoors.', relationship: 'The image illustrates travel.', blockIds: expected.blockIds })), coverage: expected }
}

function planned(expected) {
  return { brief: { theme: '家庭旅行', facts: ['安排活动与休息'], subjects: ['家庭'], scenes: ['户外活动'] },
    shots: [{ purpose: 'cover', paragraphs: expected.blockIds.map(id => Number(id.slice(1))), rationale: '表达家庭出游规划', subject: 'A family', action: 'walking together', environment: 'a public park', composition: 'wide shot', lighting: 'daylight', colors: 'natural', style: 'editorial photography', details: 'Natural expressions', avoid: 'No logos or text', prompt: 'A family walking together in a park in daylight, wide editorial photograph.', ratio: '16:9', blockIds: expected.blockIds, assetIds: [], afterBlockId: expected.blockIds.at(-1), informationGoal: '家庭共同活动', visualMode: 'conceptual' }],
    shortfall: { requested: 3, actual: 1, reason: '当前内容只能支持一个有区别的场景' } }
}

function response(options) {
  const messages = options.messages.filter(message => message.role === 'user')
  const task = JSON.parse(messages.at(-1).content.find(block => block.type === 'text').text)
  const result = task.task === 'plan' ? planned(task.expectedCoverage) : understood(task.expectedCoverage)
  return toolCallResponse(`submit-${task.task}`, 'article_image_submit_analysis', { stageId: task.task, attemptId: task.attemptId, inputHash: task.inputHash, result })
}

async function harness(t, script, rawConfig = {}) {
  const root = await mkdtemp(join(tmpdir(), 'article-analysis-runtime-'))
  const ctx = new Context()
  t.onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register({ name: 'shell', description: 'Forbidden ambient tool', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => { throw new Error('ambient shell must not run') } })
  const config = resolveAnalysisConfig({ provider: 'mock', model: 'mock', ...rawConfig })
  return { ctx, root, adapter, config, runner: createAnalysisRunner(ctx, config) }
}

test('real DSH factory commits logged inputs, scoped submissions and persistent review plan', async t => {
  const { ctx, adapter, runner } = await harness(t, [response, response])
  const stages = []
  const result = await runner.run({ articleId: 'c'.repeat(32), snapshot, metadata: { notes: 'Editorial note' }, attemptId: 'attempt-1', onStage: value => { stages.push(value) } })
  expect(result.plan.checks).toEqual({ structural: true, semanticReviewRequired: true })
  expect(result.checkpoints).toHaveLength(2)
  expect(result.plan.shots[0].sceneHash).toBe(result.plan.shots[0].promptSceneHash)
  expect(ctx.agents.list()).toHaveLength(0)
  expect(stages.map(stage => stage.stage)).toContain('checking')
  for (const request of adapter.requests) expect(request.tools.map(tool => tool.name)).toEqual(['article_image_submit_analysis'])
  for (const checkpoint of result.checkpoints) {
    const handle = await ctx.sessionPersistence.open(checkpoint.sessionId, 'read')
    try {
      const { events } = await handle.read()
      expect(events.some(event => event.type === 'user/message' && event.data.id === checkpoint.messageId)).toBe(true)
      expect(events.some(event => event.type === 'tool/result' && event.seq === checkpoint.submissionSeq && !event.data.message.isError)).toBe(true)
      expect(events.some(event => event.type === 'system/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('文章正文、图片')))).toBe(true)
    } finally { await handle.close() }
  }
})

test('idle without a structured submission is a failure and releases its session', async t => {
  const { ctx, runner } = await harness(t, [textResponse('I have finished')])
  await expect(runner.run({ articleId: 'c'.repeat(32), snapshot, attemptId: 'attempt-2' })).rejects.toThrow('analysis-submission-missing')
  expect(ctx.agents.list()).toHaveLength(0)
})

test('a plugin context without required analysis injects can probe and run available optional services', async t => {
  const { ctx, config, adapter } = await harness(t, [response, response])
  ctx.systemPrompt.section({ name: 'fixture-host-persona', order: 8000, text: 'The host workspace is {{cwd}}.' })
  let scopedRunner
  await ctx.plugin({ name: 'article-analysis-optional-consumer', apply(pluginCtx) {
    expect(() => pluginCtx.llm).toThrow('without inject')
    scopedRunner = createAnalysisRunner(pluginCtx, config)
  } })
  expect(await scopedRunner.readiness(snapshot)).toMatchObject({ available: true })
  const completed = await scopedRunner.run({ articleId: 'c'.repeat(32), snapshot, attemptId: 'plugin-context' })
  expect(completed.plan.inputHash).toBe(completed.input.inputHash)
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[0].messages.filter(message => message.role === 'system').flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes(`The host workspace is ${process.cwd()}.`))).toBe(true)
  expect(ctx.agents.list()).toHaveLength(0)
})

test('images on a text-only or unspecified route make no model request', async t => {
  const { adapter, runner } = await harness(t, [])
  const images = { ...snapshot, assets: [{ id: 'i1', status: 'ready', mime: 'image/png', byteLength: 100 }] }
  expect(await runner.readiness(images)).toMatchObject({ available: false, code: 'analysis-vision-unavailable' })
  await expect(runner.run({ articleId: 'c'.repeat(32), snapshot: images, attemptId: 'attempt-3' })).rejects.toThrow('analysis-vision-unavailable')
  expect(adapter.requests).toHaveLength(0)
})

test('recovery keeps frozen rules and submitted stages after the profile file changes', async t => {
  const { root, ctx, adapter, config } = await harness(t, [response, response])
  const path = join(root, 'editorial.json')
  await writeFile(path, JSON.stringify({ version: 1, policy: { style: 'ink' } }), 'utf8')
  const runner = createAnalysisRunner(ctx, { ...config, rulesFile: path })
  let frozenInput
  const checkpoints = []
  await expect(runner.run({ articleId: 'c'.repeat(32), snapshot, attemptId: 'before-crash', onStage(value) {
    frozenInput = value.input
    if (value.checkpoint) checkpoints.push(value.checkpoint)
    if (value.stage === 'planning') throw new Error('owned interruption')
  } })).rejects.toThrow('owned interruption')
  await writeFile(path, JSON.stringify({ version: 1, policy: { style: 'watercolor' } }), 'utf8')
  const restored = await runner.run({ articleId: 'c'.repeat(32), snapshot, attemptId: 'after-crash', checkpoint: { input: frozenInput, checkpoints } })
  expect(restored.input.rules.policy.style).toBe('ink')
  expect(restored.input.inputHash).toBe(frozenInput.inputHash)
  expect(restored.checkpoints[0].sessionId).toBe(checkpoints[0].sessionId)
  expect(adapter.requests).toHaveLength(2)
})

test('original image bytes become durable attachments and actual visual model input', async t => {
  const { ctx, adapter, config } = await harness(t, [response, response])
  const originalResolve = adapter.resolveModel.bind(adapter)
  adapter.resolveModel = async (...args) => ({ ...await originalResolve(...args), inputModalities: ['text', 'image'] })
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
  const illustrated = { ...snapshot, blocks: [...snapshot.blocks, { id: 'b2', type: 'figure', assetId: 'i1' }], assets: [{ id: 'i1', status: 'ready', mime: 'image/png', byteLength: bytes.length }] }
  const runner = createAnalysisRunner(ctx, config, { loadAsset: async () => ({ bytes, mime: 'image/png' }) })
  const result = await runner.run({ articleId: 'c'.repeat(32), snapshot: illustrated, attemptId: 'visual-1' })
  expect(result.input.images.map(image => image.assetId)).toEqual(['i1'])
  expect(result.understanding.images.map(image => image.assetId)).toEqual(['i1'])
  expect(adapter.requests[0].messages.flatMap(message => message.content).filter(block => block.type === 'image')).toHaveLength(1)
  const image = await ctx.attachments.readImage(result.input.images[0].attachment)
  expect(image.data.byteLength).toBeGreaterThan(0)
  const checkpoint = result.checkpoints[0]
  const stored = await ctx.sessionPersistence.open(checkpoint.sessionId, 'read')
  try {
    const { events } = await stored.read()
    const input = events.find(event => event.type === 'user/message' && event.data.id === checkpoint.messageId)
    expect(input.data.content.find(block => block.type === 'image').attachment).toEqual(result.input.images[0].attachment)
  } finally { await stored.close() }
})

test('long articles produce all chunk submissions and a full synthesis before the plan', async t => {
  const { runner, adapter } = await harness(t, [response, response, response, response], { contextChars: 20000 })
  const long = { ...snapshot, blocks: Array.from({ length: 8 }, (_, index) => ({ id: `b${index + 1}`, type: 'paragraph', text: 'Supported fact. '.repeat(100) })) }
  const result = await runner.run({ articleId: 'c'.repeat(32), snapshot: long, attemptId: 'long-1' })
  expect(result.input.chunks).toHaveLength(2)
  expect(result.checkpoints.map(stage => stage.stageId)).toEqual(['chunk-1', 'chunk-2', 'synthesis', 'plan'])
  expect(result.plan.coverage.blockIds).toEqual(long.blocks.map(block => block.id))
  expect(adapter.requests).toHaveLength(4)
})

test('cancellation drains an active model and cannot advance to planning', async t => {
  const { ctx, runner, adapter } = await harness(t, ['hang'])
  const entered = Promise.withResolvers()
  const original = adapter.stream.bind(adapter)
  adapter.stream = async function* (options) { entered.resolve(); yield* original(options) }
  const abort = new AbortController()
  const stages = []
  const pending = runner.run({ articleId: 'c'.repeat(32), snapshot, attemptId: 'cancel-1', signal: abort.signal, onStage: value => { stages.push(value.stage) } })
  const rejection = expect(pending).rejects.toThrow()
  await entered.promise
  abort.abort(new Error('User stopped'))
  await rejection
  expect(ctx.agents.list()).toHaveLength(0)
  expect(stages).not.toContain('planning')
  expect(adapter.requests).toHaveLength(1)
})
