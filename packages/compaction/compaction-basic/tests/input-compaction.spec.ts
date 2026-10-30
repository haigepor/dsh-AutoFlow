import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

class Adapter extends LlmAdapter {
  mode: 'stop' | 'max-tokens' | 'incomplete' | 'large' | 'tool' | 'waiting' = 'stop'
  context = true
  usage = false
  reply = 'Green palette; uncertain lighting; negative examples stay negative.'
  readonly entered = Promise.withResolvers<undefined>()
  calls: GenerateOptions[] = []
  override async resolveModel(provider: string, id: string) {
    return { provider, id, name: id, ...(this.context ? { context: { contextWindow: 2000 } } : {}), defaultMaxTokens: 100 }
  }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options)
    this.entered.resolve(undefined)
    if (this.mode === 'waiting') {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      options.signal?.throwIfAborted()
    }
    yield { type: 'reasoning-delta', index: 0, text: 'Review data.' }
    yield { type: 'text-delta', index: 1, text: this.mode === 'large' ? 'A'.repeat(7000) : this.reply }
    if (this.mode === 'tool') yield { type: 'tool-call-delta', index: 2, id: ToolCallId('unexpected'), name: 'unexpected', argumentsDelta: '{}' }
    if (this.usage) yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
    if (this.mode !== 'incomplete') yield { type: 'finish', reason: { kind: this.mode === 'max-tokens' ? 'max-tokens' : 'stop' } }
  }
}

function fixture(overrides: BasicCompactionConfig = {}) {
  const ctx = new Context(), llm = new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const adapter = new Adapter(), dispose = llm.registerAdapter(['vision'], adapter)
  const engine = new BasicCompactionEngine(ctx, {
    auto: false, thresholdRatio: 0.8, headroomTokens: 100, retainTokens: 0, maxTokens: 100, compactionRetries: 1, ...overrides,
  })
  const input = { config: { provider: 'vision', model: 'model', maxTokens: 100 }, contextWindow: 2000, retainedTokens: 200, chunks: ['A'.repeat(3000), 'B'.repeat(3000), 'C'.repeat(3000)], instruction: 'Preserve evidence, uncertainty and negative examples.', maxOutputBytes: 50_000 }
  return { ctx, engine, adapter, input, dispose: async () => { dispose(); await ctx.fiber.dispose() } }
}

it('prices standalone inputs using native policy and avoids calls below pressure', async () => {
  const f = fixture()
  try {
    const result = await f.engine.compactInput({ ...f.input, chunks: ['short'] }, async (_call, work) => work(new AbortController().signal, async () => {}), new AbortController().signal)
    expect(result).toBeNull()
    expect(f.adapter.calls).toHaveLength(0)
  } finally { await f.dispose() }
})

it('compacts bounded input groups through an owner callback without a Session', async () => {
  const f = fixture(), records: string[] = []
  try {
    const result = await f.engine.compactInput(f.input, async (call, work) => {
      records.push(JSON.stringify(call))
      return work(new AbortController().signal, async () => {})
    }, new AbortController().signal)
    expect(result?.text).toContain('Green palette')
    expect(result!.outputTokens).toBeLessThan(result!.inputTokens)
    expect(records.length).toBeGreaterThan(0)
    expect(f.adapter.calls.every(call => call.purpose === 'compaction')).toBe(true)
  } finally { await f.dispose() }
})

it.each(['max-tokens', 'incomplete', 'large'] as const)('rejects %s compression without returning usable text', async (mode) => {
  const f = fixture(); f.adapter.mode = mode
  try {
    await expect(f.engine.compactInput(
      f.input, async (_call, work) => work(new AbortController().signal, async () => {}), new AbortController().signal,
    )).rejects.toThrow()
  } finally { await f.dispose() }
})

it('does not dispatch cancelled input compression', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  try {
    await expect(f.engine.compactInput(
      f.input, async (_call, work) => work(controller.signal, async () => {}), controller.signal,
    )).rejects.toThrow()
    expect(f.adapter.calls).toHaveLength(0)
  } finally { await f.dispose() }
})

it('inherits a configured summary route and retains returned usage', async () => {
  const f = fixture({ summarizationProvider: 'summary', summarizationModel: 'summary-model' }), remove = f.ctx.llm.registerAdapter(['summary'], f.adapter)
  f.adapter.usage = true
  const metadata: string[] = []
  try {
    await f.engine.compactInput(f.input, async (_call, work) => work(new AbortController().signal, async (value) => {
      metadata.push(JSON.stringify(value))
    }), new AbortController().signal)
    expect(f.adapter.calls[0]?.provider).toBe('summary')
    expect(metadata.some(value => value.includes('inputTokens'))).toBe(true)
  } finally { remove(); await f.dispose() }
})

it('handles an omitted output reservation without creating an artificial output cap', async () => {
  const f = fixture()
  try {
    expect(await f.engine.compactInput({ ...f.input, config: { provider: 'vision', model: 'model' }, chunks: ['short'] }, async (_call, work) => work(new AbortController().signal, async () => {}), new AbortController().signal)).toBeNull()
  } finally { await f.dispose() }
})

it.each(['fixed', 'chunk', 'context', 'bytes', 'empty', 'tool', 'convergence'] as const)('stops unsafe %s input compression', async (mode) => {
  const f = fixture()
  if (mode === 'context') f.adapter.context = false
  if (mode === 'empty') f.adapter.reply = ' '
  if (mode === 'tool') f.adapter.mode = 'tool'
  if (mode === 'convergence') f.adapter.reply = 'S'.repeat(1800)
  const input = { ...f.input,
    ...(mode === 'fixed' ? { retainedTokens: 2000 } : {}),
    ...(mode === 'chunk' ? { chunks: ['A'.repeat(9000)] } : {}),
    ...(mode === 'bytes' ? { maxOutputBytes: 1 } : {}),
    ...(mode === 'convergence' ? { retainedTokens: 1500 } : {}),
  }
  try {
    await expect(f.engine.compactInput(
      input, async (_call, work) => work(new AbortController().signal, async () => {}), new AbortController().signal,
    )).rejects.toThrow()
  } finally { await f.dispose() }
})

it('cancels a running native summary instead of returning partial text', async () => {
  const f = fixture(), controller = new AbortController(); f.adapter.mode = 'waiting'
  try {
    const pending = f.engine.compactInput(f.input, async (_call, work) => work(controller.signal, async () => {}), controller.signal)
    await f.adapter.entered.promise
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(f.adapter.calls[0]?.signal?.aborted).toBe(true)
  } finally { await f.dispose() }
})
