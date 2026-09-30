import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../execute.js'

test('Agent tool and page action execute the same packaged script', async () => {
  let action
  let tool
  const disposers = []
  const manager = {
    registerAction(_packageName, _id, run) { action = run; return () => { action = undefined } },
    async invokeAction(_packageName, _id, input, signal) {
      if (!action) throw new Error('Action unavailable')
      return { output: await action(input, signal) }
    },
  }
  apply({
    pluginManager: manager,
    tools: { register(value) { tool = value; return () => { tool = undefined } } },
    effect(register) { disposers.push(register()) },
  })
  const signal = new AbortController().signal
  const page = await manager.invokeAction('dsh-custom-plugin-demo', 'run', {}, signal)
  const agent = await tool.execute({}, { signal })
  assert.equal(page.output, 'DSH custom plugin demo executed successfully.')
  assert.equal(agent, page.output)
  for (const dispose of disposers.reverse()) dispose()
  await assert.rejects(manager.invokeAction('dsh-custom-plugin-demo', 'run', {}, signal), /unavailable/)
  assert.equal(tool, undefined)
})
