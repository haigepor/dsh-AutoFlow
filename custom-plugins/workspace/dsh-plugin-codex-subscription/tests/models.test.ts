/** Directory fixtures separate explicit server capabilities from installed compatibility defaults. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Model } from '@earendil-works/pi-ai'
import { codexDiscoveryView, resolveCodexModels, resolveModelSettings } from '../src/host/models.ts'
import { buildModelRoutes, selectModelRoute } from '../src/host/accounts/routes.ts'

const known: Model<'openai-codex-responses'> = { id: 'known', name: 'Known', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://fixture.invalid', contextWindow: 65536, maxTokens: 16384, input: ['text', 'image'], reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }

test('malformed, hidden and underspecified unknown models cannot remove valid directory entries', () => {
  const snapshot = resolveCodexModels({ models: [
    { slug: 'broken', context_window: -1 }, { slug: 'hidden', visibility: 'hide', context_window: 2048, input_modalities: ['text'] },
    { slug: 'unknown-without-capabilities' }, { slug: 'known', priority: 9 },
    { slug: 'future', priority: 1, context_window: 4096, input_modalities: ['text'], supported_reasoning_levels: [], service_tiers: [{ id: 'priority' }] },
  ] }, [known], resolveModelSettings({ fallbackMaxTokens: 2048 }), 'https://fixture.invalid')
  assert.deepEqual(snapshot.views.map(model => model.id), ['future', 'known'])
  assert.equal(snapshot.models[0]?.maxTokens, 2048)
  assert.equal(snapshot.models[0]?.reasoning, false)
  assert.deepEqual(snapshot.views[0]?.serviceTiers, ['priority'])
  assert.equal(snapshot.models[1]?.contextWindow, known.contextWindow)
  assert.deepEqual(snapshot.models[1]?.input, ['text', 'image'])
})

test('explicit text-only input, output limits and no reasoning override the installed native catalog', () => {
  const snapshot = resolveCodexModels({ models: [{ slug: 'known', context_window: 2048, max_output_tokens: 4096,
    input_modalities: ['text'], supported_reasoning_levels: [{ effort: 'none' }], default_reasoning_level: 'high' }] }, [known], resolveModelSettings(), 'https://fixture.invalid')
  assert.deepEqual(snapshot.models[0]?.input, ['text'])
  assert.equal(snapshot.models[0]?.contextWindow, 2048)
  assert.equal(snapshot.models[0]?.maxTokens, 2048)
  assert.equal(snapshot.models[0]?.reasoning, false)
  assert.equal(snapshot.defaults.has('known'), false)
})

test('capability aliases are deterministic, survive becoming the default, and keep each advertised combination satisfiable', () => {
  const snapshots = [4096, 65536].map(context_window => resolveCodexModels({ models: [{ slug: 'known', context_window, input_modalities: ['text'],
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] }, [known], resolveModelSettings(), 'https://fixture.invalid'))
  const accounts = snapshots.map((snapshot, index) => ({ accountKey: `fixture-${index}`, snapshot }))
  const routes = buildModelRoutes(accounts)
  assert.deepEqual(buildModelRoutes(accounts.slice().reverse()), routes)
  assert.equal(routes[0]?.view.contextWindow, 65536); assert.deepEqual(routes[0]?.view.accountKeys, ['fixture-1'])
  const basic = routes[1]!
  assert.deepEqual(basic.view.accountKeys, ['fixture-0', 'fixture-1'])
  const remaining = buildModelRoutes([accounts[0]!]), recovered = selectModelRoute(remaining, basic.view.id)!
  assert.equal(recovered.view.id, basic.view.id); assert.equal(recovered.view.contextWindow, 4096)
  assert.equal(recovered.snapshot.models[0]?.id, basic.view.id)
  assert.equal(selectModelRoute(remaining, routes[0]!.view.capabilityId), undefined)
  assert.equal(selectModelRoute(routes, basic.view.id, 'max'), undefined)
})

test('settings discovery retains account capabilities while omitting account identities', () => {
  const [view] = resolveCodexModels({ models: [{ slug: 'known', context_window: 8192, input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high', max_output_tokens: 2048 }] }, [known], resolveModelSettings(), 'https://fixture.invalid').views
  assert.ok(view)
  assert.deepEqual(codexDiscoveryView(view), { id: 'known', name: 'Known', contextWindow: 8192, maxTokens: 2048, inputModalities: ['text', 'image'],
    reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' } })
})
