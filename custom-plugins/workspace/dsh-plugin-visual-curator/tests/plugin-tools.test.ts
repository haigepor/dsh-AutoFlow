import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createAgentTools } from '../src/host/tools.ts'
import { safeFailure } from '../src/host/plugin.ts'
import { CuratorError } from '../src/shared/errors.ts'

test('the optional Agent row exposes exactly eight operations and no human confirmation commands', () => {
  const tools = createAgentTools({ profileId: 'profile-a', action: async () => { throw new Error('Should not execute while registering') } })
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'visual_style_list', 'visual_style_get', 'visual_search_start', 'visual_crop_start',
    'visual_run_get', 'visual_feedback_suggest', 'visual_export_start', 'visual_export_get',
  ].sort())
  for (const tool of tools) {
    const schema = JSON.parse(JSON.stringify(tool.parameters))
    assert.equal(schema.additionalProperties, false)
    assert.ok(!Object.hasOwn(schema.properties, 'actor'))
    assert.ok(!Object.hasOwn(schema.properties, 'profileId'))
    assert.ok(!Object.hasOwn(schema.properties, 'sessionId'))
    assert.doesNotMatch(tool.name, /publish|default|confirm|split|activate/)
  }
  const search = tools.find(tool => tool.name === 'visual_search_start')!
  const parameters = JSON.parse(JSON.stringify(search.parameters))
  assert.deepEqual(parameters.required, ['releaseId', 'usageRevisionId', 'sourceId', 'taskBrief', 'budgets'])
  assert.ok(parameters.properties.budgets.required.includes('maxRetryAttempts'))
})

test('Agent tools reject a missing Session before reaching the shared service', async () => {
  let called = false
  const tools = createAgentTools({ profileId: 'profile-a', action: async () => { called = true; return {} } })
  const execution: ToolRunContext = {
    callId: ToolCallId('call-a'), rootCallId: ToolCallId('call-a'), name: 'visual_style_list', arguments: {},
    token: Symbol('fixture') as ToolExecutionToken, signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
  }
  await assert.rejects(tools[0]!.execute({}, execution), /owner-denied/)
  assert.equal(called, false)
})

test('safe adapter failures retain structured cross-bundle codes and discard untrusted errors', () => {
  const safe = safeFailure(new CuratorError('revision-conflict', 'feedback', 'This record changed.', { suggestedAction: 'Refresh.' }))
  assert.equal(safe.code, 'revision-conflict'); assert.equal(safe.retryable, false)
  const anotherBundle = Object.assign(new Error('private diagnostic'), { code: 'owner-denied', stage: 'authorization', retryable: false, safeMessage: 'This record is unavailable.', suggestedAction: 'Use the original Session.' })
  assert.equal(safeFailure(anotherBundle).code, 'owner-denied')
  const unsafe = safeFailure(new Error('Bearer secret-key https://cdn.invalid/?signature=private'))
  assert.equal(unsafe.code, 'operation-failed')
  assert.doesNotMatch(JSON.stringify(unsafe), /Bearer|secret-key|signature|cdn\.invalid/)
})
