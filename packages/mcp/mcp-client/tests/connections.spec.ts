import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import McpConnections from '../src/connections.ts'
import type { McpConnectionSnapshot } from '../src/types.ts'

it('tracks connection readiness independently of plugin activation and removes disposed registrations', async () => {
  const ctx = new Context()
  await ctx.plugin(McpConnections)
  let state: McpConnectionSnapshot = { phase: 'connecting', tools: [] }
  const remove = ctx.mcpConnections.register(ctx.fiber, () => state)
  expect(ctx.mcpConnections.snapshot(ctx.fiber)).toEqual({ phase: 'connecting', tools: [] })
  state = { phase: 'connected', tools: ['mcp__demo__search'] }
  expect(ctx.mcpConnections.snapshot(ctx.fiber)).toEqual(state)
  remove()
  expect(ctx.mcpConnections.snapshot(ctx.fiber)).toBeUndefined()
  await ctx.fiber.dispose()
})
