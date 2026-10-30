/** Bounded conversation output is retained at task checkpoints rather than per-token manifests. */
import type { AnalysisProcess, AnalysisMessage, ProcessUpdate } from '../shared/analysis-process.ts'
import type { Limits } from './config.ts'

/** @param previous Last output, absent for a new task. @param update Actual phase/text delta. @param limits Frozen task bounds. @param at Event timestamp. @returns Detached bounded process state. */
export function updateAnalysisProcess(previous: AnalysisProcess | undefined, update: ProcessUpdate, limits: Limits, at: string): AnalysisProcess {
  const events = [...(previous?.events ?? [])]
  if (!previous || previous.phase !== update.phase || update.batch !== undefined) events.push({ sequence: (events.at(-1)?.sequence ?? -1) + 1, at, phase: update.phase, imageIds: update.imageIds ?? [], ...(update.batch !== undefined ? { batch: update.batch } : {}) })
  const content = (update.resetOutput ? '' : previous?.content ?? '') + (update.content ?? '')
  const reasoning = (update.resetOutput ? '' : previous?.reasoning ?? '') + (update.reasoning ?? '')
  const messages: AnalysisMessage[] = [...(previous?.messages ?? [])]
  if (update.resetOutput && messages.at(-1)?.state === 'streaming') messages[messages.length - 1] = { ...messages.at(-1)!, state: 'interrupted' }
  if (update.resetOutput) messages.push({ sequence: (messages.at(-1)?.sequence ?? -1) + 1, kind: update.phase === 'summarizing' ? 'summary' : 'analysis', ...(update.batch !== undefined ? { batch: update.batch } : {}), imageIds: update.imageIds ?? [], content: '', reasoning: '', state: 'streaming', at, updatedAt: at })
  const last = messages.at(-1)
  if (last) {
    const state = last.state === 'complete' || ['validating', 'saving', 'completed'].includes(update.phase) ? 'complete' : update.phase === 'retrying' ? 'failed' : update.phase === 'paused' && last.state === 'streaming' ? 'interrupted' : update.phase === 'interrupted' || update.phase === 'cancelled' || update.phase === 'failed' ? update.phase : last.state
    messages[messages.length - 1] = { ...last, ...(update.requestId ? { requestId: update.requestId } : {}), content: last.content + (update.content ?? ''), reasoning: last.reasoning + (update.reasoning ?? ''), state, updatedAt: at }
  }
  let remaining = limits.maxProcessTextChars, clipped = events.length > limits.maxProcessEvents || messages.length > limits.maxProcessEvents
  const retained: AnalysisMessage[] = []
  for (const message of messages.slice(-limits.maxProcessEvents).reverse()) {
    const text = remaining > 0 ? message.content.slice(-remaining) : ''; remaining -= text.length
    const thought = remaining > 0 ? message.reasoning.slice(-remaining) : ''; remaining -= thought.length
    if (text !== message.content || thought !== message.reasoning) clipped = true
    retained.unshift({ ...message, content: text, reasoning: thought })
  }
  return { phase: update.phase, events: events.slice(-limits.maxProcessEvents), content: content.slice(-limits.maxProcessTextChars), reasoning: reasoning.slice(-limits.maxProcessTextChars), messages: retained, truncated: previous?.truncated === true || clipped || content.length > limits.maxProcessTextChars || reasoning.length > limits.maxProcessTextChars, updatedAt: at }
}
