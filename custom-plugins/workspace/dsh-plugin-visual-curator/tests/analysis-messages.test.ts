import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { RunEngine, dataOf } from '../src/host/runtime.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { FixtureJobs } from './helpers/service-fixture.ts'
import { updateAnalysisProcess } from '../src/host/analysis-process.ts'
import { MediaError } from '../src/media/errors.ts'

test('retains earlier model messages, bounds output and checkpoints without writing per token', async () => {
  const repository = new DomainRepository('messages-profile', new MemoryDomainAdapter()), jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
  const actor = { kind: 'human' as const, id: 'owner', profileId: 'messages-profile' }
  try {
    const run = await engine.create({ kind: 'analyze', config: resolveCurrentConfig({ limits: { maxProcessTextChars: 80 } }), input: { styleId: 'collection' }, fixed: {}, specDigest: 'messages-spec' }, actor, async ctx => {
      ctx.report({ phase: 'analyzing', batch: 1, imageIds: ['one'], resetOutput: true })
      ctx.report({ phase: 'receiving', reasoning: '真实推理文本', content: '第一批观察' })
      ctx.report({ phase: 'validating' })
      await ctx.save('reviewing', { counts: { observed: 1 } })
      const revision = ctx.current().revision
      ctx.report({ phase: 'summarizing', imageIds: ['one'], resetOutput: true })
      for (const character of '跨图片风格归纳') ctx.report({ phase: 'receiving', content: character })
      assert.equal(ctx.current().revision, revision)
      assert.equal(engine.process(ctx.current())?.messages?.length, 2)
      return 'target-met'
    }, 'message-history')
    await jobs.hooks[0]!.done
    const process = dataOf(engine.get(run.id, actor)).process!
    const messages = process.messages!.map(({ kind, batch, imageIds, content, reasoning, state }) => ({ kind, batch: batch ?? null, imageIds, content, reasoning, state }))
    assert.deepEqual(messages, JSON.parse(await readFile(new URL('./fixtures/analysis-messages.expected.json', import.meta.url), 'utf8')))
    assert.ok(messages.reduce((total, message) => total + message.content.length + message.reasoning.length, 0) <= 80)
  } finally { await engine.dispose() }
})

test('retention limits apply across all messages and retain the newest response tail', () => {
  const limits = resolveCurrentConfig({ limits: { maxProcessTextChars: 10 } }).limits
  let process = updateAnalysisProcess(undefined, { phase: 'analyzing', batch: 1, resetOutput: true, content: 'older response' }, limits, 'now')
  process = updateAnalysisProcess(process, { phase: 'summarizing', resetOutput: true, content: 'new response exceeds retention' }, limits, 'later')
  assert.equal(process.truncated, true)
  assert.equal(process.messages!.reduce((total, message) => total + message.content.length + message.reasoning.length, 0), 10)
  assert.equal(process.messages![0]!.content, '')
  assert.equal(process.messages!.at(-1)!.content, ' retention')
})

test('a retried upstream request starts another message instead of concatenating different responses', async () => {
  const repository = new DomainRepository('retry-profile', new MemoryDomainAdapter()), jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
  const actor = { kind: 'human' as const, id: 'owner', profileId: 'retry-profile' }
  try {
    const run = await engine.create({ kind: 'analyze', config: resolveCurrentConfig({ limits: { maxRetryAttempts: 1 } }), input: { styleId: 'collection' }, fixed: {}, specDigest: 'retry-messages' }, actor, async ctx => {
      ctx.report({ phase: 'analyzing', batch: 1, resetOutput: true })
      let attempts = 0
      await ctx.request('vision', {}, async () => {
        attempts++
        ctx.report({ phase: 'receiving', content: attempts === 1 ? 'partial response' : 'completed response' })
        if (attempts === 1) throw new MediaError('remote-timeout', 'network', true, 'Request timed out.', 'Retry within budget.')
        return 'completed response'
      })
      ctx.report({ phase: 'validating' })
      return 'target-met'
    }, 'retry-message')
    await jobs.hooks[0]!.done
    const messages = dataOf(engine.get(run.id, actor)).process!.messages!
    assert.deepEqual(messages.map(message => message.content), ['partial response', 'completed response'])
    assert.deepEqual(messages.map(message => message.state), ['failed', 'complete'])
    const requestIds = dataOf(engine.get(run.id, actor)).requestIds
    assert.deepEqual(messages.map(message => message.requestId), requestIds)
    assert.equal(new Set(requestIds).size, 2)
  } finally { await engine.dispose() }
})
