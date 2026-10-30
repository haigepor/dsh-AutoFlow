/** Real Loader composition for Web's absent host compaction and plugin-owned native scope. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { nativeContextScope } from '../src/host/plugin.ts'

class Adapter extends LlmAdapter {
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 2000 } } }
  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'Green palette, uncertain lighting.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('a Loader-mounted workbench scope compresses without host compaction and unloads its native backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-context-loader-')), ctx = new Context()
  let scope: Context | undefined
  try {
    const path = join(root, 'cordis.yml')
    await writeFile(path, ['llm', 'sessions', 'projections', 'meter', 'consumer'].map(name => `- name: cordis:${name}`).join('\n') + '\n', 'utf8')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.llm = LlmRuntime
    ctx.loader.builtins.sessions = SessionStore
    ctx.loader.builtins.projections = SessionProjectionRegistry
    ctx.loader.builtins.meter = TokenMeter
    ctx.loader.builtins.consumer = { name: 'curator-context-consumer', inject: ['llm', 'sessions', 'tokenMeter'], async apply(owner: Context) { scope = await nativeContextScope(owner, { thresholdRatio: 0.8, retainTokens: 0, headroomTokens: 100, maxTokens: 100 }) } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    assert.ok(scope)
    assert.equal(ctx.get('compaction'), undefined)
    const engine = scope.get('compaction')
    assert.ok(engine instanceof BasicCompactionEngine)
    assert.equal(engine.config.auto, false)
    const remove = ctx.llm.registerAdapter(['vision'], new Adapter())
    try {
      const result = await engine.compactInput({ config: { provider: 'vision', model: 'vision', maxTokens: 100 }, contextWindow: 2000, retainedTokens: 200, chunks: ['A'.repeat(3000), 'B'.repeat(3000), 'C'.repeat(3000)], instruction: 'Preserve visual evidence.', maxOutputBytes: 1000 }, async (_call, work) => work(new AbortController().signal, async () => {}), new AbortController().signal)
      assert.ok(result?.text.includes('Green palette'))
      assert.equal(await nativeContextScope(scope), scope)
    } finally { remove() }
    const consumer = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:consumer')
    assert.ok(consumer?.fiber)
    await consumer.fiber.dispose()
    assert.equal(scope.get('compaction'), undefined)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
