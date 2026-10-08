import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, ToolCallId, ReasoningEffortId, isAgentLoopRequest, LlmAdapter  } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk, LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  generateSessionTitleWithLlm,
  resolveSessionTitleLlmConfig,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
    private readonly reasoning?: LlmModelReasoningInfo,
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onDispatch?.()
    this.requests.push(options)
    yield * this.script
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }
}

class AttemptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly attempts: readonly (Error | readonly StreamChunk[])[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const attempt = this.attempts[this.requests.length]
    this.requests.push(options)
    if (attempt instanceof Error) throw attempt
    if (attempt === undefined) throw new Error('Unexpected extra title attempt')
    yield * attempt
  }
}

class DelayedMetadataAdapter extends RecordingAdapter {
  readonly started: Promise<void>
  private readonly metadata: Promise<void>
  private markStarted!: () => void
  private releaseMetadata!: () => void

  constructor() {
    super(SCRIPT)
    this.started = new Promise<void>((resolve) => { this.markStarted = resolve })
    this.metadata = new Promise<void>((resolve) => { this.releaseMetadata = resolve })
  }

  override async resolveModel(provider: string, model: string) {
    this.markStarted()
    await this.metadata
    return super.resolveModel(provider, model)
  }

  release(): void {
    this.releaseMetadata()
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected title request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise exact AbortSignal.reason propagation
        reject(signal.reason)
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

class DelayedSuccessAdapter extends LlmAdapter {
  constructor(private readonly delayMs: number) {
    super()
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    await new Promise<void>(resolve => setTimeout(resolve, this.delayMs))
    yield * SCRIPT
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  五个字标题  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
  maxAttempts: 1,
  retryDelaysMs: [],
} satisfies SessionTitleLlmConfig

const TITLE_PROVIDER = SessionTitleProviderId('test-title-provider')
let nextSession = 0

function request(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const session = ctx.sessions.create(SessionId(`title-call-${++nextSession}`))
  session.append('turn/start', {
    turn: 1,
  })
  const first = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const second = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '第二个问题' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return {
    session,
    messages: [
      { seq: first.seq, text: 'first prompt' },
      { seq: second.seq, text: '第二个问题' },
    ],
    route: { provider: 'current-route', model: 'current-model' },
    signal,
  }
}

function requestWithoutRoute(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const routed = request(ctx, signal)
  return { session: routed.session, messages: routed.messages, signal }
}

async function withScript(script: readonly StreamChunk[]): Promise<{
  ctx: Context
  adapter: RecordingAdapter
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(script)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

describe('generateSessionTitleWithLlm', () => {
  it.each(['cancelled', 'closed'] as const)('does not log dispatch after metadata lookup was %s', async (operation) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new DelayedMetadataAdapter()
    ctx.llm.registerAdapter(['current-route'], adapter)
    const controller = new AbortController()
    let ownerCtx!: Context
    const owner = await ctx.plugin(Object.assign((inner: Context) => { ownerCtx = inner }, { inject: ['sessions'] }))
    const providerRequest = request(ownerCtx, controller.signal)
    const pending = generateSessionTitleWithLlm(ctx, resolveSessionTitleLlmConfig(CONFIG),
      providerRequest, providerRequest.messages, TITLE_PROVIDER)
    const rejection = expect(pending).rejects.toThrow('title request cancelled')
    await adapter.started
    if (operation === 'closed') await owner.dispose()
    controller.abort(new Error('title request cancelled'))
    adapter.release()
    await rejection
    expect(adapter.requests).toHaveLength(0)
    const events = providerRequest.session.snapshotEvents()
    expect(events.some(event => event.type === 'session/title-llm-request')).toBe(false)
    expect(events.some(event => event.type === 'session/title-llm-attempt' && event.data.status === 'started')).toBe(false)
    if (operation === 'cancelled') {
      expect(events.findLast(event => event.type === 'session/title-llm-attempt')?.data)
        .toMatchObject({ status: 'cancelled', failureCode: 'TITLE_CANCELLED' })
      await owner.dispose()
    } else {
      expect(ctx.sessions.get(providerRequest.session.id)).toBeUndefined()
    }
  })

  it('logs cleaned model input while preserving plugin markers in source messages', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const providerRequest = request(ctx)
    const original = '@[AFP 图片策展](dsh-plugin:dsh-plugin-afp) 寻找香港风景'
    const message = providerRequest.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: original }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await generateSessionTitleWithLlm(ctx, resolveSessionTitleLlmConfig(CONFIG), providerRequest,
      [{ seq: message.seq, text: original }], TITLE_PROVIDER)
    const prompt = adapter.requests[0]?.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('寻找香港风景')
    expect(prompt?.type === 'text' && prompt.text).not.toContain('dsh-plugin:')
    expect(providerRequest.session.snapshotEvents().find(event => event.seq === message.seq)?.data)
      .toMatchObject({ content: [{ type: 'text', text: original }] })
  })

  it('retries a temporary network failure and empty output before accepting the third title', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new AttemptAdapter([
      Object.assign(new Error('socket failed at secret endpoint'), { code: 'ECONNRESET' }),
      [{ type: 'finish', reason: { kind: 'stop' } }],
      SCRIPT,
    ])
    ctx.llm.registerAdapter(['current-route'], adapter)
    const providerRequest = request(ctx)
    const result = await generateSessionTitleWithLlm(ctx,
      resolveSessionTitleLlmConfig({ ...CONFIG, maxAttempts: 3, retryDelaysMs: [0, 0] }),
      providerRequest, providerRequest.messages, TITLE_PROVIDER)
    expect(result.title).toBe('五个字标题')
    expect(adapter.requests).toHaveLength(3)
    const attempts = providerRequest.session.snapshotEvents().filter(event => event.type === 'session/title-llm-attempt')
    expect(attempts.map(event => event.data)).toMatchObject([
      { attempt: 1, status: 'started', reasoning: 'provider-default' },
      { attempt: 1, status: 'failed', failureCode: 'TITLE_NETWORK' },
      { attempt: 2, status: 'started' },
      { attempt: 2, status: 'failed', failureCode: 'TITLE_EMPTY' },
      { attempt: 3, status: 'started' },
      { attempt: 3, status: 'succeeded' },
    ])
    expect(JSON.stringify(attempts)).not.toContain('secret endpoint')
  })

  it('retries a provider-neutral SERVER terminal failure without depending on the provider message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new AttemptAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'Provider request failed' } } }],
      SCRIPT,
    ])
    ctx.llm.registerAdapter(['current-route'], adapter)
    const providerRequest = request(ctx)
    const result = await generateSessionTitleWithLlm(ctx,
      resolveSessionTitleLlmConfig({ ...CONFIG, maxAttempts: 3, retryDelaysMs: [0, 0] }),
      providerRequest, providerRequest.messages, TITLE_PROVIDER)
    expect(result.title).toBe('五个字标题')
    expect(adapter.requests).toHaveLength(2)
  })

  it.each([
    [['high', 'off', 'low'], 'off', 'disabled'],
    [['high', 'low'], 'low', 'lowest-declared'],
    [undefined, undefined, 'provider-default'],
  ] as const)('uses only a declared reasoning effort from %s', async (efforts, selected, reasoning) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT, undefined,
      efforts === undefined ? undefined : { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) })
    ctx.llm.registerAdapter(['current-route'], adapter)
    const providerRequest = request(ctx)
    await generateSessionTitleWithLlm(ctx, resolveSessionTitleLlmConfig(CONFIG),
      providerRequest, providerRequest.messages, TITLE_PROVIDER)
    expect(adapter.requests[0]?.reasoningEffort).toBe(selected)
    expect(providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/title-llm-attempt')?.data)
      .toMatchObject({ status: 'succeeded', reasoning })
  })

  it('stops after three rate-limit attempts and never retries authentication failure', async () => {
    for (const [failure, code, expectedAttempts] of [
      [Object.assign(new Error('Too many requests'), { status: 429 }), 'TITLE_RATE_LIMIT', 3],
      [Object.assign(new Error('Unauthorized secret key'), { status: 401 }), 'TITLE_AUTH', 1],
    ] as const) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      const adapter = new AttemptAdapter([failure, failure, failure])
      ctx.llm.registerAdapter(['current-route'], adapter)
      const providerRequest = request(ctx)
      await expect(generateSessionTitleWithLlm(ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, maxAttempts: 3, retryDelaysMs: [0, 0] }),
        providerRequest, providerRequest.messages, TITLE_PROVIDER)).rejects.toMatchObject({ code })
      expect(adapter.requests).toHaveLength(expectedAttempts)
      expect(JSON.stringify(providerRequest.session.snapshotEvents())).not.toContain('secret key')
    }
  })

  it('cancels a retry wait before another dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new AttemptAdapter([new Error('network unavailable'), SCRIPT])
    ctx.llm.registerAdapter(['current-route'], adapter)
    const controller = new AbortController()
    const providerRequest = request(ctx, controller.signal)
    let failed!: () => void
    const failure = new Promise<void>((resolve) => { failed = resolve })
    ctx.on('session/event', (session, event) => {
      if (session === providerRequest.session && event.type === 'session/title-llm-attempt' && event.data.status === 'failed') failed()
    })
    const pending = generateSessionTitleWithLlm(ctx,
      resolveSessionTitleLlmConfig({ ...CONFIG, maxAttempts: 3, retryDelaysMs: [1000, 3000] }),
      providerRequest, providerRequest.messages, TITLE_PROVIDER)
    const rejection = expect(pending).rejects.toThrow()
    await failure
    controller.abort(new Error('user cancelled'))
    await rejection
    expect(adapter.requests).toHaveLength(1)
  })
  it('uses the exact logged route, language targets, full framed input, and output token cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const providerRequest = request(ctx)
    let requestWasLoggedAtDispatch = false
    const adapter = new RecordingAdapter(SCRIPT, () => {
      requestWasLoggedAtDispatch = providerRequest.session.snapshotEvents()
        .some(event => event.type === 'session/title-llm-request')
    })
    ctx.llm.registerAdapter(['current-route'], adapter)

    const result = await generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )

    expect(result).toEqual({
      title: '五个字标题',
      messageSeqs: providerRequest.messages.map(message => message.seq),
      model: { provider: 'current-route', model: 'current-model' },
    })
    expect(requestWasLoggedAtDispatch).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    const options = adapter.requests[0]!
    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.messages)).toBe(true)
    expect(isAgentLoopRequest(options)).toBe(false)
    expect(options).toMatchObject({
      provider: 'current-route',
      model: 'current-model',
      maxTokens: 32,
      sessionId: providerRequest.session.id,
      purpose: 'session-title',
    })
    expect(options.system).toContain('5 words')
    expect(options.system).toContain('10 CJK characters')
    const prompt = options.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('first prompt')
    expect(prompt?.type === 'text' && prompt.text).toContain('第二个问题')
    expect(providerRequest.session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')?.data)
      .toEqual({
        titleProvider: TITLE_PROVIDER,
        messageSeqs: providerRequest.messages.map(message => message.seq),
        route: { provider: 'current-route', model: 'current-model' },
        system: options.system,
        messages: options.messages,
        maxTokens: 32,
      })
  })

  it('uses paired explicit overrides and bounds the final framed input before model dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['explicit-route'], adapter)
    const oversized = request(ctx)
    const [selected] = oversized.messages
    if (selected === undefined) throw new Error('expected one selected message')
    const rawInputBytes = Buffer.byteLength(selected.text, 'utf8')
    const config = resolveSessionTitleLlmConfig({
      ...CONFIG,
      provider: 'explicit-route',
      model: 'explicit-model',
      maxInputBytes: rawInputBytes,
    })

    await expect(generateSessionTitleWithLlm(ctx, config, oversized, [selected], TITLE_PROVIDER))
      .rejects.toThrow(/input.*bytes.*maxInputBytes/i)
    expect(adapter.requests).toEqual([])
    expect(oversized.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)

    const withinLimit = resolveSessionTitleLlmConfig({ ...config, maxInputBytes: 1_000 })
    const within = request(ctx)
    await generateSessionTitleWithLlm(ctx, withinLimit, within, [within.messages[0]!], TITLE_PROVIDER)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'explicit-route',
      model: 'explicit-model',
    })
  })

  it('requires every deployment limit and a complete optional route pair', () => {
    expect(() => resolveSessionTitleLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig('invalid' as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, extra: true } as SessionTitleLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 0 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 1.5 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'only-provider' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, model: 'only-model' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: '', model: 'model' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: '' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 1, model: 'model' } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: 1 } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must not exceed/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, maxAttempts: 4 })).toThrow(/invalid retry policy/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, maxAttempts: 3, retryDelaysMs: [0] })).toThrow(/invalid retry policy/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, retryDelaysMs: [-1] })).toThrow(/invalid retry policy/)
    const { maxAttempts: _attempts, retryDelaysMs: _delays, ...requiredConfig } = CONFIG
    expect(resolveSessionTitleLlmConfig(requiredConfig)).toMatchObject({ maxAttempts: 3, retryDelaysMs: [1000, 3000] })
    expect(() => resolveSessionTitleLlmConfig(CONFIG)).not.toThrow()
  })

  it('rejects an absent route, empty selection, and pre-aborted caller before model dispatch', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const config = resolveSessionTitleLlmConfig(CONFIG)
    const unrouted = requestWithoutRoute(ctx)
    await expect(generateSessionTitleWithLlm(ctx, config, unrouted, unrouted.messages, TITLE_PROVIDER))
      .rejects.toThrow(/no logged request route/)
    const empty = request(ctx)
    await expect(generateSessionTitleWithLlm(ctx, config, empty, [], TITLE_PROVIDER))
      .rejects.toThrow(/at least one source message/)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const aborted = request(ctx, controller.signal)
    await expect(generateSessionTitleWithLlm(ctx, config, aborted, aborted.messages, TITLE_PROVIDER))
      .rejects.toThrow('caller stopped')
    expect(adapter.requests).toEqual([])
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'UNRECOGNIZED' } }, 'TITLE_INVALID_OUTPUT'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'TITLE_CANCELLED'],
  ] satisfies Array<[FinishReason, string]>)('sanitizes %s terminal failure details', async (reason, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toMatchObject({ message: code, code })
    expect(providerRequest.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(true)
  })

  it.each([
    [{ kind: 'max-tokens' }, 'TITLE_INVALID_OUTPUT'],
    [{ kind: 'tool-calls' }, 'TITLE_INVALID_OUTPUT'],
    [{ kind: 'future-finish' } as never, 'TITLE_CONFIG'],
  ] satisfies Array<[FinishReason, string]>)('rejects the terminal finish reason %s', async (reason, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      providerRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toMatchObject({ code })
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const toolScript: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const tool = await withScript(toolScript)
    const toolRequest = request(tool.ctx)
    await expect(generateSessionTitleWithLlm(
      tool.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      toolRequest,
      toolRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toMatchObject({ code: 'TITLE_INVALID_OUTPUT' })

    const reasoning = await withScript([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const reasoningRequest = request(reasoning.ctx)
    await expect(generateSessionTitleWithLlm(
      reasoning.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      reasoningRequest,
      reasoningRequest.messages,
      TITLE_PROVIDER,
    )).rejects.toMatchObject({ code: 'TITLE_EMPTY' })
  })

  it('aborts a cooperative model stream at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new CooperativeAdapter())
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        providerRequest.messages,
        TITLE_PROVIDER,
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'TITLE_TIMEOUT',
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a successful stream that completes after the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new DelayedSuccessAdapter(20))
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        providerRequest.messages,
        TITLE_PROVIDER,
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'TITLE_TIMEOUT',
      })
      await vi.advanceTimersByTimeAsync(20)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
