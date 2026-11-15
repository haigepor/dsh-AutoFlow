/** Image source selection must not await an unrelated provider's remote catalog. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'

test('Codex image options do not query or wait for the unselected API provider', async () => {
  const f = await serviceFixture(), ctx = new Context(), llm = new LlmRuntime(ctx)
  const gate = Promise.withResolvers<void>(), calls: string[] = []
  const dispose = ['autoflow-codex', 'visual-curator-openai'].map(provider => llm.registerImageProvider(provider, {
    async listModels() { calls.push(provider); if (provider === 'visual-curator-openai') await gate.promise; return [{ id: 'fixture-image', name: 'Fixture image' }] },
    async listSources() { return [{ id: 'local-account', name: 'Local account', available: true }] },
    async generate() { throw new Error('Image discovery must never generate images') },
  }))
  await f.service.initialize(); f.host.llm = llm
  let ready = false
  const pending = f.action('wallpaper-options', { provider: 'autoflow-codex' }).then(value => { ready = true; return value })
  try {
    await setImmediate()
    assert.equal(ready, true, 'The selected local catalog must resolve while the other provider is blocked')
    assert.deepEqual(calls, ['autoflow-codex'])
    const result = z.object({ models: z.array(z.object({ id: z.string() })), providers: z.array(z.object({ id: z.string() })) }).parse(await pending)
    assert.deepEqual(result.models.map(model => model.id), ['fixture-image'])
    assert.deepEqual(result.providers.map(provider => provider.id), ['autoflow-codex', 'visual-curator-openai'])
    gate.resolve(); calls.length = 0
    await f.action('wallpaper-options', { operationId: 'existing-reader' })
    assert.deepEqual(calls.sort(), ['autoflow-codex', 'visual-curator-openai'], 'Existing full-catalog consumers retain both providers')
    calls.length = 0
    await f.action('wallpaper-options', { provider: 'visual-curator-openai' })
    assert.deepEqual(calls, ['visual-curator-openai'])
  } finally { gate.resolve(); await pending; dispose.forEach(close => close()); await ctx.fiber.dispose(); await f.cleanup() }
})
