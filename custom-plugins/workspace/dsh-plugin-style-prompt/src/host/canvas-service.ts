/** Host-owned graph execution freezes inputs, reuses unchanged ancestors and isolates branch failures. */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmRuntime, ImageGenerationId } from '@deepseek-ai/dsh-llm'
import { canvasSchema, assetId, assetSchema, starterCanvas, executionOrder, nodeFingerprint, validateCanvas, type CanvasAction, type CanvasDocument, type CanvasNode, type CanvasRun, type NodeExecution, type RunId, type NodeId, type CanvasId, type AssetId } from '../shared/canvas.ts'
import { referenceSchema, taskIdSchema, StylePromptError, failureOf, type Reference, type TaskId } from '../shared/model.ts'
import { nativeRef, type ModelDependencies } from './native-model.ts'
import type { StylePromptService } from './service.ts'
import type { Repository } from './repository.ts'
import type { CanvasRepository } from './canvas-repository.ts'
import type { Config } from './config.ts'
import { canvasInputIssues } from '../shared/canvas-validation.ts'

type Dependencies = ModelDependencies & { llm: ModelDependencies['llm'] & Pick<LlmRuntime, 'listImageModels' | 'generateImages'> }
const now = () => new Date().toISOString()

export class CanvasService {
  private readonly lifetime = new AbortController()
  private readonly active = new Map<RunId, { abort: AbortController; promise: Promise<void> }>()
  private writes = Promise.resolve()
  private healthy = true
  private disposed = false

  constructor(private readonly repository: CanvasRepository, private readonly legacy: StylePromptService, private readonly tasks: Repository, private readonly dependencies: Dependencies, private readonly config: Config, private readonly report: () => void) {}

  /** Recover visibly without automatically resending model requests. */
  async initialize(): Promise<void> {
    for (const run of this.repository.runs()) if (run.status === 'running') await this.repository.saveRun({ ...run, status: 'interrupted', updatedAt: now(), nodes: run.nodes.map(node => node.status === 'running' || node.status === 'queued' ? { ...node, status: 'interrupted', failure: { code: 'interrupted' } } : node), failure: { code: 'interrupted' } })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work)
    this.writes = next.then(() => {}, () => {})
    return next
  }

  private ready(): void {
    if (this.disposed) throw new StylePromptError('not-ready')
    if (!this.healthy) throw new StylePromptError('storage-error')
  }

  private requireRun(id: RunId): CanvasRun {
    const run = this.repository.run(id)
    if (!run) throw new StylePromptError('missing-record')
    return run
  }

  /** @param id Legacy record identity. @returns Whether a canvas or retained execution still owns this task. */
  referencesTask(id: TaskId): boolean {
    return this.repository.documents().some(document => document.nodes.some(node => (node.kind === 'analysis' || node.kind === 'prompt') && node.historyTaskId === id))
      || this.repository.runs().some(run => run.nodes.some(node => node.taskId === id || node.analysisId === id))
  }

  /** @param action Parsed authenticated operation. @param signal Admission or read lifetime. @returns Saved canvas data or one admitted run. */
  async action(action: CanvasAction, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    switch (action.operation) {
      case 'canvas/list': return { healthy: this.healthy, limits: { saveDelayMs: this.config.canvasSaveDelayMs, pollIntervalMs: this.config.pollIntervalMs, maxCanvasFileBytes: this.config.maxCanvasFileBytes }, activeRuns: this.repository.runs().filter(run => run.status === 'running'), documents: this.repository.documents().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ nodes: _nodes, edges: _edges, ...document }) => document) }
      case 'canvas/get': {
        const document = this.repository.document(action.id)
        if (!document) throw new StylePromptError('missing-record')
        const runs = this.repository.runs().filter(run => run.canvasId === action.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, this.config.maxHistoryItems)
        const ids = new Set([document, ...runs.map(run => run.document)].flatMap(document => document.nodes.flatMap(node => node.kind === 'reference' ? node.assetIds : [])))
        return { document, assets: this.repository.assets().filter(asset => ids.has(asset.id)), runs }
      }
      case 'canvas/models': {
        const failures: { provider: string; code: ReturnType<typeof failureOf>['code'] }[] = []
        const models = await Promise.all(this.dependencies.llm.listProviders().map(async provider => {
          try {
            if (typeof this.dependencies.llm.listImageModels !== 'function') throw new StylePromptError('capability-unavailable')
            return (await this.dependencies.llm.listImageModels(provider.id)).map(model => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name }))
          }
          catch (error) { if (signal.aborted) throw error; failures.push({ provider: provider.name, code: failureOf(error).code }); return [] }
        }))
        const textModels = await Promise.all(this.dependencies.llm.listProviders().map(async provider => {
          try {
            return await Promise.all((await this.dependencies.llm.listModels(provider.id)).map(async model => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name, vision: (await this.dependencies.llm.resolveModelInfo(provider.id, model.id, signal)).inputModalities?.includes('image') ?? false })))
          } catch (error) { if (signal.aborted) throw error; failures.push({ provider: provider.name, code: failureOf(error).code }); return [] }
        }))
        return { models: models.flat(), textModels: textModels.flat(), failures: [...new Map(failures.map(failure => [failure.provider, failure])).values()].sort((a, b) => a.provider.localeCompare(b.provider)) }
      }
      case 'canvas/save': return this.serial(async () => {
        this.ready(); const document = validateCanvas(action.document), previous = this.repository.document(document.id)
        if ((previous?.revision ?? 0) !== action.expectedRevision) throw new StylePromptError('operation-conflict')
        if (!previous && this.repository.documents().length >= this.config.maxCanvases) throw new StylePromptError('busy')
        for (const id of document.nodes.flatMap(node => node.kind === 'reference' ? node.assetIds : [])) if (!this.repository.asset(id)) throw new StylePromptError('missing-record')
        const saved = { ...document, revision: action.expectedRevision + 1, updatedAt: now() }
        await this.repository.saveDocument(saved); return saved
      })
      case 'canvas/delete': return this.serial(async () => {
        this.ready()
        if ([...this.active.keys()].some(id => this.repository.run(id)?.canvasId === action.id)) throw new StylePromptError('operation-conflict')
        await this.repository.deleteDocument(action.id)
        for (const run of this.repository.runs().filter(run => run.canvasId === action.id)) await this.repository.deleteRun(run.id)
        return { deleted: true }
      })
      case 'canvas/upload': return this.serial(async () => {
        this.ready()
        if (this.repository.assets().length + action.assets.length > this.config.maxCanvasAssets || action.assets.length > this.config.maxImages) throw new StylePromptError('busy')
        let bytes = 0
        const images = action.assets.map(asset => {
          if (asset.base64.length > Math.ceil(this.config.maxImageBytes / 3) * 4) throw new StylePromptError('invalid-input')
          const data = Buffer.from(asset.base64, 'base64'); bytes += data.length
          if (!data.length || data.length > this.config.maxImageBytes || bytes > this.config.maxUploadBytes || data.toString('base64') !== asset.base64) throw new StylePromptError('invalid-input')
          return { data, mediaType: asset.mediaType, name: asset.name }
        })
        const refs = await this.dependencies.attachments.saveImages(images)
        if (refs.length !== images.length) throw new StylePromptError('invalid-output')
        const assets = []
        for (let index = 0; index < refs.length; index++) {
          const image = await this.dependencies.attachments.readImage(refs[index]!, signal), input = action.assets[index]!
          const saved = assetSchema.parse({ formatVersion: 1, id: input.id, createdAt: now(), reference: { id: input.id, name: input.name, sha256: createHash('sha256').update(image.data).digest('hex'), attachment: image.ref } })
          const previous = this.repository.asset(input.id)
          if (previous && previous.reference.sha256 !== saved.reference.sha256) throw new StylePromptError('operation-conflict')
          if (!previous) await this.repository.saveAsset(saved)
          assets.push(previous ?? saved)
        }
        return { assets }
      })
      case 'canvas/import-history': return this.importHistory(action.id, action.canvasId, signal)
      case 'canvas/import': {
        if (Buffer.byteLength(JSON.stringify(action.bundle), 'utf8') > this.config.maxCanvasFileBytes) throw new StylePromptError('invalid-input')
        const remap = new Map<AssetId, AssetId>()
        if (new Set(action.bundle.assets.map(asset => asset.id)).size !== action.bundle.assets.length) throw new StylePromptError('invalid-input')
        for (const id of action.bundle.document.nodes.flatMap(node => node.kind === 'reference' ? node.assetIds : [])) {
          const manifest = action.bundle.assets.find(asset => asset.id === id)
          if (!manifest) throw new StylePromptError('invalid-input')
          const existing = this.repository.assets().find(asset => asset.reference.sha256 === manifest.sha256)
          if (!existing) throw new StylePromptError('missing-record')
          remap.set(id, existing.id)
        }
        const document = { ...action.bundle.document, id: action.canvasId, revision: 0, nodes: action.bundle.document.nodes.map(node => node.kind === 'reference' ? { ...node, assetIds: node.assetIds.map(id => remap.get(id)!) } : node.kind === 'analysis' || node.kind === 'prompt' ? { ...node, historyTaskId: null } : node) }
        return this.action({ operation: 'canvas/save', document, expectedRevision: 0 }, signal)
      }
      case 'canvas/run-get': return this.requireRun(action.id)
      case 'canvas/assets': return this.assetInventory()
      case 'canvas/assets-prune': return this.serial(async () => {
        this.ready()
        const keep = new Set(action.keep), eligible = new Set(this.assetInventory().assets.filter(value => !value.used && !value.recent).map(value => value.asset.id))
        let removed = 0
        for (const id of new Set(action.ids)) if (eligible.has(id) && !keep.has(id)) { await this.repository.deleteAsset(id); removed++ }
        return { removed, inventory: this.assetInventory() }
      })
      case 'canvas/run-delete': return this.serial(async () => { this.ready(); if (this.requireRun(action.id).status === 'running') throw new StylePromptError('operation-conflict'); await this.repository.deleteRun(action.id); return { deleted: true } })
      case 'canvas/cancel': {
        this.active.get(action.id)?.abort.abort()
        await this.active.get(action.id)?.promise
        return this.requireRun(action.id)
      }
      case 'canvas/run': return this.serial(async () => {
        this.ready(); validateCanvas(action.document)
        if (canvasInputIssues(action.document, action.targets).length) throw new StylePromptError('invalid-input')
        const previous = this.repository.run(action.id)
        if (previous) {
          if (JSON.stringify(previous.document) !== JSON.stringify(action.document) || JSON.stringify(previous.targets) !== JSON.stringify(action.targets)) throw new StylePromptError('operation-conflict')
          return previous
        }
        if (!this.repository.document(action.document.id)) throw new StylePromptError('missing-record')
        if (this.active.size >= this.config.maxConcurrentCanvasRuns || this.repository.runs().length >= this.config.maxCanvasRuns) throw new StylePromptError('busy')
        const requested = executionOrder(action.document, action.targets)
        if (this.repository.runs().some(run => run.canvasId === action.document.id && run.status === 'running' && requested.some(node => (node.kind === 'analysis' || node.kind === 'prompt' || node.kind === 'image') && run.nodes.some(state => state.nodeId === node.id && (state.status === 'queued' || state.status === 'running') && state.fingerprint === nodeFingerprint(action.document, node.id))))) throw new StylePromptError('busy')
        const nodes = executionOrder(action.document, action.targets).map(node => ({ nodeId: node.id, fingerprint: nodeFingerprint(action.document, node.id), inputKey: '', status: 'queued' as const, taskId: null, analysisId: null, selectedRuleIds: [], images: [], originals: [], imageRequest: null, failure: null }))
        const run: CanvasRun = { formatVersion: 1, id: action.id, canvasId: action.document.id, createdAt: now(), updatedAt: now(), status: 'running', document: structuredClone(action.document), targets: action.targets, nodes, failure: null }
        await this.repository.saveRun(run)
        const abort = new AbortController(), taskSignal = AbortSignal.any([abort.signal, this.lifetime.signal])
        const promise = Promise.resolve().then(() => this.execute(run.id, taskSignal)).catch(async error => {
          const code = this.lifetime.signal.aborted ? 'interrupted' : abort.signal.aborted ? 'cancelled' : failureOf(error).code
          try { const current = this.requireRun(run.id); await this.repository.saveRun({ ...current, status: code === 'cancelled' || code === 'interrupted' ? code : 'failed', updatedAt: now(), failure: { code }, nodes: current.nodes.map(node => node.status === 'queued' || node.status === 'running' ? { ...node, status: code === 'cancelled' || code === 'interrupted' ? code : 'failed', failure: { code } } : node) }) }
          catch (storageError) { this.healthy = false; this.report() }
        }).finally(() => { this.active.delete(run.id) })
        this.active.set(run.id, { abort, promise }); return run
      })
    }
  }

  private assetInventory() {
    const used = new Set([...this.repository.documents(), ...this.repository.runs().map(run => run.document)].flatMap(document => document.nodes.flatMap(node => node.kind === 'reference' ? node.assetIds : [])))
    const cutoff = Date.now() - this.config.canvasAssetGraceMs
    return { total: this.repository.assets().length, limit: this.config.maxCanvasAssets, graceMs: this.config.canvasAssetGraceMs, assets: this.repository.assets().map(asset => ({ asset, used: used.has(asset.id), recent: !Number.isFinite(Date.parse(asset.createdAt)) || Date.parse(asset.createdAt) >= cutoff })) }
  }

  private async update(id: RunId, nodeId: NodeId, patch: Partial<NodeExecution>): Promise<void> {
    await this.serial(async () => {
      const run = this.requireRun(id)
      await this.repository.saveRun({ ...run, updatedAt: now(), nodes: run.nodes.map(node => node.nodeId === nodeId ? { ...node, ...patch } : node) })
    })
  }

  private async execute(id: RunId, signal: AbortSignal): Promise<void> {
    const initial = this.requireRun(id), forced = new Set<NodeId>()
    const forceTarget = (nodeId: NodeId): void => {
      const node = initial.document.nodes.find(node => node.id === nodeId)!
      if (node.kind === 'analysis' || node.kind === 'prompt' || node.kind === 'image') { forced.add(node.id); return }
      initial.document.edges.filter(edge => edge.target === nodeId).forEach(edge => forceTarget(edge.source))
    }
    initial.targets.forEach(forceTarget)
    while (this.requireRun(id).nodes.some(node => node.status === 'queued')) {
      signal.throwIfAborted()
      const run = this.requireRun(id)
      const ready = run.nodes.filter(node => node.status === 'queued' && run.document.edges.filter(edge => edge.target === node.nodeId).every(edge => run.nodes.find(other => other.nodeId === edge.source)?.status !== 'queued' && run.nodes.find(other => other.nodeId === edge.source)?.status !== 'running'))
      if (!ready.length) throw new StylePromptError('invalid-input')
      const settled = await Promise.allSettled(ready.slice(0, this.config.maxConcurrentTasks).map(async state => {
        const parents = run.document.edges.filter(edge => edge.target === state.nodeId).map(edge => run.nodes.find(node => node.nodeId === edge.source)!)
        if (parents.some(parent => parent.status !== 'succeeded')) { await this.update(id, state.nodeId, { status: 'blocked' }); return }
        const inputKey = JSON.stringify(parents.map(parent => ({ nodeId: parent.nodeId, taskId: parent.taskId, analysisId: parent.analysisId, selectedRuleIds: parent.selectedRuleIds, images: parent.images.map(image => image.sha256) })))
        const cached = !forced.has(state.nodeId) ? this.repository.runs().filter(other => other.id !== id && other.canvasId === run.canvasId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).flatMap(other => other.nodes).find(other => other.nodeId === state.nodeId && other.status === 'succeeded' && other.fingerprint === state.fingerprint && other.inputKey === inputKey) : undefined
        if (cached) { await this.update(id, state.nodeId, { ...cached, reused: true }); return }
        await this.update(id, state.nodeId, { status: 'running', inputKey })
        try { await this.executeNode(id, run.document.nodes.find(node => node.id === state.nodeId)!, forced.has(state.nodeId), signal) }
        catch (error) { if (signal.aborted) throw error; await this.update(id, state.nodeId, { status: 'failed', failure: failureOf(error) }) }
      }))
      for (const result of settled) if (result.status === 'rejected') throw result.reason
    }
    const run = this.requireRun(id)
    await this.repository.saveRun({ ...run, status: run.nodes.every(node => node.status === 'succeeded') ? 'succeeded' : 'failed', updatedAt: now() })
  }

  private async executeNode(id: RunId, node: CanvasNode, force: boolean, signal: AbortSignal): Promise<void> {
    const run = this.requireRun(id)
    const incoming = (handle: string) => run.document.edges.filter(edge => edge.target === node.id && edge.targetHandle === handle).map(edge => run.nodes.find(value => value.nodeId === edge.source)!)
    const images = () => incoming('images').flatMap(value => value.images)
    const finish = (patch: Partial<NodeExecution> = {}) => this.update(id, node.id, { reused: false, ...patch, status: 'succeeded' })
    switch (node.kind) {
      case 'reference': {
        const references = node.assetIds.map(id => this.repository.asset(id)?.reference)
        if (!references.length || references.some(value => !value)) throw new StylePromptError('invalid-input')
        await finish({ images: references.filter((value): value is Reference => Boolean(value)) }); return
      }
      case 'brief': await finish(); return
      case 'analysis': {
        if (node.historyTaskId && !force) {
          const record = this.tasks.get(node.historyTaskId)
          if (record?.kind !== 'analysis' || record.status !== 'succeeded') throw new StylePromptError('missing-record')
          const references = images()
          if (JSON.stringify(record.route) === JSON.stringify(node.route) && JSON.stringify(record.dimensions) === JSON.stringify(node.dimensions)
            && (!references.length || references.length === record.references.length && references.every((reference, index) => reference.sha256 === record.references[index]!.sha256))) {
            await finish({ taskId: record.id, analysisId: record.id, images: record.references, reused: true }); return
          }
        }
        if (!node.route) throw new StylePromptError('capability-unavailable')
        const references = images()
        if (!references.length || references.length > this.config.maxImages) throw new StylePromptError('invalid-input')
        const files = await Promise.all(references.map(async reference => { const image = await this.dependencies.attachments.readImage(nativeRef(reference), signal); return { name: reference.name, mediaType: image.ref.mediaType, base64: Buffer.from(image.data).toString('base64') } }))
        const taskId = taskIdSchema.parse(randomUUID())
        await this.update(id, node.id, { taskId })
        await this.legacy.action({ operation: 'analyze', input: { id: taskId, route: node.route, dimensions: node.dimensions, files } }, signal)
        await this.waitTask(taskId, signal)
        const record = this.tasks.get(taskId)
        if (record?.kind !== 'analysis') throw new StylePromptError('invalid-output')
        await finish({ taskId, analysisId: taskId, images: record.references }); return
      }
      case 'rules': {
        const source = incoming('analysis')[0], record = source?.analysisId ? this.tasks.get(source.analysisId) : undefined
        if (record?.kind !== 'analysis' || !record.result) throw new StylePromptError('invalid-input')
        const selected = node.selectedRuleIds ?? record.result.rules.filter(rule => rule.status !== 'unknown' && rule.scope !== 'scene').map(rule => rule.id)
        if (!selected.length || selected.some(id => !record.result!.rules.some(rule => rule.id === id && rule.status !== 'unknown' && rule.scope !== 'scene'))) throw new StylePromptError('invalid-input')
        await finish({ analysisId: record.id, selectedRuleIds: selected, images: record.references }); return
      }
      case 'prompt': {
        const style = incoming('style')[0], briefEdge = run.document.edges.find(edge => edge.target === node.id && edge.targetHandle === 'brief')
        const brief = run.document.nodes.find(value => value.id === briefEdge?.source)
        if (node.historyTaskId && !force) {
          const record = this.tasks.get(node.historyTaskId)
          if (record?.kind !== 'generation' || record.status !== 'succeeded') throw new StylePromptError('missing-record')
          if (style?.analysisId === record.input.analysisId && brief?.kind === 'brief' && JSON.stringify(brief.brief) === JSON.stringify(record.input.brief)
            && JSON.stringify(brief.changes) === JSON.stringify(record.input.changes) && JSON.stringify(style.selectedRuleIds) === JSON.stringify(record.input.selectedRuleIds)
            && record.input.mode === node.mode && record.input.platform === node.platform && (!record.input.route || JSON.stringify(record.input.route) === JSON.stringify(node.route))) {
            await finish({ taskId: record.id, analysisId: record.input.analysisId, selectedRuleIds: record.input.selectedRuleIds, reused: true }); return
          }
        }
        if (!style?.analysisId || brief?.kind !== 'brief' || node.mode === 'model' && !node.route) throw new StylePromptError('invalid-input')
        const taskId = taskIdSchema.parse(randomUUID())
        await this.update(id, node.id, { taskId })
        await this.legacy.action({ operation: 'generate', id: taskId, input: { analysisId: style.analysisId, selectedRuleIds: style.selectedRuleIds, brief: brief.brief, changes: brief.changes, platform: node.platform, mode: node.mode, ...(node.route ? { route: node.route } : {}) } }, signal)
        await this.waitTask(taskId, signal)
        await finish({ taskId, analysisId: style.analysisId, selectedRuleIds: style.selectedRuleIds }); return
      }
      case 'image': {
        if (!node.route || typeof this.dependencies.llm.generateImages !== 'function') throw new StylePromptError('capability-unavailable')
        const source = incoming('prompt')[0], record = source?.taskId ? this.tasks.get(source.taskId) : undefined
        const prompt = record?.kind === 'generation' && record.result ? (node.variant < 0 ? record.result.fullPrompt.en : record.result.variants[node.variant]?.prompt.en) : node.prompt
        const references = images()
        if (!prompt?.trim() || references.length > this.config.maxImages) throw new StylePromptError('invalid-input')
        const requestId = taskIdSchema.parse(randomUUID())
        await this.update(id, node.id, { taskId: requestId, imageRequest: { route: node.route, prompt, size: node.size, quality: node.quality, references } })
        const imageSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.imageTimeoutMs)])
        const generated = await this.dependencies.llm.generateImages({ id: brandString<ImageGenerationId>(requestId), ...node.route, prompt, references: references.map(nativeRef), size: node.size, quality: node.quality, signal: imageSignal }).catch(error => { if (imageSignal.aborted && !signal.aborted) throw new StylePromptError('request-timeout'); throw error })
        if (!generated.length || generated.length > this.config.maxImages) throw new StylePromptError('invalid-output')
        const saved = await Promise.all(generated.map(async image => { const stored = await this.dependencies.attachments.readImage(image.preview, signal); return referenceSchema.parse({ id: randomUUID(), name: stored.ref.name ?? image.original.name, sha256: createHash('sha256').update(stored.data).digest('hex'), attachment: stored.ref }) }))
        await finish({ images: saved, originals: generated.map(image => ({ attachmentId: image.original.attachmentId, name: image.original.name, bytes: image.original.bytes })) }); return
      }
      case 'output': {
        const source = incoming('prompt')[0]
        if (!source && !images().length) throw new StylePromptError('invalid-input')
        const imageSource = incoming('images')
        await finish({ taskId: source?.taskId ?? null, analysisId: source?.analysisId ?? null, images: images(), originals: imageSource.flatMap(node => node.originals) }); return
      }
    }
  }

  private async waitTask(id: TaskId, signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        signal.throwIfAborted()
        const task = this.tasks.get(id)
        if (!task) throw new StylePromptError('missing-record')
        if (task.status !== 'running') { if (task.status !== 'succeeded') throw new StylePromptError(task.failure?.code ?? 'model-error'); return }
        await delay(this.config.pollIntervalMs, undefined, { signal })
      }
    } catch (error) { if (signal.aborted) await this.legacy.action({ operation: 'cancel', id }, new AbortController().signal); throw error }
  }

  private async importHistory(id: TaskId, canvasId: CanvasId, signal: AbortSignal): Promise<CanvasDocument> {
    this.ready()
    const record = this.tasks.get(id)
    if (!record || record.status !== 'succeeded') throw new StylePromptError('invalid-input')
    const analysis = record.kind === 'analysis' ? record : this.tasks.get(record.input.analysisId)
    if (analysis?.kind !== 'analysis' || !analysis.result) throw new StylePromptError('missing-record')
    if (this.repository.assets().length + analysis.references.length > this.config.maxCanvasAssets) throw new StylePromptError('busy')
    const document = starterCanvas(canvasId), ids: AssetId[] = []
    for (const reference of analysis.references) {
      const id = assetId.parse(randomUUID()); ids.push(id)
      await this.repository.saveAsset({ formatVersion: 1, id, createdAt: now(), reference })
    }
    document.name = analysis.result.name
    document.nodes = document.nodes.filter(node => node.kind !== 'image').map(node => {
      if (node.kind === 'reference') return { ...node, assetIds: ids }
      if (node.kind === 'analysis') return { ...node, historyTaskId: analysis.id, route: analysis.route, dimensions: analysis.dimensions }
      if (record.kind === 'generation') {
        if (node.kind === 'rules') return { ...node, selectedRuleIds: record.input.selectedRuleIds }
        if (node.kind === 'brief') return { ...node, brief: record.input.brief, changes: record.input.changes }
        if (node.kind === 'prompt') return { ...node, historyTaskId: record.id, mode: record.input.mode, platform: record.input.platform, route: record.input.route ?? analysis.route }
      }
      return node
    })
    const kept = new Set(document.nodes.map(node => node.id)); document.edges = document.edges.filter(edge => kept.has(edge.source) && kept.has(edge.target))
    document.edges.push({ id: randomUUID(), source: document.nodes.find(node => node.kind === 'prompt')!.id, sourceHandle: 'prompt', target: document.nodes.find(node => node.kind === 'output')!.id, targetHandle: 'prompt' })
    return canvasSchema.parse(await this.action({ operation: 'canvas/save', document, expectedRevision: 0 }, signal))
  }

  /** @param id Canvas asset identity. @param signal Read cancellation. @returns Profile-owned reference bytes. */
  async image(id: import('../shared/canvas.ts').AssetId, signal: AbortSignal) {
    const asset = this.repository.asset(id)
    if (!asset) throw new StylePromptError('missing-record')
    return this.dependencies.attachments.readImage(nativeRef(asset.reference), signal)
  }

  /** Stop admission and drain graph work before the legacy writer lease is released. */
  async dispose(): Promise<void> {
    this.disposed = true; this.lifetime.abort()
    await Promise.allSettled([...this.active.values()].map(item => item.promise)); await this.writes; await this.repository.close()
  }
}
