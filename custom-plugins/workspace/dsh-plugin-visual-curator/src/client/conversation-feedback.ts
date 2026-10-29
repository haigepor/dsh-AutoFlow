/** Conversation reads have their own Session grants and never change workbench selection. */
import { z } from 'zod'
import type { ClientTransport } from './store.ts'
import { runResultFilterSchema, searchIssueSchema } from '../shared/search-feedback.ts'

export const conversationRunSchema = z.object({
  runId: z.string().min(1), owner: z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  kind: z.enum(['search', 'crop', 'analyze', 'evaluate', 'export']),
  status: z.enum(['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling', 'cancelled', 'completed', 'failed']),
  stage: z.string().optional(), counts: z.record(z.string(), z.number()), warnings: z.array(z.string()),
  resultSummary: z.object({ selected: z.number(), needsReview: z.number(), candidates: z.number(), target: z.number().nullable(), rejected: z.number().optional(), technicalFailed: z.number().optional(), processing: z.number().optional(), pending: z.number().optional(), sourceImages: z.number().optional(), unavailable: z.number().optional() }).optional(),
  issues: z.array(searchIssueSchema).default([]),
  delivery: z.object({ status: z.enum(['pending', 'delivered']), directory: z.string().optional(), files: z.number() }).optional(),
  results: z.array(z.object({ imageVersionId: z.string(), name: z.string(), previewPath: z.string(), resultCategory: runResultFilterSchema.exclude(['all']).optional(), verdict: z.enum(['pass', 'reject', 'needs-review']).optional() })),
})
export type ConversationRun = z.infer<typeof conversationRunSchema>
export interface ConversationFeedbackEntry { run?: ConversationRun; freshness: 'loading' | 'current' | 'stale'; error?: string }
export interface ConversationFeedbackState { runs: Readonly<Record<string, ConversationFeedbackEntry>> }
interface FeedbackSource { getSnapshot(): ConversationFeedbackState; subscribe(listener: () => void): () => void }

const grantSchema = z.object({ sessionToken: z.string().min(1), expiresAt: z.number(), pollIntervalMs: z.number().int().positive() })
interface Observation {
  sessionId: string; runId: string; observers: number; generation: number
  grant?: z.infer<typeof grantSchema>; interval?: number; controller?: AbortController; cancelTimer?: () => void
}

/** @param dependencies Authenticated reads and optional deterministic timer seam. @returns Shared per-Session/Run observation with bounded lifecycle and immutable snapshots. */
export function createConversationFeedback(dependencies: Pick<ClientTransport, 'invoke'> & { schedule?(work: () => void, delay: number): () => void }) {
  const sessions = new Map<string, { snapshot: ConversationFeedbackState; listeners: Set<() => void>; source: FeedbackSource }>()
  const observations = new Map<string, Observation>()
  let disposed = false
  const schedule = dependencies.schedule ?? ((work, delay) => { const timer = setTimeout(work, delay); return () => clearTimeout(timer) })
  const key = (sessionId: string, runId: string) => JSON.stringify([sessionId, runId])
  function session(sessionId: string) {
    let value = sessions.get(sessionId)
    if (!value) {
      const listeners = new Set<() => void>()
      const created: { snapshot: ConversationFeedbackState; listeners: Set<() => void>; source: FeedbackSource } = {
        snapshot: { runs: {} }, listeners,
        source: {
          getSnapshot: () => created.snapshot,
          subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        },
      }
      value = created; sessions.set(sessionId, created)
    }
    return value
  }
  function publish(item: Observation, patch: ConversationFeedbackEntry) {
    const value = session(item.sessionId)
    value.snapshot = { runs: { ...value.snapshot.runs, [item.runId]: patch } }
    for (const listener of value.listeners) listener()
  }
  function cancel(item: Observation) { ++item.generation; item.controller?.abort(); delete item.controller; item.cancelTimer?.(); delete item.cancelTimer }
  async function read(item: Observation): Promise<void> {
    if (disposed || !item.observers || item.controller) return
    item.cancelTimer?.(); delete item.cancelTimer
    const controller = new AbortController(), generation = item.generation
    item.controller = controller
    const current = () => !disposed && !controller.signal.aborted && item.observers > 0 && item.generation === generation
    const previous = session(item.sessionId).snapshot.runs[item.runId]
    if (!previous?.run) publish(item, { freshness: 'loading' })
    let again = false
    try {
      if (!item.grant || item.grant.expiresAt <= Date.now()) {
        const grant = grantSchema.parse(await dependencies.invoke('session-open', { sessionId: item.sessionId }, controller.signal))
        if (!current()) return
        item.grant = grant; item.interval = grant.pollIntervalMs
      }
      const run = conversationRunSchema.parse(await dependencies.invoke('run-get', { sessionId: item.sessionId, sessionToken: item.grant.sessionToken, runId: item.runId, resultFilter: 'all', pageSize: 4 }, controller.signal))
      if (!current()) return
      if (run.runId !== item.runId || run.owner.sessionId !== item.sessionId) throw Object.assign(new Error('The task belongs to another Session.'), { code: 'owner-denied' })
      publish(item, { run, freshness: 'current' })
      again = ['created', 'running', 'pausing', 'cancelling'].includes(run.status)
    } catch (error) {
      if (!current()) return
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'read-failed'
      const saved = session(item.sessionId).snapshot.runs[item.runId]?.run
      publish(item, { ...(saved ? { run: saved } : {}), freshness: 'stale', error: code === 'owner-denied' ? code : 'read-failed' })
      delete item.grant
      again = code !== 'owner-denied'
    } finally {
      if (current()) {
        delete item.controller
        if (again && item.interval) item.cancelTimer = schedule(() => { delete item.cancelTimer; void read(item) }, item.interval)
      }
    }
  }
  return {
    source(sessionId: string) {
      return session(sessionId).source
    },
    watch(sessionId: string, runId: string) {
      if (disposed) return () => {}
      const id = key(sessionId, runId)
      let item = observations.get(id)
      if (!item) { item = { sessionId, runId, observers: 0, generation: 0 }; observations.set(id, item) }
      item.observers++
      if (item.observers === 1) void read(item)
      const active = item
      let closed = false
      return () => { if (closed) return; closed = true; if (--active.observers === 0) { cancel(active); delete active.grant } }
    },
    refresh(sessionId: string, runId: string) { const item = observations.get(key(sessionId, runId)); if (item) { cancel(item); void read(item) } },
    reset() {
      for (const item of observations.values()) {
        cancel(item); delete item.grant
        const previous = session(item.sessionId).snapshot.runs[item.runId]
        if (previous) publish(item, { ...previous, freshness: 'stale' })
        if (item.observers) void read(item)
      }
    },
    dispose() { disposed = true; for (const item of observations.values()) cancel(item); observations.clear(); sessions.clear() },
  }
}
