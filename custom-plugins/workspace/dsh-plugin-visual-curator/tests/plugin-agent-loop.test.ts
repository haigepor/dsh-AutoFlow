import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { createAgentTools } from '../src/host/tools.ts'
import { dataOf } from '../src/host/runtime.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import type { Json } from '../src/shared/model.ts'

function toolResponse(callId: string, name: string, args: Record<string, Json>): StreamChunk[] {
  const id = ToolCallId(callId), argumentsJson = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function textResponse(): StreamChunk[] {
  const text = 'Saved results require the fixed style and original Session. Suggestions remain unconfirmed.'
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'stop' } }]
}
class RecordedAdapter extends LlmAdapter {
  constructor(private readonly replay: ((request: GenerateOptions) => Promise<StreamChunk[]>)[]) { super() }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const next = this.replay.shift()
    assert.ok(next, 'The keyless recorded model script must not be exhausted')
    for (const chunk of await next(request)) { request.signal?.throwIfAborted(); yield chunk }
  }
}

test('a real AgentLoop records fixed-style jobs, technical and crop failures, suggestions, owner denial and tool unload', async () => {
  const f = await serviceFixture(), ctx = new Context()
  await f.service.initialize()
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { name: 'Recorded green', operationId: 'create' }))
    await f.action('reference-import', { styleId: style.id, expectedRevision: 1, operationId: 'reference', files: [{ name: 'sample.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('draft-save', { styleId: style.id, expectedRevision: 2, operationId: 'required-final-rule', referenceIds: f.domain.require('draft', f.domain.require('style', style.id).draftId).referenceIds,
      feedbackIds: [], conflicts: [], rules: [{ ruleId: 'final-color', dimension: 'color', statement: 'Preserve muted green in the final image', condition: '', exceptions: [], supportRefs: [], counterRefs: [], strength: 'required', stage: 'final', confirmed: true }] })
    const candidate = z.object({ id: z.string() }).parse(await f.action('candidate-create', { styleId: style.id, expectedRevision: 3, operationId: 'candidate' }))
    const release = z.object({ id: z.string() }).parse(await f.action('release-publish', { styleId: style.id, expectedRevision: 4, candidateId: candidate.id, operationId: 'publish' }))
    const usage = z.object({ id: z.string() }).parse(await f.action('usage-create', { name: 'Square', operationId: 'usage', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const searchArgs = { releaseId: release.id, usageRevisionId: usage.id, sourceId: 'images', taskBrief: 'Muted green', budgets: {
      targetCount: 1, maxSearchPages: 2, maxCandidates: 5, maxVisionCalls: 12, maxDownloadBytes: 1_000_000,
      maxCropCandidatesPerImage: 2, maxConcurrentRequests: 1, maxRetryAttempts: 0, deadlineMs: 60_000,
    } }
    const foreign = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...searchArgs, operationId: 'foreign-run' } },
      { kind: 'agent', id: 'foreign', profileId: f.profileId, sessionId: 'foreign-session' }, new AbortController().signal))
    await f.jobs.drain()
    const initialFeedback = f.repository.list('feedback').length
    await mountAgentLoopTestDependencies(ctx)
    f.host.sessions = ctx.sessions
    const harness = await mountAgentLoopTestHarness(ctx)
    const toolsFork = ctx.plugin({ name: 'visual-curator-agent-fixture', inject: ['tools'], apply(child) {
      for (const tool of createAgentTools(f.service)) child.effect(() => child.tools.register(tool), `Fixture ${tool.name}`)
    } })
    await toolsFork
    let successfulRunId = '', rejectedRunId = '', failedRunId = ''
    const script: ((request: GenerateOptions) => Promise<StreamChunk[]>)[] = [
      async () => toolResponse('style-get', 'visual_style_get', { styleId: style.id }),
      async () => toolResponse('search-pass', 'visual_search_start', searchArgs),
      async () => {
        await f.jobs.drain()
        const run = f.repository.list('run').find(run => run.owner.kind === 'session' && run.owner.sessionId === 'curator-session')!
        successfulRunId = run.id
        assert.equal(run.outcome, 'target-met')
        return toolResponse('run-pass', 'visual_run_get', { runId: run.id })
      },
      async () => {
        f.http.mode = 'reject-final'
        return toolResponse('search-rejected', 'visual_search_start', searchArgs)
      },
      async () => {
        await f.jobs.drain()
        const run = f.repository.list('run').find(run => run.owner.kind === 'session' && run.owner.sessionId === 'curator-session' && run.id !== successfulRunId)!
        rejectedRunId = run.id
        assert.equal(dataOf(run).counts.qualified ?? 0, 0)
        assert.ok(f.repository.list('assessment').some(assessment => assessment.runId === run.id && assessment.stage === 'final' && assessment.verdict === 'reject'))
        return toolResponse('run-rejected', 'visual_run_get', { runId: run.id })
      },
      async () => {
        f.http.mode = 'bad-json'
        return toolResponse('search-invalid', 'visual_search_start', searchArgs)
      },
      async () => {
        await f.jobs.drain()
        const run = f.repository.list('run').find(run => run.owner.kind === 'session' && run.owner.sessionId === 'curator-session' && ![successfulRunId, rejectedRunId].includes(run.id))!
        failedRunId = run.id
        const failedAssessments = f.repository.list('assessment').filter(assessment => assessment.runId === run.id)
        assert.ok(failedAssessments.length > 0)
        assert.ok(failedAssessments.every(assessment => assessment.technicalStatus === 'failed' && assessment.verdict === undefined))
        return toolResponse('run-invalid', 'visual_run_get', { runId: run.id })
      },
      async () => toolResponse('suggestion', 'visual_feedback_suggest', { text: 'Review whether composition should be less dense.', feedbackIds: [] }),
      async () => toolResponse('forged-human', 'visual_feedback_suggest', { text: 'Confirm this as human.', feedbackIds: [], actor: { kind: 'human' } }),
      async () => toolResponse('foreign-owner', 'visual_run_get', { runId: foreign.runId }),
      async () => { await toolsFork.dispose(); return toolResponse('disabled-tools', 'visual_style_list', {}) },
      async () => textResponse(),
    ]
    ctx.llm.registerAdapter(['curator-recorded'], new RecordedAdapter(script))
    const agent = await harness.create(SessionId('curator-session'), { provider: 'curator-recorded', model: 'recorded-v1' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Apply the fixed visual style, inspect saved results and suggest a correction without confirming human labels.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.equal(script.length, 0, JSON.stringify(agent.session.snapshotEvents().slice(-4)))
    assert.equal(f.repository.list('feedback').length, initialFeedback)
    const suggestion = f.repository.list('suggestion').at(-1)!
    assert.equal(suggestion.status, 'pending'); assert.equal(suggestion.author.kind, 'agent')
    assert.equal(suggestion.author.sourceId, 'curator-session')
    assert.ok(failedRunId)
    const events = agent.session.snapshotEvents()
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, calls.length)
    const trace = results.map((event, index) => ({ tool: calls[index], failed: event.data.message.isError === true }))
    const expected = JSON.parse(await readFile(new URL('./fixtures/agent-loop.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual(trace, expected)
    const logged = JSON.stringify(events)
    assert.ok(events.some(event => pluginRecordOf(event)?.type === 'plugin:visual-curator/request'), 'Auxiliary model inputs are recorded in their owning Session.')
    assert.ok(logged.includes('owner-denied'))
    assert.ok(logged.includes('invalid-input'))
    assert.ok(!logged.includes('https://images.example.test'))
    assert.ok(!logged.includes('base64'))
    assert.equal(ctx.tools.schemas().some(tool => tool.name.startsWith('visual_')), false)
    const profileView = z.object({ runs: z.array(z.object({ runId: z.string() })) }).parse(await f.action('snapshot'))
    assert.equal(profileView.runs.some(run => [successfulRunId, rejectedRunId, failedRunId, foreign.runId].includes(run.runId)), false)
    const sessionAsset = f.repository.list('asset').find(asset => asset.access.kind === 'session-run' && asset.access.sessionId === 'curator-session')!
    const sessionImage = f.repository.list('imageVersion').find(image => image.assetId === sessionAsset.id)!
    const forgedScope = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=${sessionImage.id}&sessionId=curator-session`))
    assert.equal(forgedScope.status, 403)
  } finally { await ctx.fiber.dispose(); await f.cleanup() }
})
