/** Client data owner preserves tasks across page mounts and polls only admitted work. */
import { z } from 'zod'
import { actionSchema, analysisRecordSchema, generationRecordSchema, modelsSchema, recordSchema, taskIdSchema, failureSchema, StylePromptError, failureOf, type Action, type AnalysisRecord, type GenerationRecord, type GenerationInput, type Dimension, type Route, type Models, type FailureCode, type TaskId } from '../shared/model.ts'

const historySchema = z.strictObject({ healthy: z.boolean(), limits: z.strictObject({ maxImages: z.number(), maxImageBytes: z.number(), maxUploadBytes: z.number(), pollIntervalMs: z.number() }), tasks: z.array(z.strictObject({ id: taskIdSchema, kind: z.enum(['analysis', 'generation']), status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']), createdAt: z.string(), name: z.string() })) })
export interface WorkspaceState {
  loading: boolean
  busy: boolean
  error: FailureCode | null
  notice: { key: 'copied' | 'copyFailed'; sequence: number } | null
  history: z.infer<typeof historySchema> | null
  models: Models | null
  analysis: AnalysisRecord | null
  generation: GenerationRecord | null
}

/** @param options Profile-relative URL and Fetch. @returns One bounded workbench transport. */
export function createTransport(options: { baseUrl: string; fetch: typeof fetch }) {
  return async (action: Action, signal: AbortSignal): Promise<unknown> => {
    const response = await options.fetch(new URL('api/style-prompt/data', options.baseUrl), { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(actionSchema.parse(action)), signal })
    const body: unknown = await response.json()
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: failureSchema })]).parse(body)
    if (!envelope.ok) throw new StylePromptError(envelope.error.code)
    if (!response.ok) throw new StylePromptError('model-error')
    return envelope.value
  }
}

/** @param invoke Authenticated transport. @returns Observable data and workbench actions; disposal aborts reads, not admitted Host tasks. */
export function createWorkspace(invoke: ReturnType<typeof createTransport>) {
  let state: WorkspaceState = { loading: false, busy: false, error: null, notice: null, history: null, models: null, analysis: null, generation: null }
  let disposed = false, epoch = 0, selection = 0, noticeSequence = 0, timer: ReturnType<typeof setTimeout> | undefined
  const lifetime = new AbortController(), listeners = new Set<() => void>()
  let analysisAttempt: { signature: string; id: TaskId } | undefined, generationAttempt: { signature: string; id: TaskId } | undefined
  const publish = (patch: Partial<WorkspaceState>) => { if (!disposed) { state = { ...state, ...patch }; for (const notify of listeners) notify() } }
  const read = (action: Action) => invoke(action, lifetime.signal)
  const errorCode = (error: unknown) => error instanceof z.ZodError ? 'invalid-output' as const : failureOf(error).code
  function poll(): void {
    clearTimeout(timer)
    if (disposed || state.analysis?.status !== 'running' && state.generation?.status !== 'running') return
    timer = setTimeout(async () => {
      const current = epoch, selected = selection
      try {
        for (const record of [state.analysis, state.generation]) if (record?.status === 'running') {
          const next = recordSchema.parse(await read({ operation: 'get', id: record.id }))
          if (disposed || current !== epoch || selected !== selection) return
          if (next.kind === 'analysis') publish({ analysis: next })
          else publish({ generation: next })
        }
        const history = historySchema.parse(await read({ operation: 'list' }))
        if (!disposed && current === epoch) publish({ history })
      } catch (error) { if (!disposed && current === epoch) publish({ error: errorCode(error) }) }
      finally { if (!disposed) poll() }
    }, state.history?.limits.pollIntervalMs)
  }
  async function run(work: () => Promise<void>): Promise<void> {
    if (disposed || state.busy) return
    publish({ busy: true, error: null })
    try { await work() } catch (error) { if (!disposed) publish({ error: errorCode(error) }) }
    finally { publish({ busy: false }); poll() }
  }
  async function refresh(): Promise<void> {
    const current = epoch
    publish({ loading: !state.history, error: null })
    try {
      const [history, models] = await Promise.all([read({ operation: 'list' }), read({ operation: 'models' })])
      if (disposed || current !== epoch) return
      publish({ history: historySchema.parse(history), models: modelsSchema.parse(models) })
      for (const record of [state.analysis, state.generation]) if (record) {
        const value = recordSchema.parse(await read({ operation: 'get', id: record.id }))
        if (disposed || current !== epoch) return
        if (value.kind === 'analysis') publish({ analysis: value })
        else publish({ generation: value })
      }
    } catch (error) { if (!disposed && current === epoch) publish({ error: errorCode(error) }) }
    finally { if (current === epoch) publish({ loading: false }); poll() }
  }
  async function select(id: TaskId): Promise<void> {
    const current = ++selection
    await run(async () => {
      const record = recordSchema.parse(await read({ operation: 'get', id }))
      const analysis = record.kind === 'analysis' ? record : analysisRecordSchema.parse(await read({ operation: 'get', id: record.input.analysisId }))
      if (current !== selection || disposed) return
      publish({ analysis, generation: record.kind === 'generation' ? record : null })
    })
  }
  async function analyze(files: readonly File[], route: Route, dimensions: Dimension[]): Promise<void> {
    await run(async () => {
      const limits = state.history?.limits
      if (!limits || files.length < 1 || files.length > limits.maxImages || files.some(file => file.size > limits.maxImageBytes) || files.reduce((sum, file) => sum + file.size, 0) > limits.maxUploadBytes) throw new StylePromptError('invalid-input')
      const uploads = await Promise.all(files.map(async file => {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new StylePromptError('invalid-input'))
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.slice(reader.result.indexOf(',') + 1)) : reject(new StylePromptError('invalid-input'))
          reader.readAsDataURL(file)
        })
        return { name: file.name, mediaType: file.type, base64 }
      }))
      const raw = { route, dimensions, files: uploads }, signature = JSON.stringify(raw)
      // 同一页面中的重复提交复用任务ID；响应丢失后显式重试也不会重复计费请求。
      const id = analysisAttempt?.signature === signature ? analysisAttempt.id : taskIdSchema.parse(crypto.randomUUID())
      analysisAttempt = { signature, id }
      const action = actionSchema.parse({ operation: 'analyze', input: { id, ...raw } })
      const analysis = analysisRecordSchema.parse(await read(action))
      analysisAttempt = undefined
      ++selection; publish({ analysis, generation: null })
      publish({ history: historySchema.parse(await read({ operation: 'list' })) })
    })
  }
  async function generate(input: GenerationInput): Promise<void> {
    await run(async () => {
      const signature = JSON.stringify(input)
      const id = generationAttempt?.signature === signature ? generationAttempt.id : taskIdSchema.parse(crypto.randomUUID())
      generationAttempt = { signature, id }
      const generation = generationRecordSchema.parse(await read({ operation: 'generate', id, input }))
      generationAttempt = undefined
      publish({ generation, history: historySchema.parse(await read({ operation: 'list' })) })
    })
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh, select, analyze, generate,
    cancel: (id: TaskId) => run(async () => {
      const record = recordSchema.parse(await read({ operation: 'cancel', id }))
      if (record.kind === 'analysis') publish({ analysis: record })
      else publish({ generation: record })
    }),
    remove: (id: TaskId) => run(async () => {
      await read({ operation: 'delete', id })
      if (state.analysis?.id === id) publish({ analysis: null, generation: null })
      else if (state.generation?.id === id) publish({ generation: null })
      publish({ history: historySchema.parse(await read({ operation: 'list' })) })
    }),
    copy: async (text: string) => { try { await navigator.clipboard.writeText(text); publish({ notice: { key: 'copied', sequence: ++noticeSequence } }) } catch (error) { publish({ notice: { key: 'copyFailed', sequence: ++noticeSequence } }) } },
    clearNotice: () => publish({ notice: null }),
    download: (id: TaskId, format: 'json' | 'markdown') => run(async () => {
      const value = z.object({ name: z.string(), markdown: z.string() }).passthrough().parse(await read({ operation: 'export', id }))
      const { markdown, ...json } = value
      const body = format === 'json' ? JSON.stringify(json, null, 2) + '\n' : markdown
      const url = URL.createObjectURL(new Blob([body], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = `style-prompt-${id}.${format === 'json' ? 'json' : 'md'}`
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
    }),
    dispose() { disposed = true; epoch++; selection++; lifetime.abort(); clearTimeout(timer); listeners.clear() },
  }
}
export type Workspace = ReturnType<typeof createWorkspace>
