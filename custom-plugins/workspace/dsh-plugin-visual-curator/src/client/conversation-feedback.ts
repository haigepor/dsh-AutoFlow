/** Conversation reads have their own Session grants and never change workbench selection. */
import { z } from 'zod'
import type { ClientTransport } from './store.ts'
import { runResultFilterSchema, searchIssueSchema, type RunResultFilter } from '../shared/search-feedback.ts'
import { searchLaunchInputSchema, searchLaunchViewSchema, type SearchLaunchView } from '../shared/search-launch.ts'
import { galleryMediaUrlSchema } from '../shared/gallery.ts'

export const conversationRunSchema = z.object({
  runId: z.string().min(1), owner: z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  revision: z.number().int().positive().optional(), outputKind: z.enum(['preview', 'original', 'usage']).optional(), launchId: searchLaunchInputSchema.shape.operationId.optional(),
  kind: z.enum(['search', 'crop', 'analyze', 'evaluate', 'export']),
  status: z.enum(['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling', 'cancelled', 'completed', 'failed']),
  stage: z.string().optional(), counts: z.record(z.string(), z.number()), warnings: z.array(z.string()),
  resultFilter: runResultFilterSchema.optional(), pageToken: z.string().optional(),
  resultSummary: z.object({ selected: z.number(), needsReview: z.number(), candidates: z.number(), target: z.number().nullable(), rejected: z.number().optional(), technicalFailed: z.number().optional(), processing: z.number().optional(), pending: z.number().optional(), sourceImages: z.number().optional(), unavailable: z.number().optional() }).optional(),
  issues: z.array(searchIssueSchema).default([]),
  delivery: z.object({ status: z.enum(['pending', 'delivered']), directory: z.string().optional(), files: z.number() }).optional(),
  results: z.array(z.object({ imageVersionId: z.string(), name: z.string(), previewPath: z.string(), previewUrl: galleryMediaUrlSchema.optional(), resultCategory: runResultFilterSchema.exclude(['all']).optional(), verdict: z.enum(['pass', 'reject', 'needs-review']).optional() })),
})
export type ConversationRun = z.infer<typeof conversationRunSchema>
export interface ConversationFeedbackEntry { run?: ConversationRun; freshness: 'loading' | 'current' | 'stale'; resultFilter?: RunResultFilter; loadingMore?: boolean; error?: string }
const taskListSchema = z.object({ sessionId: z.string().min(1), tasks: z.array(z.object({ runId: z.string().min(1), revision: z.number().int().positive().optional(), kind: z.enum(['search', 'crop']), status: conversationRunSchema.shape.status, taskBrief: z.string() })), launch: searchLaunchViewSchema.optional() })
export interface ConversationTaskList { items: z.infer<typeof taskListSchema>['tasks']; launch?: SearchLaunchView; freshness: ConversationFeedbackEntry['freshness']; error?: string }
export interface ConversationFeedbackState { runs: Readonly<Record<string, ConversationFeedbackEntry>>; tasks?: ConversationTaskList; selectedRunId?: string }
interface FeedbackSource { getSnapshot(): ConversationFeedbackState; subscribe(listener: () => void): () => void }
interface FeedbackSession {
  snapshot: ConversationFeedbackState; listeners: Set<() => void>; source: FeedbackSource; dockSource: FeedbackSource
  dockObservers: number; preferredRunId?: string; selectedStop?: () => void
}

const grantSchema = z.object({ sessionToken: z.string().min(1), expiresAt: z.number(), pollIntervalMs: z.number().int().positive() })
interface Observation {
  sessionId: string; runId?: string; observers: number; generation: number
  resultFilter: RunResultFilter; resultLimit: number
  grant?: z.infer<typeof grantSchema>; resultGrant?: string; interval?: number; controller?: AbortController; cancelTimer?: () => void
}

/** @param dependencies Authenticated reads and optional deterministic timer seam. @returns Shared per-Session/Run observation with bounded lifecycle and immutable snapshots. */
export function createConversationFeedback(dependencies: Pick<ClientTransport, 'invoke'> & { schedule?(work: () => void, delay: number): () => void }) {
  const sessions = new Map<string, FeedbackSession>()
  const observations = new Map<string, Observation>()
  const controls = new Set<AbortController>()
  let disposed = false
  const schedule = dependencies.schedule ?? ((work, delay) => { const timer = setTimeout(work, delay); return () => clearTimeout(timer) })
  const key = (sessionId: string, runId?: string) => JSON.stringify([sessionId, runId ?? null])
  function session(sessionId: string) {
    let value = sessions.get(sessionId)
    if (!value) {
      const listeners = new Set<() => void>()
      const created: FeedbackSession = {
        snapshot: { runs: {} }, listeners, dockObservers: 0,
        source: {
          getSnapshot: () => created.snapshot,
          subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        },
        dockSource: {
          getSnapshot: () => created.snapshot,
          subscribe(listener: () => void) {
            listeners.add(listener); created.dockObservers++
            const close = watch(sessionId)
            syncSelection(sessionId)
            return () => {
              listeners.delete(listener); close()
              if (--created.dockObservers === 0) { created.selectedStop?.(); delete created.selectedStop }
            }
          },
        },
      }
      value = created; sessions.set(sessionId, created)
    }
    return value
  }
  function syncSelection(sessionId: string) {
    const value = session(sessionId), items = value.snapshot.tasks?.items ?? []
    const runId = items.find(task => task.runId === value.preferredRunId)?.runId ?? items[0]?.runId
    if (value.snapshot.selectedRunId !== runId) {
      value.selectedStop?.(); delete value.selectedStop
      const next = { ...value.snapshot }
      if (runId) next.selectedRunId = runId
      else delete next.selectedRunId
      value.snapshot = next
      for (const listener of value.listeners) listener()
    }
    if (runId && value.dockObservers && !value.selectedStop) value.selectedStop = watch(sessionId, runId)
  }
  function publishRun(sessionId: string, runId: string, patch: ConversationFeedbackEntry) {
    const value = session(sessionId)
    const prior = value.snapshot.runs[runId]?.run
    if (prior?.revision !== undefined && patch.run?.revision !== undefined && prior.revision > patch.run.revision) return false
    value.snapshot = { ...value.snapshot, runs: { ...value.snapshot.runs, [runId]: patch } }
    for (const listener of value.listeners) listener()
    return true
  }
  function publishTasks(sessionId: string, tasks: ConversationTaskList) {
    const value = session(sessionId)
    const previousLaunch = value.snapshot.tasks?.launch
    if (previousLaunch?.status === 'stopped' && tasks.launch?.id === previousLaunch.id && tasks.launch.status !== 'stopped') tasks = { ...tasks, launch: previousLaunch }
    tasks = { ...tasks, items: tasks.items.map(item => {
      const prior = value.snapshot.tasks?.items.find(old => old.runId === item.runId)
      return prior?.revision !== undefined && item.revision !== undefined && prior.revision > item.revision ? prior : item
    }) }
    value.snapshot = { ...value.snapshot, tasks }
    for (const listener of value.listeners) listener()
  }
  function cancel(item: Observation) { ++item.generation; item.controller?.abort(); delete item.controller; item.cancelTimer?.(); delete item.cancelTimer }
  async function read(item: Observation, append = false): Promise<void> {
    if (disposed || !item.observers || item.controller) return
    item.cancelTimer?.(); delete item.cancelTimer
    const controller = new AbortController(), generation = item.generation
    item.controller = controller
    const current = () => !disposed && !controller.signal.aborted && item.observers > 0 && item.generation === generation
    const runId = item.runId
    if (runId) {
      if (!session(item.sessionId).snapshot.runs[runId]?.run) publishRun(item.sessionId, runId, { freshness: 'loading' })
    } else if (!session(item.sessionId).snapshot.tasks) publishTasks(item.sessionId, { items: [], freshness: 'loading' })
    let again = false, restartWindow = false
    try {
      if (!item.grant || item.grant.expiresAt <= Date.now()) {
        const grant = grantSchema.parse(await dependencies.invoke('session-open', { sessionId: item.sessionId }, controller.signal))
        if (!current()) return
        item.grant = grant; item.interval = grant.pollIntervalMs
      }
      if (runId) {
        // A renewed grant cannot extend a window containing URLs signed by the previous grant.
        const previous = append && item.resultGrant === item.grant.sessionToken ? session(item.sessionId).snapshot.runs[runId]?.run : undefined
        const results: ConversationRun['results'] = previous ? [...previous.results] : [], seen = new Set(results.map(image => image.imageVersionId))
        let run: ConversationRun, pageToken = previous?.pageToken
        do {
          const before = results.length
          run = conversationRunSchema.parse(await dependencies.invoke('run-get', { sessionId: item.sessionId, sessionToken: item.grant.sessionToken, runId, resultFilter: item.resultFilter, pageSize: Math.min(100, item.resultLimit - results.length), ...(pageToken ? { pageToken } : {}) }, controller.signal))
          if (!current()) return
          if (run.runId !== runId || run.owner.sessionId !== item.sessionId) throw Object.assign(new Error('The task belongs to another Session.'), { code: 'owner-denied' })
          if (run.resultFilter && run.resultFilter !== item.resultFilter) throw new Error('task-filter-mismatch')
          for (const image of run.results) if (!seen.has(image.imageVersionId)) { seen.add(image.imageVersionId); results.push(image) }
          if (run.pageToken && (run.pageToken === pageToken || results.length === before)) throw new Error('task-page-not-advancing')
          pageToken = run.pageToken
        } while (pageToken && results.length < item.resultLimit)
        if (publishRun(item.sessionId, runId, { run: { ...run, results }, resultFilter: item.resultFilter, freshness: 'current' })) item.resultGrant = item.grant.sessionToken
        again = ['created', 'running', 'pausing', 'cancelling'].includes(run.status)
      } else {
        const list = taskListSchema.parse(await dependencies.invoke('conversation-runs', { sessionId: item.sessionId, sessionToken: item.grant.sessionToken }, controller.signal))
        if (!current()) return
        if (list.sessionId !== item.sessionId) throw Object.assign(new Error('The task list belongs to another Session.'), { code: 'owner-denied' })
        if (list.launch && list.launch.sessionId !== item.sessionId) throw Object.assign(new Error('The launch belongs to another Session.'), { code: 'owner-denied' })
        publishTasks(item.sessionId, { items: [...new Map(list.tasks.map(task => [task.runId, task])).values()], ...(list.launch ? { launch: list.launch } : {}), freshness: 'current' })
        syncSelection(item.sessionId)
        const selectedId = session(item.sessionId).snapshot.selectedRunId
        const saved = selectedId ? session(item.sessionId).snapshot.runs[selectedId]?.run : undefined
        const selectedObservation = selectedId ? observations.get(key(item.sessionId, selectedId)) : undefined
        // 暂停或终态任务仍可能由工作台恢复，轻量目录更新后重新读取所选任务。
        if (saved && selectedObservation && list.tasks.some(task => task.runId === selectedId && task.status !== saved.status)) void read(selectedObservation)
        again = true
      }
    } catch (error) {
      if (!current()) return
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'read-failed'
      // Newly saved results can invalidate an earlier continuation without invalidating the Session grant.
      if (append && code === 'invalid-input') { restartWindow = true; return }
      const errorCode = code === 'owner-denied' ? code : 'read-failed'
      if (runId) {
        const saved = session(item.sessionId).snapshot.runs[runId]?.run
        publishRun(item.sessionId, runId, { ...(saved ? { run: saved } : {}), resultFilter: item.resultFilter, freshness: 'stale', error: errorCode })
      } else publishTasks(item.sessionId, { ...session(item.sessionId).snapshot.tasks, items: session(item.sessionId).snapshot.tasks?.items ?? [], freshness: 'stale', error: errorCode })
      delete item.grant
      again = code !== 'owner-denied'
    } finally {
      if (current()) {
        delete item.controller
        if (restartWindow) void read(item)
        else if (again && item.interval) item.cancelTimer = schedule(() => { delete item.cancelTimer; void read(item) }, item.interval)
      }
    }
  }
  function watch(sessionId: string, runId?: string) {
      if (disposed) return () => {}
      const id = key(sessionId, runId)
      let item = observations.get(id)
      if (!item) { item = { sessionId, ...(runId ? { runId } : {}), observers: 0, generation: 0, resultFilter: 'all', resultLimit: 4 }; observations.set(id, item) }
      item.observers++
      if (item.observers === 1) void read(item)
      const active = item
      let closed = false
      return () => { if (closed) return; closed = true; if (--active.observers === 0) { cancel(active); delete active.grant } }
  }
  return {
    source(sessionId: string) { return session(sessionId).source },
    sessionSource(sessionId: string) { return session(sessionId).dockSource },
    select(sessionId: string, runId: string) {
      const value = session(sessionId)
      if (!value.snapshot.tasks?.items.some(task => task.runId === runId)) return
      value.preferredRunId = runId; syncSelection(sessionId)
    },
    filterResults(sessionId: string, runId: string, resultFilter: RunResultFilter) {
      const item = observations.get(key(sessionId, runId)), previous = session(sessionId).snapshot.runs[runId]
      if (!item?.observers || item.resultFilter === resultFilter || disposed) return
      cancel(item); item.resultFilter = resultFilter; item.resultLimit = 4
      const run = previous?.run ? { ...previous.run, results: [] } : undefined
      if (run) delete run.pageToken
      publishRun(sessionId, runId, { ...(run ? { run } : {}), resultFilter, freshness: 'loading' })
      void read(item)
    },
    loadMore(sessionId: string, runId: string) {
      const item = observations.get(key(sessionId, runId)), previous = session(sessionId).snapshot.runs[runId]
      if (!item?.observers || !previous?.run?.pageToken || previous.loadingMore || disposed) return
      cancel(item); item.resultLimit = previous.run.results.length + 20
      publishRun(sessionId, runId, { ...previous, loadingMore: true })
      void read(item, true)
    },
    watch,
    watchSession(sessionId: string) { return watch(sessionId) },
    async stopLaunch(sessionId: string, launchId: string): Promise<void> {
      const tasks = session(sessionId).snapshot.tasks, launch = tasks?.launch
      if (!launch || launch.id !== launchId || launch.sessionId !== sessionId || disposed) throw new Error('launch-not-available')
      const controller = new AbortController(); controls.add(controller)
      try {
        const grant = grantSchema.parse(await dependencies.invoke('session-open', { sessionId }, controller.signal))
        const stopped = searchLaunchViewSchema.parse(await dependencies.invoke('search-launch-stop', { sessionId, sessionToken: grant.sessionToken, id: launchId }, controller.signal))
        if (disposed || controller.signal.aborted) return
        if (stopped.id !== launchId || stopped.sessionId !== sessionId) throw new Error('launch-owner-mismatch')
        const current = session(sessionId).snapshot.tasks
        if (current?.launch?.id === launchId) publishTasks(sessionId, { ...current, launch: stopped, freshness: 'current' })
      } finally { controls.delete(controller) }
    },
    async stop(sessionId: string, runId: string): Promise<void> {
      const run = session(sessionId).snapshot.runs[runId]?.run
      if (!run || run.owner.sessionId !== sessionId || disposed) throw new Error('task-not-available')
      const controller = new AbortController(); controls.add(controller)
      try {
        const grant = grantSchema.parse(await dependencies.invoke('session-open', { sessionId }, controller.signal))
        const args = { sessionId, sessionToken: grant.sessionToken }
        // 停止整个启动会同时封住后续入队；独立 Run 则使用原有控制入口。
        if (run.launchId) await dependencies.invoke('search-launch-stop', { ...args, id: run.launchId }, controller.signal)
        else await dependencies.invoke('run-control', { ...args, runId, command: 'cancel', waitForCompletion: false }, controller.signal)
        const observation = observations.get(key(sessionId, runId)), resultFilter = observation?.resultFilter ?? 'all'
        const stopped = conversationRunSchema.parse(await dependencies.invoke('run-get', { ...args, runId, resultFilter, pageSize: Math.min(100, observation?.resultLimit ?? 4) }, controller.signal))
        if (disposed || controller.signal.aborted) return
        if (stopped.runId !== runId || stopped.owner.sessionId !== sessionId) throw new Error('task-owner-mismatch')
        if (publishRun(sessionId, runId, { run: stopped, resultFilter, freshness: 'current' }) && observation) observation.resultGrant = grant.sessionToken
        const tasks = session(sessionId).snapshot.tasks
        if (tasks) publishTasks(sessionId, { ...tasks, items: tasks.items.map(item => item.runId === runId ? { ...item, status: stopped.status, ...(stopped.revision === undefined ? {} : { revision: stopped.revision }) } : item) })
        if (observation && ['created', 'running', 'pausing', 'cancelling'].includes(stopped.status)) { cancel(observation); void read(observation) }
      } finally { controls.delete(controller) }
    },
    refresh(sessionId: string, runId?: string) { const item = observations.get(key(sessionId, runId)); if (item) { cancel(item); void read(item) } },
    reset() {
      for (const item of observations.values()) {
        cancel(item); delete item.grant
        if (item.runId) {
          const previous = session(item.sessionId).snapshot.runs[item.runId]
          if (previous) publishRun(item.sessionId, item.runId, { ...previous, freshness: 'stale' })
        } else {
          const previous = session(item.sessionId).snapshot.tasks
          if (previous) publishTasks(item.sessionId, { ...previous, freshness: 'stale' })
        }
        if (item.observers) void read(item)
      }
    },
    dispose() { disposed = true; for (const controller of controls) controller.abort(); controls.clear(); for (const item of observations.values()) cancel(item); observations.clear(); sessions.clear() },
  }
}
