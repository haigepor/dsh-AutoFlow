/** Editable drafts, auxiliary runs and historical views have separate profile-local owners. */
import { z } from 'zod'
import { canvasActionSchema, canvasSchema, canvasExportSchema, canvasRunSchema, canvasAssetInventorySchema, assetSchema, canvasId, nodeId, assetId, runId, newNode, starterCanvas, canConnect, nodeFingerprint, type CanvasDocument, type CanvasNode, type CanvasEdge, type NodeKind, type NodeId, type CanvasRun, type CanvasAsset, type CanvasId, type RunId, type CanvasAssetInventory } from '../shared/canvas.ts'
import { actionSchema, recordSchema, taskIdSchema, failureSchema, failureOf, StylePromptError, type TaskRecord, type FailureCode } from '../shared/model.ts'
import { validateImageSelection } from './import.ts'
import { canvasInputIssues, type CanvasIssue } from '../shared/canvas-validation.ts'
import type { TextKey } from './locale.ts'

const modelSchema = z.object({ provider: z.string(), providerName: z.string(), id: z.string(), name: z.string(), vision: z.boolean().optional() })
const modelsSchema = z.object({ models: z.array(modelSchema), textModels: z.array(modelSchema), failures: z.array(z.object({ provider: z.string(), code: failureSchema.shape.code })) })
const listSchema = z.object({ healthy: z.boolean(), documents: z.array(canvasSchema.omit({ nodes: true, edges: true })), activeRuns: z.array(canvasRunSchema), limits: z.object({ saveDelayMs: z.number(), pollIntervalMs: z.number(), maxCanvasFileBytes: z.number() }) })
const historySchema = z.object({ healthy: z.boolean(), limits: z.object({ maxImages: z.number(), maxImageBytes: z.number(), maxUploadBytes: z.number(), pollIntervalMs: z.number() }), tasks: z.array(z.object({ id: taskIdSchema, kind: z.enum(['analysis', 'generation']), status: z.string(), name: z.string(), createdAt: z.string() })) })
const openedSchema = z.object({ document: canvasSchema, assets: z.array(assetSchema), runs: z.array(canvasRunSchema) })
type ClientFailure = FailureCode | 'connection-error' | 'invalid-response'
export type NoticeAction = { kind: 'canvas'; canvasId: CanvasId } | { kind: 'node'; canvasId: CanvasId; nodeId: NodeId }
export interface CanvasState {
  loading: boolean; saving: boolean; dirty: boolean; error: ClientFailure | null; saveError: ClientFailure | null; syncError: ClientFailure | null
  document: CanvasDocument | null; documents: z.infer<typeof listSchema>['documents']; assets: CanvasAsset[]; runs: CanvasRun[]; activeRuns: CanvasRun[]; admitting: CanvasId[]
  records: Record<string, TaskRecord>; models: z.infer<typeof modelsSchema>; history: z.infer<typeof historySchema> | null
  selected: NodeId[]; selectedEdges: string[]; issues: CanvasIssue[]; canUndo: boolean; canRedo: boolean
  inspection: RunId | null; focus: { nodeId: NodeId; issue?: CanvasIssue; sequence: number } | null
  inventory: CanvasAssetInventory | null; uploading: boolean; maxCanvasFileBytes: number | null
  notice: { key: TextKey; sequence: number; success: boolean; values: Record<string, string>; action?: NoticeAction } | null
}
class TransportFailure extends Error {
  constructor(readonly code: 'connection-error' | 'invalid-response') { super(code) }
}
const clientFailure = (error: unknown): ClientFailure => error instanceof TransportFailure ? error.code : error instanceof z.ZodError ? 'invalid-response' : failureOf(error).code

/** @param options Authenticated profile transport. @returns Validated canvas and legacy task request. */
export function createCanvasTransport(options: { baseUrl: string; fetch: typeof fetch }) {
  return async (action: unknown, signal: AbortSignal): Promise<unknown> => {
    const parsed = z.union([canvasActionSchema, actionSchema]).parse(action)
    let response: Response
    try { response = await options.fetch(new URL('api/style-prompt/data', options.baseUrl), { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed), signal }) }
    catch (error) { if (signal.aborted) throw error; throw new TransportFailure('connection-error') }
    let envelope
    try { envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: failureSchema })]).parse(await response.json()) }
    catch (error) { if (signal.aborted) throw error; throw new TransportFailure('invalid-response') }
    if (!envelope.ok) throw new StylePromptError(envelope.error.code)
    if (!response.ok) throw new TransportFailure('invalid-response')
    return envelope.value
  }
}

/** @param invoke Profile transport. @param name Localized document name. @returns Graph edits, persistence and run subscriptions. */
export function createCanvasWorkspace(invoke: ReturnType<typeof createCanvasTransport>, name: string) {
  let state: CanvasState = { loading: true, saving: false, dirty: false, error: null, saveError: null, syncError: null, document: null, documents: [], assets: [], runs: [], activeRuns: [], admitting: [], records: {}, models: { models: [], textModels: [], failures: [] }, history: null, selected: [], selectedEdges: [], issues: [], canUndo: false, canRedo: false, notice: null, inspection: null, focus: null, inventory: null, uploading: false, maxCanvasFileBytes: null }
  let stopped = false, savedRevision = 0, epoch = 0, sequence = 0, polling = false
  let limits: z.infer<typeof listSchema>['limits'] | null = null
  const listeners = new Set<() => void>(), lifetime = new AbortController()
  let undo: CanvasDocument[] = [], redo: CanvasDocument[] = [], saveTimer: ReturnType<typeof setTimeout> | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined
  let saveChain = Promise.resolve(), validationTargets: NodeId[] = [], editGroup: string | null = null
  let gesture: { before: CanvasDocument; recorded: boolean; keyboard: boolean } | null = null
  const attempts = new Map<CanvasId, { id: RunId; document: CanvasDocument; targets: NodeId[]; signature: string }>()
  const admissions = new Set<CanvasId>(), active = new Map<RunId, CanvasRun>(), terminal = new Set<RunId>()
  const publish = (patch: Partial<CanvasState>) => { if (!stopped) { state = { ...state, ...patch }; listeners.forEach(listener => listener()) } }
  const request = (action: unknown) => invoke(action, lifetime.signal)
  function notify(key: TextKey, success = true, values: Record<string, string> = {}, action?: NoticeAction): void {
    publish({ notice: { key, success, values, sequence: ++sequence, ...(action ? { action } : {}) } })
  }
  const guarded = async (work: () => Promise<void>, surface: 'action' | 'state' = 'action'): Promise<boolean> => {
    try { await work(); return true }
    catch (error) {
      if (!stopped) { const code = clientFailure(error); if (surface === 'state') publish({ error: code }); else notify(code === 'connection-error' ? 'canvas.connectionError' : code === 'invalid-response' ? 'canvas.invalidResponse' : `error.${code}`, false) }
      return false
    }
  }
  const flags = () => ({ canUndo: undo.length > 0, canRedo: redo.length > 0 })
  function schedule(): void { if (limits) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void save().catch(error => { /* saveError keeps the failed draft and retry action visible. */ }) }, limits.saveDelayMs) } }
  async function save(): Promise<void> {
    clearTimeout(saveTimer)
    saveChain = saveChain.catch(error => { /* A failed save stays visible until this retry succeeds. */ }).then(async () => {
      if (stopped || !state.document || !state.dirty) return
      const document = state.document; publish({ saving: true })
      try {
        const saved = canvasSchema.parse(await request({ operation: 'canvas/save', document, expectedRevision: savedRevision }))
        if (stopped || state.document?.id !== document.id) return
        savedRevision = saved.revision
        const unchanged = state.document === document, current = unchanged ? saved : { ...state.document, revision: saved.revision, updatedAt: saved.updatedAt }
        const { nodes: _nodes, edges: _edges, ...summary } = saved
        publish({ document: current, dirty: !unchanged, saveError: null, documents: [summary, ...state.documents.filter(item => item.id !== saved.id)] })
        if (!unchanged) schedule()
      } catch (error) { if (state.document?.id === document.id) publish({ saveError: clientFailure(error) }); throw error }
      finally { publish({ saving: false }) }
    })
    return saveChain
  }
  function edit(document: CanvasDocument, record = true, persist = true, group: string | null = null): void {
    if (!state.document || state.inspection) return
    if (record) {
      const previous = state.document
      document = { ...document, nodes: document.nodes.map(node => {
        const before = previous.nodes.find(value => value.id === node.id)
        if ((node.kind === 'analysis' || node.kind === 'prompt') && node.historyTaskId && before && (before.kind === 'analysis' || before.kind === 'prompt') && before.historyTaskId === node.historyTaskId && nodeFingerprint(document, node.id) !== nodeFingerprint(previous, node.id)) return { ...node, historyTaskId: null }
        return node
      }) }
      if (!group || editGroup !== group) { undo.push(previous); redo = [] }
      editGroup = group
    }
    publish({ document, dirty: true, issues: state.issues.length ? canvasInputIssues(document, validationTargets) : [], ...flags() })
    if (persist) schedule()
  }
  function endGesture(): void { if (gesture?.recorded) schedule(); gesture = null; editGroup = null }
  function layout(id: NodeId, patch: { position?: CanvasNode['position']; width?: number; height?: number }): void {
    if (!state.document || state.inspection) return
    const node = state.document.nodes.find(value => value.id === id)
    if (!node || Object.entries(patch).every(([key, value]) => key === 'position' ? node.position.x === patch.position?.x && node.position.y === patch.position?.y : node[key as 'width' | 'height'] === value)) return
    if (!gesture) gesture = { before: state.document, recorded: false, keyboard: true }
    if (!gesture.recorded) { undo.push(gesture.before); redo = []; gesture.recorded = true }
    edit({ ...state.document, nodes: state.document.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }, false, gesture.keyboard)
  }
  function remember(run: CanvasRun): boolean {
    if (terminal.has(run.id)) return false
    if (run.status === 'running') active.set(run.id, run)
    else { active.delete(run.id); terminal.add(run.id) }
    const current = state.document?.id === run.canvasId
    publish({ activeRuns: [...active.values()], ...(current ? { runs: [run, ...state.runs.filter(value => value.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) } : {}) })
    return true
  }
  async function loadRecords(): Promise<void> {
    const runs = state.runs, document = state.document
    const ids = new Set(runs.flatMap(run => run.nodes.flatMap(node => {
      const kind = run.document.nodes.find(value => value.id === node.nodeId)?.kind
      return [...(node.analysisId ? [node.analysisId] : []), ...(node.taskId && (kind === 'analysis' || kind === 'prompt' || kind === 'output') ? [node.taskId] : [])]
    })))
    document?.nodes.forEach(node => { if ((node.kind === 'analysis' || node.kind === 'prompt') && node.historyTaskId) ids.add(node.historyTaskId) })
    const fetched = await Promise.all([...ids].filter(id => !state.records[id] || state.records[id]?.status === 'running').map(async id => recordSchema.parse(await request({ operation: 'get', id }))))
    if (stopped) return
    const records = { ...state.records }
    for (const record of fetched) if (!records[record.id] || records[record.id]?.status === 'running') records[record.id] = record
    publish({ records })
  }
  function completion(run: CanvasRun): void {
    const failed = run.nodes.find(node => node.status === 'failed' || node.status === 'blocked')
    const node = run.document.nodes.find(node => node.id === (failed?.nodeId ?? run.targets[0]))
    const values = { canvas: run.document.name, node: node?.title || String(run.document.nodes.findIndex(value => value.id === node?.id) + 1) }
    notify(run.status === 'succeeded' ? 'canvas.notice.completedContext' : run.status === 'cancelled' ? 'canvas.notice.stoppedContext' : 'canvas.notice.failedContext', run.status === 'succeeded', values, node ? { kind: 'node', canvasId: run.canvasId, nodeId: node.id } : { kind: 'canvas', canvasId: run.canvasId })
  }
  async function pollNow(): Promise<void> {
    if (polling || stopped || !active.size) return
    polling = true
    try {
      const results = await Promise.allSettled([...active.keys()].map(async id => canvasRunSchema.parse(await request({ operation: 'canvas/run-get', id }))))
      if (stopped) return
      let error: ClientFailure | null = null
      for (const result of results) {
        if (result.status === 'rejected') { error = clientFailure(result.reason); continue }
        const run = result.value
        if (remember(run) && run.status !== 'running') completion(run)
      }
      publish({ syncError: error })
      await loadRecords()
      publish({ history: historySchema.parse(await request({ operation: 'list' })) })
    } catch (error) { if (!stopped) publish({ syncError: clientFailure(error) }) }
    finally { polling = false; poll() }
  }
  function poll(): void {
    clearTimeout(pollTimer)
    if (!stopped && limits && active.size && !polling) pollTimer = setTimeout(() => { void pollNow() }, limits.pollIntervalMs)
  }
  async function open(id: CanvasId, replaceDraft = false): Promise<void> {
    endGesture()
    if (!replaceDraft) await save()
    const current = ++epoch, opened = openedSchema.parse(await request({ operation: 'canvas/get', id }))
    if (stopped || current !== epoch) return
    savedRevision = opened.document.revision; undo = []; redo = []; editGroup = null
    for (const run of opened.runs) { if (run.status === 'running' && !terminal.has(run.id)) active.set(run.id, run); else if (run.status !== 'running') terminal.add(run.id) }
    publish({ ...opened, activeRuns: [...active.values()], inspection: null, focus: null, selected: [], selectedEdges: [], issues: [], dirty: false, error: null, saveError: null, ...flags() })
    await loadRecords(); poll()
  }
  async function updateDirectory(): Promise<void> {
    const list = listSchema.parse(await request({ operation: 'canvas/list' })); limits = list.limits
    for (const run of list.activeRuns) if (!terminal.has(run.id)) active.set(run.id, run)
    publish({ documents: list.documents, maxCanvasFileBytes: limits.maxCanvasFileBytes, activeRuns: [...active.values()] })
    poll()
  }
  async function create(): Promise<void> {
    await save(); const document = starterCanvas(canvasId.parse(crypto.randomUUID())); document.name = name
    const saved = canvasSchema.parse(await request({ operation: 'canvas/save', document, expectedRevision: 0 }))
    await open(saved.id); await updateDirectory(); notify('canvas.notice.created')
  }
  async function refresh(): Promise<void> {
    await guarded(async () => {
      await updateDirectory()
      const [history, models] = await Promise.all([request({ operation: 'list' }), request({ operation: 'canvas/models' })])
      const parsed = historySchema.parse(history)
      publish({ history: parsed, models: modelsSchema.parse(models), error: parsed.healthy ? null : 'storage-error' })
      if (!state.document) { if (state.documents[0]) await open(state.documents[0].id); else await create() }
      else { await loadRecords(); poll() }
    }, 'state')
    publish({ loading: false })
  }
  function locate(id: NodeId, issue?: CanvasIssue): void { publish({ inspection: null, selected: [id], selectedEdges: [], focus: { nodeId: id, sequence: ++sequence, ...(issue ? { issue } : {}) } }) }
  async function run(targets: NodeId[]): Promise<void> {
    if (!state.document || !targets.length) return
    const document = structuredClone(state.document), owner = document.id
    publish({ inspection: null })
    if (targets.some(id => !document.nodes.some(node => node.id === id))) { notify('canvas.notice.nodeMissing', false); return }
    if (admissions.has(owner) || [...active.values()].some(run => run.canvasId === owner && run.targets.some(id => targets.includes(id)))) { notify('canvas.notice.alreadyRunning', false); return }
    validationTargets = targets
    const issues = canvasInputIssues(document, targets)
    if (issues.length) { publish({ issues }); locate(issues[0]!.nodeId, issues[0]); return }
    admissions.add(owner); publish({ admitting: [...admissions] })
    try {
      await save()
      const signature = JSON.stringify({ targets, inputs: targets.map(id => nodeFingerprint(document, id)) })
      let attempt = attempts.get(owner)
      if (!attempt || attempt.signature !== signature) { attempt = { id: runId.parse(crypto.randomUUID()), document, targets, signature }; attempts.set(owner, attempt) }
      const accepted = canvasRunSchema.parse(await request({ operation: 'canvas/run', id: attempt.id, document: attempt.document, targets: attempt.targets }))
      attempts.delete(owner)
      if (remember(accepted) && accepted.status !== 'running') { completion(accepted); await loadRecords() }
      poll()
    } finally { admissions.delete(owner); publish({ admitting: [...admissions] }) }
  }
  function changeNode(id: NodeId, update: (node: CanvasNode) => CanvasNode, field?: string): void {
    const document = state.document, previous = document?.nodes.find(node => node.id === id)
    if (document && previous) edit({ ...document, nodes: document.nodes.map(node => node.id === id ? update(previous) : node) }, true, true, field ? `node:${id}:${field}` : null)
  }
  function download(body: string, filename: string, type: string): void {
    const url = URL.createObjectURL(new Blob([body], { type })), link = document.createElement('a')
    link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  function exportCanvas(): void {
    const document = state.inspection ? state.runs.find(run => run.id === state.inspection)?.document : state.document
    if (!document || !limits) return
    const ids = new Set(document.nodes.flatMap(node => node.kind === 'reference' ? node.assetIds : []))
    const bundle = { formatVersion: 1, exportType: 'style-prompt-canvas', document, assets: state.assets.filter(asset => ids.has(asset.id)).map(asset => ({ id: asset.id, name: asset.reference.name, sha256: asset.reference.sha256 })) }
    const body = JSON.stringify(bundle, null, 2) + '\n'
    if (new Blob([body]).size > limits.maxCanvasFileBytes) { notify('canvas.notice.fileTooLarge', false, { limit: String(limits.maxCanvasFileBytes / 1024 ** 2) }); return }
    download(body, 'style-canvas.json', 'application/json'); notify('canvas.notice.exported')
  }
  async function copyDocument(document: CanvasDocument): Promise<void> {
    clearTimeout(saveTimer); await saveChain.catch(error => { /* Saving a copy is the recovery path for the retained draft. */ })
    const saved = canvasSchema.parse(await request({ operation: 'canvas/save', document: { ...document, id: canvasId.parse(crypto.randomUUID()), revision: 0 }, expectedRevision: 0 }))
    await open(saved.id, true); await updateDirectory(); notify('canvas.notice.savedAs')
  }
  return {
    getSnapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }, refresh, notify, locate,
    save: () => guarded(save), open: (id: CanvasId) => guarded(() => open(id)), create: () => guarded(create),
    saveAs: () => guarded(async () => { if (state.document) await copyDocument(state.document) }),
    copySnapshot: () => guarded(async () => { const run = state.runs.find(run => run.id === state.inspection); if (run) { await save(); await copyDocument(run.document) } }),
    inspect(id: RunId | null) { endGesture(); publish({ inspection: id, focus: null, selected: id ? state.runs.find(run => run.id === id)?.targets ?? [] : [], selectedEdges: [] }) },
    reloadSaved: () => guarded(async () => { if (state.document) { clearTimeout(saveTimer); await saveChain.catch(error => { /* The user explicitly chose the saved version. */ }); await open(state.document.id, true) } }),
    deleteCanvas: () => guarded(async () => {
      if (!state.document) return
      await save(); const id = state.document.id
      await request({ operation: 'canvas/delete', id })
      if (state.document?.id !== id) { await updateDirectory(); return }
      savedRevision = 0; publish({ document: null, dirty: false, inspection: null, runs: [], assets: [], selected: [], selectedEdges: [], issues: [] })
      await updateDirectory(); if (state.documents[0]) await open(state.documents[0].id); else await create()
      notify('canvas.notice.canvasDeleted')
    }),
    deleteRun: (id: RunId) => guarded(async () => { await request({ operation: 'canvas/run-delete', id }); publish({ runs: state.runs.filter(run => run.id !== id), ...(state.inspection === id ? { inspection: null } : {}) }); notify('canvas.notice.runDeleted') }),
    deleteTask: async (id: TaskRecord['id']) => {
      let referenced = false
      const done = await guarded(async () => {
        try { await request({ operation: 'delete', id }) }
        catch (error) { if (error instanceof StylePromptError && error.code === 'operation-conflict') { referenced = true; notify('canvas.notice.taskReferenced', false); return }; throw error }
        publish({ history: historySchema.parse(await request({ operation: 'list' })) }); notify('canvas.notice.taskDeleted')
      })
      return done && !referenced
    },
    select: (selected: NodeId[]) => publish({ selected }), selectEdges: (selectedEdges: string[]) => publish({ selectedEdges }), changeNode,
    endEdit() { editGroup = null }, endKeyboardMove() { if (gesture?.keyboard) endGesture() },
    rename(value: string) { if (state.document && value.trim()) edit({ ...state.document, name: value.slice(0, 100) }, true, true, 'document-name') },
    add(kind: NodeKind, position: CanvasNode['position']) { if (!state.document || state.inspection) return; const node = newNode(kind, nodeId.parse(crypto.randomUUID()), position); edit({ ...state.document, nodes: [...state.document.nodes, node] }); publish({ selected: [node.id], selectedEdges: [] }); return node.id },
    move(id: NodeId, position: CanvasNode['position']) { layout(id, { position }) },
    resize(id: NodeId, size: { width: number; height: number }) { layout(id, { width: Math.round(size.width), height: Math.round(size.height) }) },
    beginMove() { if (state.document && !state.inspection) { endGesture(); gesture = { before: state.document, recorded: false, keyboard: false } } }, endMove: endGesture,
    viewport(viewport: CanvasDocument['viewport'], owner = state.document?.id) { if (state.document && state.document.id === owner && !state.inspection) { publish({ document: { ...state.document, viewport }, dirty: true }); schedule() } },
    isLive(id: CanvasId) { return state.document?.id === id && state.inspection === null },
    connect(edge: Omit<CanvasEdge, 'id'>) { if (!state.document || state.inspection) return; if (!canConnect(state.document, edge)) { notify('canvas.notice.invalidConnection', false); return }; edit({ ...state.document, edges: [...state.document.edges, { ...edge, id: crypto.randomUUID() }] }) },
    reconnect(id: string, edge: Omit<CanvasEdge, 'id'>) { if (!state.document || state.inspection) return; const remaining = { ...state.document, edges: state.document.edges.filter(value => value.id !== id) }; if (!canConnect(remaining, edge)) { notify('canvas.notice.invalidConnection', false); return }; edit({ ...remaining, edges: [...remaining.edges, { ...edge, id }] }) },
    removeEdges(ids: string[]) { if (state.document) edit({ ...state.document, edges: state.document.edges.filter(edge => !ids.includes(edge.id)) }) },
    removeSelected() {
      if (!state.document || state.inspection || !state.selected.length && !state.selectedEdges.length) return
      if ([...active.values()].some(run => run.canvasId === state.document?.id && run.nodes.some(node => state.selected.includes(node.nodeId) && (node.status === 'queued' || node.status === 'running')))) { notify('canvas.notice.stopBeforeRemove', false); return }
      edit({ ...state.document, nodes: state.document.nodes.filter(node => !state.selected.includes(node.id)), edges: state.document.edges.filter(edge => !state.selected.includes(edge.source) && !state.selected.includes(edge.target) && !state.selectedEdges.includes(edge.id)) })
      publish({ selected: [], selectedEdges: [] }); notify('canvas.notice.removed')
    },
    duplicate(offset = { x: 50, y: 70 }) {
      if (!state.document || state.inspection || !state.selected.length) return
      const ids = new Map(state.selected.map(id => [id, nodeId.parse(crypto.randomUUID())]))
      const nodes = state.document.nodes.filter(node => ids.has(node.id)).map(node => ({ ...structuredClone(node), id: ids.get(node.id)!, position: { x: node.position.x + offset.x, y: node.position.y + offset.y } }))
      const edges = state.document.edges.filter(edge => ids.has(edge.target)).map(edge => ({ ...edge, id: crypto.randomUUID(), source: ids.get(edge.source) ?? edge.source, target: ids.get(edge.target)! }))
      edit({ ...state.document, nodes: [...state.document.nodes, ...nodes], edges: [...state.document.edges, ...edges] }); publish({ selected: nodes.map(node => node.id), selectedEdges: [] }); notify('canvas.notice.duplicated')
    },
    undo() { if (state.inspection) return; endGesture(); const document = undo.pop(); if (document && state.document) { redo.push(state.document); edit(document, false); publish(flags()) } },
    redo() { if (state.inspection) return; endGesture(); const document = redo.pop(); if (document && state.document) { undo.push(state.document); edit(document, false); publish(flags()) } },
    run: (targets: NodeId[], owner = state.document?.id) => guarded(async () => { if (state.document?.id === owner) await run(targets) }),
    runAll: () => guarded(async () => { if (state.document) await run(state.document.nodes.filter(node => !state.document!.edges.some(edge => edge.source === node.id)).map(node => node.id)) }),
    refreshRuns: pollNow,
    cancel: (id: RunId) => guarded(async () => { const next = canvasRunSchema.parse(await request({ operation: 'canvas/cancel', id })); if (remember(next)) completion(next); poll() }),
    importHistory: (id: TaskRecord['id']) => guarded(async () => { await save(); const saved = canvasSchema.parse(await request({ operation: 'canvas/import-history', id, canvasId: canvasId.parse(crypto.randomUUID()) })); await open(saved.id); await updateDirectory(); notify('canvas.notice.historyImported') }),
    upload: (files: File[], at: CanvasNode['position'], target?: NodeId) => guarded(async () => {
      if (!state.document || !state.history || state.inspection || state.uploading) return
      const issue = validateImageSelection(files, state.history.limits)
      if (issue) { notify(`importError.${issue}`, false); return }
      const existing = state.document.nodes.find(node => node.id === target)
      if (existing?.kind === 'reference' && existing.assetIds.length + files.length > state.history.limits.maxImages) { notify('importError.count', false); return }
      const current = state.document.id; publish({ uploading: true })
      try {
        const inputs = await Promise.all(files.map(async file => ({ id: assetId.parse(crypto.randomUUID()), name: file.name, mediaType: file.type, base64: await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new StylePromptError('invalid-input')); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.slice(reader.result.indexOf(',') + 1)) : reject(new StylePromptError('invalid-input')); reader.readAsDataURL(file) }) })))
        const result = z.object({ assets: z.array(assetSchema) }).parse(await request({ operation: 'canvas/upload', assets: inputs }))
        if (state.document?.id !== current) { notify('canvas.notice.importOtherCanvas', false); return }
        publish({ assets: [...state.assets, ...result.assets] })
        const reference = state.document.nodes.find(node => node.id === target && node.kind === 'reference')
        if (reference?.kind === 'reference') changeNode(reference.id, node => node.kind === 'reference' ? { ...node, assetIds: [...node.assetIds, ...result.assets.map(asset => asset.id)] } : node)
        else { const node = { ...newNode('reference', nodeId.parse(crypto.randomUUID()), at), kind: 'reference' as const, assetIds: result.assets.map(asset => asset.id) }; edit({ ...state.document, nodes: [...state.document.nodes, node] }); publish({ selected: [node.id] }) }
        notify('canvas.notice.imagesImported')
      } finally { publish({ uploading: false }) }
    }),
    exportCanvas,
    importCanvas: (file: File) => guarded(async () => {
      if (!limits) return
      if (file.size > limits.maxCanvasFileBytes) { notify('canvas.notice.fileTooLarge', false, { limit: String(limits.maxCanvasFileBytes / 1024 ** 2) }); return }
      let bundle: z.infer<typeof canvasExportSchema>
      try { bundle = canvasExportSchema.parse(JSON.parse(await file.text())) } catch (error) { notify('canvas.notice.invalidFile', false); return }
      await save()
      try { const saved = canvasSchema.parse(await request({ operation: 'canvas/import', bundle, canvasId: canvasId.parse(crypto.randomUUID()) })); await open(saved.id) }
      catch (error) { if (error instanceof StylePromptError && error.code === 'missing-record') { notify('canvas.notice.missingAssets', false); return }; throw error }
      await updateDirectory(); notify('canvas.notice.imported')
    }),
    loadInventory: () => guarded(async () => { await save(); publish({ inventory: canvasAssetInventorySchema.parse(await request({ operation: 'canvas/assets' })) }) }),
    pruneAssets: (ids: CanvasAsset['id'][]) => guarded(async () => {
      if (state.uploading) return
      await save()
      const keep = state.document?.nodes.flatMap(node => node.kind === 'reference' ? node.assetIds : []) ?? []
      const result = z.object({ removed: z.number(), inventory: canvasAssetInventorySchema }).parse(await request({ operation: 'canvas/assets-prune', ids, keep }))
      publish({ inventory: result.inventory }); notify('canvas.notice.assetsPruned', true, { count: String(result.removed) })
    }),
    noticeAction: (action: NoticeAction) => guarded(async () => { if (state.document?.id !== action.canvasId) await open(action.canvasId); if (action.kind === 'node') locate(action.nodeId); else publish({ inspection: null }); publish({ notice: null }) }),
    copy: async (text: string) => { try { await navigator.clipboard.writeText(text); notify('copied') } catch (error) { notify('copyFailed', false) } }, clearNotice: () => publish({ notice: null }),
    download: (id: TaskRecord['id'], format: 'json' | 'markdown') => guarded(async () => { const value = z.object({ name: z.string(), markdown: z.string() }).passthrough().parse(await request({ operation: 'export', id })); const { markdown, ...json } = value; download(format === 'json' ? JSON.stringify(json, null, 2) + '\n' : markdown, `style-prompt-${id}.${format === 'json' ? 'json' : 'md'}`, format === 'json' ? 'application/json' : 'text/markdown') }),
    dispose() { stopped = true; ++epoch; lifetime.abort(); clearTimeout(saveTimer); clearTimeout(pollTimer); listeners.clear() },
  }
}
export type CanvasWorkspace = ReturnType<typeof createCanvasWorkspace>
