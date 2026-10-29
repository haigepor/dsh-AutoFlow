/** Scoped observation of Host-owned launches; closing a dialog never cancels admission. */
import { z } from 'zod'
import { searchLaunchInputSchema, searchLaunchViewSchema, type SearchLaunchView } from '../shared/search-launch.ts'
import type { ClientTransport } from './store.ts'

export type SearchLaunchDraft = z.input<typeof searchLaunchInputSchema>
const optionsSchema = z.object({ workspaces: z.array(z.object({ id: z.string(), title: z.string(), path: z.string() })), usages: z.array(z.object({ usageRevisionId: z.string(), name: z.string(), targetWidth: z.number().positive(), targetHeight: z.number().positive() })).default([]), usagePageToken: z.string().optional(), defaultTargetCount: z.number().int().positive(), maxTargetCount: z.number().int().positive() })
/** Owner-private launch state; unknown acknowledgements preserve the original input and identity. */
export interface SearchLaunchState {
  entries: SearchLaunchView[]; options: z.infer<typeof optionsSchema> | null; optionsLoading: boolean; loading: boolean; error: string
  submission: { input: SearchLaunchDraft; status: 'submitting' | 'unknown' | 'rejected'; error?: string } | null
}

/** @param deps Scoped transport, current collection and public native navigation. @returns Reusable launch observation and commands with lifecycle guards. */
export function createSearchLaunchStore(deps: { invoke: ClientTransport['invoke']; context(): { scope: number; styleId: string; pollMs: number }; openSession(id: string): void }) {
  const initial = (): SearchLaunchState => ({ entries: [], options: null, optionsLoading: false, loading: false, error: '', submission: null })
  let state = initial(), scope = deps.context().scope, styleId = deps.context().styleId, disposed = false, version = 0, epoch = 0, initialized = false
  const listeners = new Set<() => void>(), lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, reading: Promise<void> | undefined, submitting: Promise<SearchLaunchView | undefined> | undefined
  const publish = (patch: Partial<SearchLaunchState>) => { if (disposed) return; state = { ...state, ...patch }; for (const listener of listeners) listener() }
  const current = (captured: number) => !disposed && captured === epoch && scope === deps.context().scope && styleId === deps.context().styleId
  const code = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'connection-unavailable'
  async function refresh() {
    if (reading || !styleId) return reading
    const captured = epoch, request = ++version, requestedStyle = styleId
    publish({ loading: true })
    const work = (async () => {
      try {
        const entries = z.array(searchLaunchViewSchema).parse(await deps.invoke('search-launch-list', { styleId: requestedStyle }, lifetime.signal))
        if (current(captured) && request === version) publish({ entries, loading: false, error: '', submission: state.submission && entries.some(item => item.id === state.submission?.input.operationId) ? null : state.submission })
      } catch (error) { if (current(captured) && request === version) publish({ loading: false, error: code(error) }) }
    })()
    reading = work
    try { await work } finally { if (reading === work) reading = undefined }
  }
  async function loadOptions(more = false) {
    if (state.optionsLoading || more && !state.options?.usagePageToken) return
    const captured = epoch, prior = state.options
    publish({ optionsLoading: true, error: '' })
    try {
      const options = optionsSchema.parse(await deps.invoke('search-launch-options', more && prior?.usagePageToken ? { usagePageToken: prior.usagePageToken } : {}, lifetime.signal))
      if (current(captured)) publish({ options: more && prior ? { ...options, usages: [...new Map([...prior.usages, ...options.usages].map(item => [item.usageRevisionId, item])).values()] } : options, optionsLoading: false })
    } catch (error) { if (current(captured)) publish({ optionsLoading: false, error: code(error) }) }
  }
  async function start(input: SearchLaunchDraft): Promise<SearchLaunchView | undefined> {
    if (submitting) return submitting
    const captured = epoch, parsed = searchLaunchInputSchema.parse(input)
    publish({ submission: { input: parsed, status: 'submitting' }, error: '' })
    const work = (async () => {
      try {
        const value = searchLaunchViewSchema.parse(await deps.invoke('search-launch-start', { ...parsed }, lifetime.signal))
        if (current(captured)) publish({ entries: [value, ...state.entries.filter(item => item.id !== value.id)], submission: null })
        return value
      } catch (error) {
        const failure = code(error), rejected = ['invalid-input', 'configuration-required', 'owner-denied', 'constraint-conflict', 'reference-unavailable', 'capability-unavailable', 'revision-conflict'].includes(failure)
        // 明确的准备拒绝尚未创建会话，可修改字段；断线和存储回执未知必须保留原操作。
        if (current(captured)) publish({ submission: { input: parsed, status: rejected ? 'rejected' : 'unknown', error: failure } })
        return undefined
      }
    })()
    submitting = work
    try { return await work } finally { if (submitting === work) submitting = undefined }
  }
  async function stop(id: string) {
    const captured = epoch
    try {
      const value = searchLaunchViewSchema.parse(await deps.invoke('search-launch-stop', { id }, lifetime.signal))
      if (current(captured)) publish({ entries: state.entries.map(item => item.id === id ? value : item), error: '' })
    } catch (error) { if (current(captured)) publish({ error: code(error) }) }
  }
  function poll() { timer = setTimeout(async () => { timer = undefined; await refresh(); if (!disposed) poll() }, deps.context().pollMs) }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    sync() {
      const next = deps.context()
      if (initialized && next.scope === scope && next.styleId === styleId) return
      initialized = true; scope = next.scope; styleId = next.styleId; ++epoch; ++version; reading = undefined; submitting = undefined; publish(initial()); void refresh()
      if (!timer && !disposed) poll()
    },
    refresh, loadOptions, start, stop,
    async retry(id: string) { const entry = state.entries.find(item => item.id === id); if (entry) return start(entry.input); return undefined },
    openSession(id: string) { try { deps.openSession(id); return true } catch (error) { publish({ error: 'navigation-unavailable' }); return false } },
    dispose() { disposed = true; lifetime.abort(); clearTimeout(timer); listeners.clear() },
  }
}
export type SearchLaunchStore = ReturnType<typeof createSearchLaunchStore>
