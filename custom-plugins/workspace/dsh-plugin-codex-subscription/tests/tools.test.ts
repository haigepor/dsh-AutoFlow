import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createImageTools, imageToolValue, renderImageToolValue } from '../src/host/images/tools.ts'
import type { ImageOwner, ImagesFacade, ImageTask } from '../src/host/images/types.ts'
import { ImageServiceError } from '../src/host/images/errors.ts'
import * as loader from '../src/host/tools.ts'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts'
import type { ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { imageConversationDefinition, imageTurnDefinition } from '../src/client/conversation.ts'
import { z } from 'zod'

const task: ImageTask = { id: 'recorded-image-task', state: 'succeeded', owner: { kind: 'session', sessionId: 'image-session', toolCallId: 'generate' },
  prompt: 'A green square', model: 'gpt-image-2', createdAt: 1, updatedAt: 2, deadlineAt: 300001, accountKey: 'never-expose-account',
  assets: [{ id: 'image-one', mimeType: 'image/png', original: { attachmentId: AttachmentId('original-image'), bytes: 1000, name: 'square.png' },
    preview: { attachmentId: AttachmentId('preview-image'), mediaType: 'image/png', bytes: 100, width: 64, height: 64 } }] }

function verifyOwner(owner: ImageOwner): void {
  if (owner.kind !== 'session' || owner.sessionId !== 'image-session') throw new ImageServiceError('image-task-not-found', 'The image task is unavailable to this caller.')
}

test('canonical image rendering persists capability choice and keeps originals separate from previews', () => {
  const textOnly = imageToolValue(task, false)
  assert.deepEqual(renderImageToolValue(textOnly).map(block => block.type), ['text'])
  const withImage = imageToolValue(task, true)
  const rendered = renderImageToolValue(withImage)
  assert.deepEqual(rendered.map(block => block.type), ['text', 'image'])
  assert.equal(rendered[1]?.type === 'image' ? rendered[1].attachment.attachmentId : undefined, 'preview-image')
  assert.equal(withImage.assets[0]?.originalAttachmentId, 'original-image')
  assert.ok(!JSON.stringify(withImage).includes('never-expose-account'))
  assert.ok(!JSON.stringify(withImage).includes('image-session'))
  assert.deepEqual(Object.keys(loader).sort(), ['Config', 'apply', 'inject', 'name'])
})

function call(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id), encoded = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: encoded },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: encoded } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

class RecordedAdapter extends LlmAdapter {
  constructor(private readonly script: ((request: GenerateOptions) => Promise<StreamChunk[]>)[]) { super() }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const next = this.script.shift()
    assert.ok(next, 'The keyless recorded script must not be exhausted')
    for (const chunk of await next(request)) yield chunk
  }
}

function imageProjectionView(): ConversationViewDefinition {
  return { target: 'chat', create() {
    let current: readonly ConversationViewNode[] = []
    return { empty: current, replace: ({ nodes }) => { current = nodes; return current }, apply: ({ upserts }) => {
      const nodes = new Map(current.map(node => [node.key, node])); for (const node of upserts) nodes.set(node.key, node)
      current = [...nodes.values()]; return current
    } }
  } }
}

test('real AgentLoop records image tools, canonical metadata, owner refusal, validation and reversible unload', async () => {
  const ctx = new Context()
  let submittedOwner: ImageOwner | undefined
  let waited = -1
  const images: ImagesFacade = {
    submit: (input, owner) => { submittedOwner = owner; verifyOwner(owner); assert.deepEqual(input.referenceImages, ['data:image/png;base64,fixture']); assert.equal('referenceAttachmentIds' in input, false); return Promise.resolve(task) },
    getResult: (id, owner, options) => { verifyOwner(owner); waited = options?.waitMs ?? 0; if (id !== task.id) return Promise.reject(new ImageServiceError('image-task-not-found', 'The image task is unavailable to this caller.')); return Promise.resolve(task) },
    cancel: (_id, owner) => { verifyOwner(owner); return Promise.resolve({ ...task, state: 'cancelled' }) },
    list: owner => { verifyOwner(owner); return Promise.resolve([task]) },
    readAsset: () => Promise.reject(new Error('Native tools must use immutable attachment references.')),
  }
  try {
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const tools = ctx.plugin({ name: 'recorded-image-tools', inject: ['tools'], apply(child) {
      for (const tool of createImageTools(images, { quickWaitMs: () => 37, admitImages: () => Promise.resolve(false),
        resolveAttachments: async (ids, exec) => { assert.deepEqual(ids, ['latest']); assert.equal(exec.agent?.session.id, 'image-session'); return ['data:image/png;base64,fixture'] },
      })) child.effect(() => child.tools.register(tool), `recorded ${tool.name}`)
    } })
    await tools
    const script: ((request: GenerateOptions) => Promise<StreamChunk[]>)[] = [
      async () => call('generate', 'codex_image_generate', { prompt: 'A green square', referenceAttachmentIds: ['latest'] }),
      async request => {
        const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'generate')
        assert.ok(result)
        assert.deepEqual(result.content.map(block => block.type), ['text'])
        assert.equal(waited, 37)
        assert.deepEqual(submittedOwner, { kind: 'session', sessionId: 'image-session', toolCallId: 'generate' })
        return call('result', 'codex_image_result', { taskId: task.id, waitMs: 0 })
      },
      async () => call('missing', 'codex_image_result', { taskId: 'foreign-task' }),
      async () => call('bad-wait', 'codex_image_result', { taskId: task.id, waitMs: 20001 }),
      async () => { await tools.dispose(); return call('disabled', 'codex_image_result', { taskId: task.id }) },
      async () => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'The image is saved.' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'The image is saved.' } }, { type: 'finish', reason: { kind: 'stop' } }],
    ]
    ctx.llm.registerAdapter(['recorded-images'], new RecordedAdapter(script))
    const agent = await harness.create(SessionId('image-session'), { provider: 'recorded-images', model: 'recorded-model' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Generate a green square and inspect the saved image.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.equal(script.length, 0, JSON.stringify(agent.session.snapshotEvents().slice(-4)))
    const events = agent.session.snapshotEvents()
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    const results = events.filter(event => event.type === 'tool/result')
    const trace = results.map((event, index) => ({ tool: calls[index], error: event.data.message.isError === true,
      content: event.data.message.content.map(block => block.type) }))
    // 固定的 keyless 会话快照覆盖模型可见结果与卸载后的公开工具行为。
    assert.deepEqual(trace, [
      { tool: 'codex_image_generate', error: false, content: ['text'] },
      { tool: 'codex_image_result', error: false, content: ['text'] },
      { tool: 'codex_image_result', error: true, content: ['text'] },
      { tool: 'codex_image_result', error: true, content: ['text'] },
      { tool: 'codex_image_result', error: true, content: ['text'] },
    ])
    const logged = JSON.stringify(events)
    assert.ok(logged.includes('codexImage'))
    assert.ok(logged.includes('preview-image'))
    assert.ok(logged.includes('original-image'))
    assert.ok(logged.includes('latest'))
    assert.ok(!logged.includes('base64,fixture'))
    assert.ok(!logged.includes('never-expose-account'))
    const projection = new ConversationNodeAssembler(
      { entries: () => [imageTurnDefinition, imageConversationDefinition], fallbackEntry: () => undefined },
      { entries: () => [imageProjectionView()] },
    )
    const displayedImages = () => z.array(z.object({ kind: z.string(), groupTree: z.string(), visibility: z.string(), anchorSeq: z.number(), data: z.unknown() }))
      .parse(projection.snapshot('chat')).filter(node => node.kind === 'codex-image')
    const generation = events.find(event => event.type === 'tool/call' && event.data.name === 'codex_image_generate')
    assert.ok(generation)
    projection.replaceWindow(events.filter(event => event.seq <= generation.seq).map(event => ({ type: 'event' as const, event })), false)
    projection.activateTarget('chat')
    const pendingImage = displayedImages()[0]
    assert.equal(pendingImage?.groupTree, 'turn')
    assert.equal(pendingImage?.visibility, 'visible')
    assert.deepEqual(pendingImage?.data, { callId: 'generate', settled: false, failed: false, saved: undefined, live: true })
    projection.replaceWindow(events.map(event => ({ type: 'event' as const, event })), false)
    projection.flush()
    const displayed = displayedImages()
    assert.equal(displayed.length, 1, 'result queries must not create duplicate image rows')
    assert.equal(displayed[0]?.groupTree, 'turn', 'images must remain outside completed process folding')
    assert.ok((displayed[0]?.anchorSeq ?? 0) > (results.at(-1)?.seq ?? 0), 'the entire tool process must precede the image')
    const oldGeneration = events.map(event => event.type === 'tool/result' && event === results[0]
      ? { ...event, data: { ...event.data, meta: { codexImage: { version: 1, operation: 'generate', ...imageToolValue({ ...task, state: 'sent', assets: [] }, false) } } } } : event)
    projection.replaceWindow(oldGeneration.map(event => ({ type: 'event' as const, event })), false)
    projection.flush()
    const replayed = z.object({ live: z.literal(false), saved: z.object({ state: z.literal('succeeded'), assets: z.array(z.unknown()).length(1) }) }).parse(displayedImages()[0]?.data)
    assert.equal(replayed.saved.state, 'succeeded', 'a later recorded result restores the image before the live resource read')
    const resultOnly = results[0]
    assert.ok(resultOnly)
    projection.replaceWindow([{ type: 'event', event: resultOnly }], true)
    projection.flush()
    assert.equal(displayedImages().length, 1,
      'recorded generation metadata restores its image even when the call start is outside the loaded window')
    assert.equal(ctx.tools.schemas().some(tool => tool.name.startsWith('codex_image_')), false)
  } finally { await ctx.fiber.dispose() }
})
