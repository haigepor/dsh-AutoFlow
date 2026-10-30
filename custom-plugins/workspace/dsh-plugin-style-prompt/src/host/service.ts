/** Profile-local tasks freeze references and prompts; unknown remote outcomes are never retried automatically. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { analysisSchema, analyzeInputSchema, referenceSchema, StylePromptError, failureOf, type Action, type AnalysisRecord, type GenerationRecord, type GenerationInput, type TaskRecord, type TaskId, type ReferenceId } from '../shared/model.ts'
import { ANALYSIS_TEMPLATE_VERSION, GENERATION_TEMPLATE_VERSION, analysisInstructions, generationInstructions } from '../shared/prompts.ts'
import { compileQuick, exportBundle, selectedRules, validateGeneration } from '../shared/compose.ts'
import { NativeModel, listModels, nativeRef, type ModelDependencies } from './native-model.ts'
import type { Config } from './config.ts'
import type { Repository } from './repository.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()

/** One task owner manages admission, cancellation and drain; reads remain possible after a storage failure. */
export class StylePromptService {
  private readonly lifetime = new AbortController()
  private readonly running = new Map<TaskId, { abort: AbortController; promise: Promise<void> }>()
  private admission = Promise.resolve()
  private stopping = false
  private healthy = true
  private readonly model: NativeModel

  constructor(private readonly repository: Repository, private readonly dependencies: ModelDependencies, readonly config: Config, private readonly report: () => void) {
    this.model = new NativeModel(dependencies, config)
  }

  /** Mark interrupted work visibly without reissuing a potentially billed request. */
  async initialize(): Promise<void> {
    for (const record of this.repository.list()) if (record.status === 'running') await this.repository.put({ ...record, status: 'interrupted', updatedAt: now(), failure: { code: 'interrupted' } })
  }

  private require(id: TaskId): TaskRecord {
    const record = this.repository.get(id)
    if (!record) throw new StylePromptError('missing-record')
    return record
  }

  private assertReady(): void {
    if (this.stopping) throw new StylePromptError('not-ready')
    if (!this.healthy) throw new StylePromptError('storage-error')
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.admission.then(work)
    this.admission = next.then(() => {}, () => {})
    return next
  }

  private capacity(): void {
    this.assertReady()
    if (this.running.size >= this.config.maxConcurrentTasks || this.repository.list().length >= this.config.maxStoredTasks) throw new StylePromptError('busy')
  }

  /** @param action Validated Client command. @param signal Admission/read cancellation. @returns Authenticated workbench data. */
  async action(action: Action, signal: AbortSignal): Promise<unknown> {
    signal = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    signal.throwIfAborted()
    switch (action.operation) {
      case 'models': return listModels(this.dependencies, signal)
      case 'list': return { healthy: this.healthy, limits: { maxImages: this.config.maxImages, maxImageBytes: this.config.maxImageBytes, maxUploadBytes: this.config.maxUploadBytes, pollIntervalMs: this.config.pollIntervalMs }, tasks: this.repository.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, this.config.maxHistoryItems).map(record => ({ id: record.id, kind: record.kind, status: record.status, createdAt: record.createdAt, name: record.kind === 'analysis' ? record.result?.name ?? record.references[0]?.name ?? '' : record.input.brief.zh })) }
      case 'get': return this.require(action.id)
      case 'cancel': {
        this.running.get(action.id)?.abort.abort()
        await this.running.get(action.id)?.promise
        return this.require(action.id)
      }
      case 'delete': return this.serial(async () => {
        this.assertReady()
        const record = this.require(action.id)
        if (record.status === 'running' || this.repository.list().some(value => value.kind === 'generation' && value.input.analysisId === action.id)) throw new StylePromptError('operation-conflict')
        await this.repository.delete(action.id)
        return { deleted: true }
      })
      case 'analyze': return this.startAnalysis(action.input, signal)
      case 'generate': return this.startGeneration(action.id, action.input, signal)
      case 'export': {
        const generated = this.require(action.id)
        if (generated.kind !== 'generation' || generated.status !== 'succeeded' || !generated.result) throw new StylePromptError('invalid-input')
        const source = this.require(generated.input.analysisId)
        if (source.kind !== 'analysis' || source.status !== 'succeeded' || !source.result) throw new StylePromptError('invalid-input')
        return exportBundle({ analysis: source.result, input: generated.input, result: generated.result, references: source.references })
      }
    }
  }

  private async startAnalysis(input: z.infer<typeof analyzeInputSchema>, signal: AbortSignal): Promise<AnalysisRecord> {
    return this.serial(async () => {
      this.assertReady()
      if (input.files.length > this.config.maxImages || new Set(input.dimensions).size !== input.dimensions.length) throw new StylePromptError('invalid-input')
      let total = 0
      const images = input.files.map(file => {
        if (file.base64.length > Math.ceil(this.config.maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new StylePromptError('invalid-input')
        const data = Buffer.from(file.base64, 'base64')
        total += data.length
        if (!data.length || data.length > this.config.maxImageBytes || total > this.config.maxUploadBytes || data.toString('base64') !== file.base64) throw new StylePromptError('invalid-input')
        return { data, mediaType: file.mediaType, name: file.name }
      })
      const inputDigest = digest({ route: input.route, dimensions: input.dimensions, files: images.map(file => ({ name: file.name, mediaType: file.mediaType, sha256: createHash('sha256').update(file.data).digest('hex') })) })
      const previous = this.repository.get(input.id)
      if (previous) {
        if (previous.kind !== 'analysis' || previous.digest !== inputDigest) throw new StylePromptError('operation-conflict')
        return previous
      }
      this.capacity()
      await this.model.preflight(input.route, signal)
      const refs = await this.dependencies.attachments.saveImages(images)
      if (refs.length !== images.length) throw new StylePromptError('invalid-input')
      const references = await Promise.all(refs.map(async (attachment, index) => {
        const stored = await this.dependencies.attachments.readImage(attachment, signal)
        return referenceSchema.parse({ id: `ref-${index + 1}`, name: images[index]!.name, sha256: createHash('sha256').update(stored.data).digest('hex'), attachment: stored.ref })
      }))
      signal.throwIfAborted()
      const record: AnalysisRecord = { formatVersion: 1, id: input.id, kind: 'analysis', createdAt: now(), updatedAt: now(), digest: inputDigest, status: 'running', failure: null, call: null, route: input.route, references, dimensions: input.dimensions, result: null }
      await this.repository.put(record)
      this.launch(record.id, async taskSignal => {
        const raw = await this.model.call({ route: record.route, system: analysisInstructions, inputText: JSON.stringify({ task: 'extract-transferable-style', referenceIds: references.map(ref => ref.id), dimensions: record.dimensions, sampleCount: references.length }), references, templateVersion: ANALYSIS_TEMPLATE_VERSION }, call => this.saveCall(record.id, call), taskSignal)
        const parsed = analysisSchema.safeParse(raw)
        if (!parsed.success || parsed.data.rules.some(rule => rule.referenceIds.some(id => !references.some(ref => ref.id === id)) || !record.dimensions.includes(rule.dimension))) throw new StylePromptError('invalid-output')
        taskSignal.throwIfAborted()
        const current = this.require(record.id)
        if (current.kind !== 'analysis') throw new StylePromptError('invalid-input')
        await this.repository.put({ ...current, result: parsed.data, status: 'succeeded', updatedAt: now() })
      })
      return record
    })
  }

  private async startGeneration(id: TaskId, input: GenerationInput, signal: AbortSignal): Promise<GenerationRecord> {
    return this.serial(async () => {
      this.assertReady()
      const source = this.require(input.analysisId)
      if (source.kind !== 'analysis' || source.status !== 'succeeded' || !source.result) throw new StylePromptError('invalid-input')
      const rules = selectedRules(source.result, input), inputDigest = digest(input)
      const previous = this.repository.get(id)
      if (previous) {
        if (previous.kind !== 'generation' || previous.digest !== inputDigest) throw new StylePromptError('operation-conflict')
        return previous
      }
      this.capacity()
      const route = input.route ?? source.route
      if (input.mode === 'model') await this.model.preflight(route, signal)
      const record: GenerationRecord = { formatVersion: 1, id, kind: 'generation', createdAt: now(), updatedAt: now(), digest: inputDigest, status: input.mode === 'quick' ? 'succeeded' : 'running', failure: null, call: null, input, result: input.mode === 'quick' ? compileQuick(source.result, input) : null }
      signal.throwIfAborted()
      await this.repository.put(record)
      if (input.mode === 'model') this.launch(id, async taskSignal => {
        const raw = await this.model.call({ route, system: generationInstructions, inputText: JSON.stringify({ selectedRules: rules, sourceContent: source.result!.sourceContent, sceneSpecific: source.result!.sceneSpecific, targetBrief: input.brief, changes: input.changes, platform: input.platform }), references: [], templateVersion: GENERATION_TEMPLATE_VERSION }, call => this.saveCall(id, call), taskSignal)
        const result = validateGeneration(raw, source.result!, input, 3)
        taskSignal.throwIfAborted()
        const current = this.require(id)
        if (current.kind !== 'generation') throw new StylePromptError('invalid-input')
        await this.repository.put({ ...current, status: 'succeeded', result, updatedAt: now() })
      })
      return record
    })
  }

  private async saveCall(id: TaskId, call: NonNullable<TaskRecord['call']>): Promise<void> {
    await this.repository.put({ ...this.require(id), call, updatedAt: now() })
  }

  private launch(id: TaskId, work: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController(), deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    const signal = AbortSignal.any([abort.signal, deadline, this.lifetime.signal])
    // 先登记任务，再异步派发；取消与卸载可观察并等待同一个 Promise。
    const promise = Promise.resolve().then(() => work(signal)).catch(async error => {
      const code = this.lifetime.signal.aborted ? 'interrupted' : abort.signal.aborted ? 'cancelled' : deadline.aborted ? 'request-timeout' : error instanceof z.ZodError ? 'invalid-output' : failureOf(error).code
      try {
        await this.repository.put({ ...this.require(id), status: code === 'cancelled' || code === 'interrupted' ? code : 'failed', failure: { code }, updatedAt: now() })
      } catch (storageError) {
        // 无法提交终态时停止新任务，保留可读状态并通过独立日志报告存储失败。
        this.healthy = false; this.report()
      }
    }).finally(() => { this.running.delete(id) })
    this.running.set(id, { abort, promise })
  }

  /** @param id Owning analysis. @param referenceId Scoped reference. @param signal Read lifetime. @returns Validated saved image bytes. */
  async image(id: TaskId, referenceId: ReferenceId, signal: AbortSignal) {
    const record = this.require(id)
    if (record.kind !== 'analysis') throw new StylePromptError('invalid-input')
    const reference = record.references.find(ref => ref.id === referenceId)
    if (!reference) throw new StylePromptError('missing-record')
    return this.dependencies.attachments.readImage(nativeRef(reference), signal)
  }

  /** Stop admission, abort background API requests and drain storage before releasing the writer. */
  async dispose(): Promise<void> {
    this.stopping = true; this.lifetime.abort()
    await this.admission
    await Promise.allSettled([...this.running.values()].map(item => item.promise))
    await this.repository.close()
  }
}
