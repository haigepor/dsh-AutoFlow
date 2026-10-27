/** Recorded navigation fixture owns a real Session and tool result without an external model. */
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { CuratorService } from '../../src/host/service.ts'

class NavigationAdapter extends LlmAdapter {
  private called = false
  constructor(private readonly runId: string) { super() }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    request.signal?.throwIfAborted()
    if (!this.called) {
      this.called = true
      const id = ToolCallId('execution-navigation'), name = 'visual_run_get', args = JSON.stringify({ runId: this.runId })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = 'Open this saved task in its original Session.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** @param ctx Isolated browser profile. @param service Real provider using fixture HTTP. */
export function mountExecutionNavigation(ctx: Context, service: CuratorService): void {
  ctx.inject(['connection', 'agentLoop', 'llm'], scope => {
    let seeded: { runId: string; sessionId: string } | undefined
    scope.effect(() => scope.connection.fetch.register({ path: '/api/visual-curator/execution-fixture', methods: ['POST'], requestBody: 'buffered', async fetch() {
      try {
      if (seeded) return Response.json(seeded)
      const human = { kind: 'human' as const, id: 'fixture-owner', profileId: service.profileId }, signal = new AbortController().signal
      const styles = z.object({ items: z.array(z.object({ modelProfile: z.object({ id: z.string() }).optional() })) }).parse(await service.action({ operation: 'style-list', args: {} }, human, signal))
      const profile = styles.items.find(style => style.modelProfile)?.modelProfile
      if (!profile) return Response.json({ error: 'Analyze references first' }, { status: 409 })
      const sessionId = SessionId(`execution-browser-${Date.now()}`)
      const agent = await scope.agentLoop.create(sessionId, { provider: sessionId, model: 'recorded-navigation' }, { cwd: process.cwd() })
      const usages = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await service.action({ operation: 'usage-list', args: {} }, human, signal))
      const usage = usages.items[0]
      if (!usage) return Response.json({ error: 'Save a usage first' }, { status: 409 })
      const started = z.object({ runId: z.string() }).parse(await service.action({ operation: 'search-start', args: { operationId: `fixture-${sessionId}`, releaseId: profile.id, usageRevisionId: usage.id, sourceId: 'images', taskBrief: 'Green garden navigation fixture', targetCount: 1, budgets: { maxVisionCalls: 30, maxSearchPages: 1 } } }, { ...human, kind: 'agent', id: sessionId, sessionId }, signal))
      scope.llm.registerAdapter([sessionId], new NavigationAdapter(started.runId))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect execution navigation fixture' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      seeded = { runId: started.runId, sessionId }
      return Response.json(seeded)
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }) }
    } }), 'Recorded execution navigation')
  })
}
