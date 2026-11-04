/** Durable owner-authorized preparation, native prompt admission and result delivery. */
import { randomUUID, createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { ModelProfiles } from '../domain/model-profile.ts'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { jsonSchema, type DomainActor, type Json, type ModelProfile } from '../shared/model.ts'
import { searchLaunchInputSchema, searchLaunchViewSchema, type SearchLaunchInput, type SearchLaunchView } from '../shared/search-launch.ts'
import { CuratorError } from '../shared/errors.ts'
import { executionSchema, safeFailure, specOf, toJson, type ExecutionSpec, type RunEngine } from './runtime.ts'
import type { NativeSearchSessions } from './native-search-session.ts'
import type { AssetFiles } from '../media/index.ts'
import { deliverSearchResults } from './search-results.ts'
import { searchQueryGuidance, searchToolGuidance } from './search-guidance.ts'
import { searchNegativeReferencesSchema } from '../shared/search-reference-datasets.ts'
import { freezeSearchNegatives, searchNegativeSummary } from './search-reference-datasets.ts'
import { listDatasets, readDatasetDirectory, type DatasetReads } from './datasets.ts'

const launchSchema = z.strictObject({
  version: z.literal(1), input: searchLaunchInputSchema, requestDigest: z.string(), sessionId: z.string(), requestId: z.string(),
  workspace: z.strictObject({ id: z.string(), title: z.string(), path: z.string(), device: z.string(), inode: z.string() }), spec: executionSchema,
  stage: searchLaunchViewSchema.shape.stage, status: searchLaunchViewSchema.shape.status,
  datasetId: z.string().optional(), createdAt: z.string(), updatedAt: z.string(), error: jsonSchema.optional(),
  negativeReferences: searchNegativeReferencesSchema.optional(),
  stopRequested: z.boolean().optional(),
})
type Launch = z.infer<typeof launchSchema>

/** Each launch holds frozen inputs; UI disconnects never own these promises. */
export class SearchLaunches {
  private readonly running = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly starting = new Map<string, { digest: string; work: Promise<SearchLaunchView> }>()
  private readonly stopping = new Set<string>()
  private readonly admissions = new Map<string, Promise<Json>>()
  private readonly faults = new Map<string, Json>()
  private readonly stopWork = new Map<string, Promise<SearchLaunchView>>()
  constructor(private readonly deps: {
    domain: CuratorDomain; files: AssetFiles; engine: RunEngine; signal: AbortSignal; native(): NativeSearchSessions | undefined
    freeze(input: SearchLaunchInput, actor: DomainActor): Promise<ExecutionSpec>
    datasetReads?: DatasetReads
  }) {}

  private native() {
    const native = this.deps.native()
    if (!native) throw new CuratorError('capability-unavailable', 'search-launch', 'Native Workspace, conversation and file attachment services are required. Open this workflow in the native workbench.')
    return native
  }
  /** @returns Current native conversation models from the same catalog that validates launch admission. */
  async models() { return { ...await this.native().models(), conversationModelSelection: true as const } }
  private read(id: string): Launch {
    const state = this.deps.domain.repository.manifest(`search-launch:${id}`)?.state
    if (!state) throw new CuratorError('reference-unavailable', 'search-launch', 'The saved launch is unavailable.')
    return launchSchema.parse(state)
  }
  private all(): Launch[] { return this.deps.domain.repository.manifests().filter(item => item.aggregateId.startsWith('search-launch:')).map(item => launchSchema.parse(item.state)) }
  private actor(value: Launch): DomainActor { return { kind: 'agent', id: value.sessionId, sessionId: value.sessionId, profileId: this.deps.domain.profileId } }
  private dataset(id: string, profile: ModelProfile, actor: DomainActor) {
    return new ModelProfiles(this.deps.domain).authorizeDataset(profile, id, actor)
  }
  private async save(value: Launch): Promise<void> {
    const aggregateId = `search-launch:${value.input.operationId}`, revision = this.deps.domain.repository.manifest(aggregateId)?.revision ?? 0
    value.updatedAt = new Date().toISOString()
    await this.deps.domain.repository.commit({ aggregateId, expectedRevision: revision, operationId: `${aggregateId}:${revision + 1}`, request: value, records: [], state: toJson(value) })
  }
  private view(value: Launch): SearchLaunchView {
    const runs = this.deps.domain.repository.list('run').filter(run => run.owner.kind === 'session' && run.owner.sessionId === value.sessionId && specOf(run).fixed.searchLaunchId === value.input.operationId)
    const runIds: string[] = runs.map(run => run.id), qualified = this.deps.domain.repository.list('selection').filter(item => runIds.includes(item.runId) && item.qualification === 'auto-qualified').length
    const runStatus = runs.length ? runs.every(run => run.status === 'completed') ? 'completed' : runs.some(run => run.status === 'running') ? 'running' : runs[0]!.status : undefined
    const delivery = this.deps.domain.repository.manifests().find(item => item.aggregateId.startsWith(`search-delivery:${value.input.operationId}:`))
    const directory = delivery ? z.object({ directory: z.string() }).parse(delivery.state).directory : undefined
    const fault = this.faults.get(value.input.operationId) ?? value.error
    return searchLaunchViewSchema.parse({ id: value.input.operationId, input: value.input, sessionId: value.sessionId, stage: value.stage, status: fault ? 'failed' : value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.datasetId ? { datasetId: value.datasetId } : {}), ...(value.negativeReferences ? { negativeReferences: { datasets: value.negativeReferences.datasets.length, references: value.negativeReferences.samples.length } } : {}), runIds, qualified, ...(value.stopRequested && value.status !== 'stopped' ? { stopping: true } : {}), ...(runStatus ? { runStatus } : {}), ...(directory ? { directory } : {}), ...(fault ? { error: fault } : {}) })
  }
  /** @returns Existing native Workspace choices, or an explicit unavailable capability. */
  options() { return { workspaces: this.native().workspaces() } }
  /** @param raw Owner-selected collection and profile. @param actor Authenticated reader. @param pageSize Configured package window. @returns Completed main packages and current deduplicated negative-reference counts. */
  datasets(raw: unknown, actor: DomainActor, pageSize: number) {
    return this.deps.domain.repository.readSnapshot(() => {
      const input = z.object({ styleId: z.string(), modelProfileId: z.string(), pageToken: z.string().optional() }).parse(raw)
      const profile = this.deps.domain.require('modelProfile', input.modelProfileId)
      if (profile.styleId !== input.styleId) throw new CuratorError('owner-denied', 'search-launch-dataset', 'The selected profile belongs to another collection.')
      new ModelProfiles(this.deps.domain).authorize(profile, actor)
      const directory = readDatasetDirectory(this.deps.domain)
      return { ...listDatasets(this.deps.domain, this.deps.engine, actor, { styleId: input.styleId, ...(input.pageToken ? { pageToken: input.pageToken } : {}), status: 'completed', reusableOnly: true }, pageSize, this.deps.datasetReads, directory), negativeReferences: searchNegativeSummary(this.deps.domain, profile, directory) }
    })
  }
  /** @param styleId Optional collection filter. @param pageSize Optional deployment-bounded recent window. @returns Durable launch progress with actual linked Run identities. */
  list(styleId?: string, pageSize?: number): SearchLaunchView[] {
    return this.deps.domain.repository.readSnapshot(() => this.all().filter(value => !styleId || this.deps.domain.require('modelProfile', value.input.modelProfileId).styleId === styleId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, pageSize).map(value => this.view(value)))
  }
  /** @param sessionId Session whose access the caller has already authenticated and authorized. @returns Only that Session's public launch progress, or undefined when it has no launch. */
  forSession(sessionId: string): SearchLaunchView | undefined {
    return this.deps.domain.repository.readSnapshot(() => {
      const value = this.all().find(item => item.sessionId === sessionId)
      return value ? this.view(value) : undefined
    })
  }
  /** @param raw Validated owner wire input. @returns Durable receipt; remaining work continues under the Host lifetime. */
  async start(raw: unknown): Promise<SearchLaunchView> {
    const input = searchLaunchInputSchema.parse(raw), digest = contentDigest(input), active = this.starting.get(input.operationId)
    if (active) {
      if (active.digest !== digest) throw new CuratorError('operation-conflict', 'search-launch', 'The pending launch has different task settings.')
      return active.work
    }
    const work = this.startNow(input).finally(() => this.starting.delete(input.operationId))
    this.starting.set(input.operationId, { digest, work })
    return work
  }
  private async startNow(input: SearchLaunchInput): Promise<SearchLaunchView> {
    const prior = this.deps.domain.repository.manifest(`search-launch:${input.operationId}`)
    if (prior) {
      const saved = launchSchema.parse(prior.state)
      if (saved.requestDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'search-launch', 'This launch identity was already used with different task settings.')
      if (saved.stopRequested && saved.status !== 'stopped') return await this.stop(input.operationId)
      // 失败状态的提交可能先于后台 Promise 清理被读到；重试必须等原清理结束再重新入队。
      if (saved.status === 'failed') { const previous = this.running.get(input.operationId); if (previous) await previous }
      if (saved.status !== 'stopped') this.schedule(saved.input.operationId)
      return this.view(saved)
    }
    // 新任务明确选择自动准备后才允许补包；旧任务始终按原受理输入重放。
    if (!input.datasetId && !input.autoPrepareDataset) throw new CuratorError('invalid-input', 'search-launch-dataset', 'Select a completed dataset or enable automatic preparation before starting this search.')
    const sessionId = randomUUID()
    const actor: DomainActor = { kind: 'agent', id: sessionId, sessionId, profileId: this.deps.domain.profileId }
    const profile = this.deps.domain.require('modelProfile', input.modelProfileId), profiles = new ModelProfiles(this.deps.domain)
    const { dataset, negativeReferences } = this.deps.domain.repository.readSnapshot(() => {
      if (input.datasetId) profiles.authorizeDataset(profile, input.datasetId, actor)
      else profiles.assertFresh(profile, actor)
      const directory = input.includeNegativeDatasets !== false && profile.references.some(ref => ref.reference.role === 'negative') ? readDatasetDirectory(this.deps.domain) : undefined
      const automatic = input.datasetId ? undefined : (directory?.artifacts ?? this.deps.domain.repository.list('profileExport')).filter(item => (!item.sampleScope || item.sampleScope === 'all') && item.modelProfileId === profile.id && item.access.kind === 'profile-library').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
      return { dataset: input.datasetId || automatic ? this.dataset(input.datasetId ?? automatic!.id, profile, actor) : undefined, negativeReferences: input.includeNegativeDatasets !== false ? freezeSearchNegatives(this.deps.domain, profile, actor, directory) : undefined }
    })
    const target = await this.native().preflight(input.workspaceId, this.deps.signal, input.conversationModel), identity = await stat(target.path)
    const workspace = { ...target, device: String(identity.dev), inode: String(identity.ino) }
    const spec = await this.deps.freeze(input, actor)
    spec.fixed.searchLaunchId = input.operationId
    spec.specDigest = contentDigest({ kind: spec.kind, config: spec.config, input: spec.input, fixed: spec.fixed })
    const now = new Date().toISOString(), value: Launch = { version: 1, input, requestDigest: contentDigest(input), sessionId, requestId: randomUUID(), workspace, spec, ...(dataset ? { datasetId: dataset.id } : {}), ...(negativeReferences ? { negativeReferences } : {}), stage: 'preparing', status: 'working', createdAt: now, updatedAt: now }
    await this.save(value)
    this.schedule(input.operationId)
    return this.view(value)
  }
  private schedule(id: string) {
    if (this.running.has(id) || this.deps.signal.aborted) return
    const controller = new AbortController(); this.controllers.set(id, controller)
    this.faults.delete(id)
    const work = this.run(id, AbortSignal.any([controller.signal, this.deps.signal])).catch(error => { this.faults.set(id, toJson(safeFailure(error))) }).finally(() => { this.running.delete(id); this.controllers.delete(id) })
    this.running.set(id, work)
  }
  private async run(id: string, signal: AbortSignal): Promise<void> {
    let value = this.read(id)
    try {
      if (value.status === 'stopped') return
      const native = this.native(), actor = this.actor(value), profile = this.deps.domain.require('modelProfile', value.input.modelProfileId), profiles = new ModelProfiles(this.deps.domain)
      value.status = 'working'; delete value.error; await this.save(value)
      if (value.datasetId) this.dataset(value.datasetId, profile, actor)
      value.stage = 'creating-session'; await this.save(value)
      await native.ensure(value.workspace, value.sessionId, signal)
      value.stage = value.datasetId ? 'attaching' : 'preparing-dataset'; await this.save(value)
      await native.name(value.sessionId, `${this.deps.domain.require('style', profile.styleId).name} · ${value.input.taskBrief}`.slice(0, 100))
      if (!value.datasetId) {
        const existing = this.deps.domain.repository.list('profileExport').find(item => (!item.sampleScope || item.sampleScope === 'all') && item.modelProfileId === profile.id && (item.access.kind === 'profile-library' || item.access.sessionId === value.sessionId))
        const dataset = value.input.datasetId ? this.dataset(value.input.datasetId, profile, actor) : existing ?? await profiles.export(profile, `search-dataset:${value.input.autoPrepareDataset ? profile.id : id}`, actor, { signal, acceptedLaunchId: id, shareWithLibrary: value.input.autoPrepareDataset === true })
        value.datasetId = dataset.id; await this.save(value)
      }
      if (value.input.datasetId && value.input.datasetId !== value.datasetId) throw new CuratorError('operation-conflict', 'search-launch-dataset', 'The saved search references a different dataset.')
      const dataset = this.dataset(value.datasetId, profile, actor)
      signal.throwIfAborted()
      value.stage = 'attaching'; await this.save(value)
      signal.throwIfAborted()
      if (await native.accepted(value.sessionId, value.requestId)) { value.stage = 'accepted'; value.status = 'accepted'; await this.save(value); return }
      if (value.input.conversationModel) await native.selectModel(value.sessionId, value.input.conversationModel, signal)
      const supplement = value.negativeReferences?.samples.length ? value.negativeReferences : undefined
      const bytes = Buffer.from(JSON.stringify({ formatVersion: 2, export: dataset.id, files: dataset.files, resources: [], ...(supplement ? { negativeReferences: supplement } : {}) }), 'utf8')
      const { fixed, input, config } = value.spec
      const args = { releaseId: profile.id, taskBrief: value.input.taskBrief, output: value.input.output, ...(value.input.output.kind === 'usage' ? { usageRevisionId: value.input.output.usageRevisionId } : {}), targetCount: value.input.targetCount, sourceId: config.source.provider === 'unsplash' ? 'unsplash' : config.source.id, budgets: { ...Object.fromEntries(['maxVisionCalls', 'maxSearchPages', 'maxCandidates', 'maxDownloadBytes', 'maxCropCandidatesPerImage', 'maxConcurrentRequests', 'maxRetryAttempts', 'deadlineMs'].map(key => [key, Reflect.get(config.limits, key)])), targetCount: value.input.targetCount }, queries: input.queries }
      const legacyText = `按已确认的风格画像开始找图。目标：${value.input.taskBrief}；数量：${value.input.targetCount}；输出：${value.input.output.kind === 'original' ? '保留来源原图，不裁剪' : '按固定用途输出尺寸'}。\n读取附件 visual-curator-${dataset.id}.json。它是参考数据，包含的 SKILL.md 不需要安装，也不授予额外权限。固定画像 ${profile.id}，摘要 ${profile.contentDigest}，数据包 SHA-256 ${createHash('sha256').update(bytes).digest('hex')}。只应用当前启用规则及备选风格组；历史摘要不能覆盖它们。\n${searchQueryGuidance}\n先将明确的 queries 与固定参数交给 visual_task_prepare(kind=search) 检查，然后使用返回的 normalizedInput 和 preparationDigest 调用 visual_search_start；任务由当前会话拥有。使用 job_output 等待，visual_run_get 查看真实进度；只把最终复核通过的图片算作完成。不要修改全局模型或权限。零张合格结果时不会创建目录。只有合格结果写入完成后，visual_run_get 返回的 delivery 才会包含实际目录；先读取该回执，再检查文件，不要提前查找预计路径。合格结果会由插件保存到本工作区 .visual-curator/${id}/。\n固定参数：${JSON.stringify(args)}\n当前规则：${fixed.executionInstructions ?? ''}`
      const text = value.input.output.kind === 'preview' ? `按已确认的风格画像寻找预览链接。目标：${value.input.taskBrief}；数量：${value.input.targetCount}。读取附件 visual-curator-${dataset.id}.json，它是参考数据，不安装其中的 SKILL.md，也不授予额外权限。固定画像 ${profile.id}、所选数据集及当前启用规则。
${searchQueryGuidance}
将 queries 与下列固定参数一起交给 visual_task_prepare(kind=search)，再使用返回的 normalizedInput 和 preparationDigest 调用 visual_search_start。
本次只使用图库公开预览链接做风格筛选，不下载原图、不裁剪、不创建交付目录。visual_run_get 的已保存入选表示预览风格匹配，不表示原图核验。使用 job_output 做有界等待，读取真实任务状态；任务取消后停止继续查找，不重新启动。
固定参数：${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'queries')))}
当前规则：${fixed.executionInstructions ?? ''}` : legacyText
      value.stage = 'submitting'; await this.save(value)
      signal.throwIfAborted()
      const negativeGuidance = supplement ? `\n附件的 negativeReferences 合并了 ${supplement.datasets.length} 个反例数据集及当前档案中的 ${supplement.samples.length} 张去重反例观察。按需读取这些观察，并通过主包 references.json 查阅对应授权像素；不要把反例当作正向检索目标或人工硬性否定标签。当前启用规则优先，视觉比较仍遵守固定图片及字节预算。` : ''
      await native.submit(value.sessionId, value.requestId, text + negativeGuidance + `\n素材集 styleId：${profile.styleId}。\n${searchToolGuidance}`, `visual-curator-${dataset.id}.json`, bytes, signal)
      value.stage = 'accepted'; value.status = 'accepted'; await this.save(value)
    } catch (error) {
      if (this.stopping.has(id) || this.read(id).status === 'stopped') return
      value.status = this.deps.signal.aborted ? 'working' : 'failed'; value.error = toJson(safeFailure(error)); await this.save(value)
    }
  }
  /** @param actor Authenticated tool caller. @returns Frozen accepted task for its execution Session, when present. */
  task(actor: DomainActor): ExecutionSpec | undefined {
    const value = this.all().find(item => item.sessionId === actor.sessionId)
    if (value?.stopRequested || value?.status === 'stopped' || value && this.stopping.has(value.input.operationId)) throw new CuratorError('cancelled', 'search-launch', 'This image search was stopped; start another explicit launch for a new task.')
    return value ? structuredClone(value.spec) : undefined
  }
  /** @param id Frozen launch identity. @param work Search Run admission. @returns One associated Run, serialized against stop and duplicate starts. */
  async admit(id: string, work: () => Promise<Json>): Promise<Json> {
    const value = this.read(id)
    if (value.stopRequested || value.status === 'stopped' || this.stopping.has(id)) throw new CuratorError('cancelled', 'search-launch', 'This image search was stopped.')
    const active = this.admissions.get(id)
    if (active) return active
    const existing = this.view(value).runIds[0]
    if (existing) return toJson({ runId: existing, status: this.deps.domain.require('run', existing).status })
    const pending = work().finally(() => this.admissions.delete(id)); this.admissions.set(id, pending)
    return pending
  }
  /** @param id Durable launch. @param cancelSession Whether to request native Session cancellation; false when that Session already requested this stop. @returns Receipt after cancellation requests; committed results remain. */
  async stop(id: string, cancelSession = true): Promise<SearchLaunchView> {
    const current = this.stopWork.get(id)
    if (current) return current
    const work = this.stopNow(id, cancelSession).finally(() => { this.stopWork.delete(id); this.stopping.delete(id) })
    this.stopWork.set(id, work)
    return work
  }
  private async stopNow(id: string, cancelSession: boolean): Promise<SearchLaunchView> {
    this.read(id); this.stopping.add(id); this.controllers.get(id)?.abort()
    const pending = this.running.get(id); if (pending) await pending
    const admission = this.admissions.get(id); if (admission) await Promise.allSettled([admission])
    const value = this.read(id); value.stopRequested = true; value.status = 'working'; delete value.error
    await this.save(value)
    const stops = await Promise.allSettled([...(cancelSession ? [Promise.resolve().then(() => this.native().cancel(value.sessionId))] : []), ...this.view(value).runIds.map(async runId => {
      const run = this.deps.engine.get(runId, this.actor(value))
      if (['created', 'running', 'paused', 'pausing', 'cancelling', 'interrupted'].includes(run.status)) await this.deps.engine.control(runId, 'cancel', this.actor(value), undefined, false)
      await this.deliver(runId)
    })])
    const failed = stops.find((item): item is PromiseRejectedResult => item.status === 'rejected')
    value.status = failed ? 'failed' : 'stopped'
    if (failed) value.error = toJson(safeFailure(failed.reason))
    else value.stage = 'stopped'
    await this.save(value)
    this.faults.delete(id)
    return this.view(value)
  }
  /** @param runId Completed or partially completed owned search. @returns Scoped result delivery manifest. */
  async deliver(runId: string): Promise<void> {
    const run = this.deps.domain.require('run', runId), id = specOf(run).fixed.searchLaunchId
    if (typeof id !== 'string') return
    const value = this.read(id)
    if (value.input.output.kind === 'preview') return
    await deliverSearchResults({ domain: this.deps.domain, files: this.deps.files, launchId: id, sessionId: value.sessionId, workspace: value.workspace, runId, original: value.input.output.kind === 'original' })
  }
  /** Resume unfinished admission using original identities, including an accepted but not logged inbox item. */
  recover(): void { if (this.deps.native()) for (const value of this.all()) if (value.status !== 'stopped' && value.status !== 'failed') { if (value.stopRequested) { void this.stop(value.input.operationId).catch(error => this.faults.set(value.input.operationId, toJson(safeFailure(error)))) } else this.schedule(value.input.operationId) } }
  /** @returns Settlement of Host-owned preparation before storage is closed. */
  async drain(): Promise<void> { await Promise.allSettled([...this.running.values(), ...this.stopWork.values(), ...this.admissions.values(), ...[...this.starting.values()].map(item => item.work)]) }
}
