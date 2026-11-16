/** The supplied pull/receive protocol has no lease, immutable revision or receipt-query operation. */
import { randomUUID, createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { rasterMime, type AssetFiles } from '../media/assets.ts'
import { SafeHttpClient, type HttpClient } from '../media/network.ts'
import type { DomainActor, Json, RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { directCropStartSchema } from '../shared/direct-crop.ts'
import { serverImageComplete, serverImageIdSchema, serverPullSchema, serverQueueApiUrl, serverQueueSettingsSchema, serverTransferStatusSchema, type ServerImage, type ServerImportView, type ServerQueueSettings, type ServerQueueView, type ServerTransferView } from '../shared/server-queue.ts'
import type { CuratorConfig } from './config.ts'
import { importedRecords } from './imports.ts'
import { DirectCropTasks, isDirectCropRun } from './direct-crop.ts'
import { dataOf, safeFailure, specOf, toJson, type RunEngine } from './runtime.ts'
import { wallpaperAcceptsWork, wallpaperRunState } from './wallpaper-state.ts'

const settingsKey = 'server-queue:settings-v1'
const importedSchema = z.object({ version: z.literal(1), imageVersionId: z.string().optional(), previewImageVersionId: z.string().optional(), sourceDigest: z.string().optional(), errorCode: z.string().optional() })
const transferSchema = z.object({ version: z.literal(1), status: serverTransferStatusSchema, outputDigest: z.string(), runId: z.string(), receiptIds: z.array(serverImageIdSchema).optional(), message: z.string().optional(), response: z.unknown().optional() })
const ownerSchema = z.object({ version: z.literal(1), rootRunId: z.string() })
const bindingSchema = z.object({ version: z.literal(1), environment: z.string(), rootRunId: z.string(), items: z.array(z.object({ id: serverImageIdSchema, sourceVersion: z.string(), imageVersionId: z.string(), sourceDigest: z.string() })) })
const snapshotSchema = z.object({ version: z.literal(1), environment: z.string(), snapshotId: z.string(), total: z.number(), items: z.array(serverPullSchema.shape.data.element), pendingIds: z.array(serverImageIdSchema).optional(), changedIds: z.array(serverImageIdSchema).optional() })
const admissionInputSchema = z.strictObject({ operationId: z.string().min(1), snapshotId: z.string(), name: z.string().trim().min(1).max(160), ids: z.array(serverImageIdSchema).min(1), imageRoute: directCropStartSchema.shape.imageRoute })
const admissionSchema = z.object({ version: z.literal(1), environment: z.string(), runId: z.string(), input: admissionInputSchema, status: z.enum(['importing', 'failed', 'interrupted', 'ready']), createdAt: z.string(), errorCode: z.string().optional() })
const sourceVersion = (item: ServerImage) => contentDigest({ id: item.id, url: item.img_url, md5: item.md5 ?? null, size: item.size ?? null, updated: item.update_time ?? null })
const environmentOf = (settings: ServerQueueSettings) => contentDigest({ baseUrl: settings.baseUrl, auth: settings.auth })
const sourceKey = (environment: string, item: Pick<ServerImage, 'id'>, version: string) => contentDigest({ environment, id: item.id, version }).slice(10)
const receiptId = z.union([serverImageIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)])
const uploadReceiptSchema = z.object({ success: z.literal(true), data: z.object({ total: z.number().int().positive(), updated: z.number().int().nonnegative(), failed: z.literal(0), skipped: z.literal(0), results: z.array(z.object({ index: z.number().int().nonnegative(), id: receiptId, status: z.literal('updated') })) }) })
function acceptedReceipt(value: unknown, ids: readonly string[]): boolean {
  const parsed = uploadReceiptSchema.safeParse(value)
  if (!parsed.success) return false
  const receipt = parsed.data.data
  return receipt.total === ids.length && receipt.updated === ids.length && receipt.results.length === ids.length && new Set(receipt.results.map(row => row.index)).size === ids.length && receipt.results.every(row => ids[row.index] === row.id)
}

function savedReceipt(value: unknown, token: string, depth = 0): Json {
  if (depth > 8) return '[truncated]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]').replace(/https?:\/\/[^\s]+/g, '[redacted-url]').slice(0, 4096)
  if (Array.isArray(value)) return value.slice(0, 64).map(item => savedReceipt(item, token, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, field]) => [key, /token|secret|password|authorization|cookie/i.test(key) ? '[redacted]' : savedReceipt(field, token, depth + 1)]))
  return null
}

/** Profile-owned imports and transmissions use the existing strict original-processing workflow. */
export interface ServerQueueDependencies {
  domain: CuratorDomain; files: AssetFiles; engine: RunEngine; direct: DirectCropTasks
  config(): CuratorConfig
  credentials: Pick<CredentialProvider, 'resolve'>
  signal: AbortSignal
  http?(settings: ServerQueueSettings, media: boolean): HttpClient
}

/** No upload can be repeated after an uncertain response without an independently verified receipt. */
export class ServerQueue {
  private actions: Promise<void> = Promise.resolve()
  private deliveries: Promise<void> = Promise.resolve()
  private readonly progress = new Map<string, { receivedBytes: number; totalBytes?: number }>()
  private readonly admissionFailures = new Map<string, string>()
  /** Whether any server admission can still publish originals, including another saved server environment. */
  get importing(): boolean { return this.deps.domain.repository.manifests('server-admission:').some(row => { const admission = admissionSchema.parse(row.state); return admission.status === 'importing' && !this.admissionFailures.has(admission.runId) }) }
  constructor(private readonly deps: ServerQueueDependencies) {}

  private owner(actor: DomainActor): void {
    if (actor.kind !== 'human' || actor.profileId !== this.deps.domain.profileId) throw new CuratorError('owner-denied', 'server-queue', 'Server image actions require the profile owner.')
  }
  private settings(): ServerQueueSettings { return serverQueueSettingsSchema.parse(this.deps.domain.repository.manifest(settingsKey)?.state ?? this.deps.config().serverQueue ?? {}) }
  private async save(key: string, value: unknown): Promise<void> {
    const previous = this.deps.domain.repository.manifest(key)
    await this.deps.domain.repository.commit({ aggregateId: key, expectedRevision: previous?.revision ?? 0, operationId: randomUUID(), request: toJson(value), records: [], state: toJson(value) })
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.actions.then(work); this.actions = result.then(() => {}, () => {}); return result
  }
  private client(settings: ServerQueueSettings, media = false): HttpClient {
    if (this.deps.http) return this.deps.http(settings, media)
    if (media) return new SafeHttpClient({ allowedOrigins: settings.allowedMediaOrigins })
    const apiOrigin = new URL(settings.baseUrl).origin
    return new SafeHttpClient({ allowedOrigins: [apiOrigin], ...(settings.allowPrivateApi ? { localServerOrigin: apiOrigin } : {}) })
  }
  private validSettings(settings: ServerQueueSettings): void {
    if (!settings.baseUrl || !settings.allowedMediaOrigins.length || new URL(settings.baseUrl).protocol !== 'https:' && !settings.allowPrivateApi) throw new CuratorError('configuration-required', 'server-settings', 'Configure the server base URL, authentication and permitted HTTPS image origins; explicitly enable local API access for an HTTP test service.')
  }
  private async token(settings: ServerQueueSettings): Promise<string> {
    if (settings.auth.kind === 'credential') {
      const value = await this.deps.credentials.resolve(credentialRef(settings.auth.ref))
      if (!value?.value) throw new CuratorError('configuration-required', 'server-auth', 'The configured server credential is unavailable.')
      return value.value
    }
    const path = settings.auth.path
    if (!isAbsolute(path)) throw new CuratorError('configuration-required', 'server-auth', 'Choose an absolute path to the supplied Postman collection.')
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > this.deps.config().limits.maxResponseBytes) throw new Error('size')
      const request = z.object({ method: z.string(), url: z.object({ raw: z.string() }), body: z.object({ formdata: z.array(z.object({ key: z.string(), type: z.string(), value: z.string().optional() })).optional() }).optional() })
      const collection = z.object({ item: z.array(z.object({ request })) }).parse(JSON.parse(await readFile(path, 'utf8')))
      const uploadPath = serverQueueApiUrl(settings.baseUrl, 'receive').pathname
      const upload = collection.item.find(item => item.request.method === 'POST' && new URL(item.request.url.raw).pathname === uploadPath)?.request
        ?? collection.item.find(item => item.request.method === 'POST' && new URL(item.request.url.raw).pathname === '/OperateImage/receive.html')?.request
      const value = upload?.body?.formdata?.find(field => field.key === 'token' && field.type === 'text')?.value
      if (!value || value.includes('{{') || /[\r\n\0]/.test(value)) throw new Error('token')
      return value
    } catch (error) { throw new CuratorError('configuration-required', 'server-auth', 'The Postman collection has no readable literal upload token; the file and existing credentials were not changed.', { cause: error }) }
  }
  private validateImage(item: ServerImage, settings: ServerQueueSettings): void {
    const url = new URL(item.img_url)
    if (url.protocol !== 'https:' || !settings.allowedMediaOrigins.includes(url.origin) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|secret|signature|authorization|cookie/i.test(key)) || item.md5 && !/^[a-f\d]{32}$/i.test(item.md5)) throw new CuratorError('source-protocol-error', 'server-pull', 'A server original has an unapproved location or invalid checksum; no substitute image was used.')
  }
  private bounds(signal: AbortSignal) {
    const limits = this.deps.config().limits
    return { signal: AbortSignal.any([signal, this.deps.signal]), maxBytes: limits.maxResponseBytes, timeoutMs: limits.requestTimeoutMs, maxRedirects: 0 }
  }

  /** Recover interrupted transmissions as unknown; saved outputs and successful receipts remain immutable. */
  async initialize(): Promise<void> {
    for (const manifest of this.deps.domain.repository.manifests('server-transfer:')) {
      const transfer = transferSchema.parse(manifest.state)
      if (transfer.status === 'uploading') await this.save(manifest.aggregateId, { ...transfer, status: 'unknown', message: 'interrupted-upload' })
    }
    for (const manifest of this.deps.domain.repository.manifests('server-admission:')) {
      const admission = admissionSchema.parse(manifest.state)
      if (admission.status === 'importing') await this.save(manifest.aggregateId, { ...admission, status: this.deps.domain.repository.get('run', admission.runId) ? 'ready' : 'interrupted' })
    }
  }
  /** @param actor Profile reader. @returns Pending and interrupted admissions, including verified saved originals and live download bytes. */
  imports(actor: DomainActor): ServerImportView[] {
    this.owner(actor)
    const environment = environmentOf(this.settings()), raw = this.deps.domain.repository.manifest('server-snapshot:' + environment)?.state
    const snapshot = raw ? snapshotSchema.parse(raw) : undefined
    return this.deps.domain.repository.manifests('server-admission:').map(row => admissionSchema.parse(row.state)).filter(row => row.environment === environment && row.status !== 'ready' && !this.deps.domain.repository.manifest('server-admission-hidden:' + row.runId) && !this.deps.domain.repository.get('run', row.runId)).map(row => {
      const sources = row.input.ids.map(id => snapshot?.items.find(item => item.id === id)).filter(item => item !== undefined)
      const saved = sources.filter(item => importedSchema.safeParse(this.deps.domain.repository.manifest('server-import:' + sourceKey(environment, item, sourceVersion(item)))?.state).data?.imageVersionId).length
      const errorCode = this.admissionFailures.get(row.runId) ?? row.errorCode
      return { runId: row.runId, name: row.input.name, status: this.admissionFailures.has(row.runId) ? 'failed' : row.status as ServerImportView['status'], saved, total: row.input.ids.length, receivedBytes: sources.reduce((sum, item) => sum + (this.progress.get(sourceKey(environment, item, sourceVersion(item)))?.receivedBytes ?? 0), 0), ...(errorCode ? { errorCode } : {}) }
    })
  }
  /** @param actor Profile reader. @returns Current import, processing and upload states without authentication values. */
  read(actor: DomainActor): ServerQueueView {
    this.owner(actor)
    const settings = this.settings(), environment = environmentOf(settings), raw = this.deps.domain.repository.manifest('server-snapshot:' + environment)?.state
    const snapshot = raw ? snapshotSchema.parse(raw) : undefined
    const importing = this.deps.domain.repository.manifests('server-admission:').map(row => admissionSchema.parse(row.state)).filter(row => row.environment === environment && row.status === 'importing' && !this.deps.domain.repository.get('run', row.runId))
    const bindings = this.deps.domain.repository.manifests('server-binding:').map(manifest => bindingSchema.parse(manifest.state)).filter(binding => binding.environment === environment)
    return { settings, snapshotId: snapshot?.snapshotId ?? '', total: snapshot?.total ?? 0, pendingKnown: snapshot?.pendingIds !== undefined, imports: this.imports(actor), items: (snapshot?.items ?? []).map(item => {
      const version = sourceVersion(item), key = sourceKey(environment, item, version), rawImport = this.deps.domain.repository.manifest('server-import:' + key)?.state
      const saved = rawImport ? importedSchema.parse(rawImport) : undefined
      const binding = this.currentBinding(environment, item.id, version, bindings)
      const latest = binding ? this.latest(binding.rootRunId) : undefined
      const currentItem = latest && wallpaperRunState(this.deps.domain, latest).items.find(row => row.imageVersionId === saved?.imageVersionId), status = currentItem?.status
      const rawTransfer = this.deps.domain.repository.manifest('server-transfer:' + key)?.state, transfer = rawTransfer ? transferSchema.parse(rawTransfer) : undefined
      const outputId = currentItem?.attempts.at(-1)?.outputId, output = outputId ? this.deps.domain.repository.get('imageVersion', outputId) : undefined
      const admission = importing.find(row => row.input.ids.includes(item.id))
      const preview = saved?.imageVersionId ? { imageVersionId: saved.previewImageVersionId ?? saved.imageVersionId } : { serverImageId: item.id, serverSnapshotId: snapshot!.snapshotId }
      return { id: item.id, ...(snapshot?.pendingIds ? { serverPending: snapshot.pendingIds.includes(item.id) } : {}), name: item.name || item.title || item.id, imported: !!saved?.imageVersionId, ...(saved?.imageVersionId ? { imageVersionId: saved.imageVersionId } : {}), previewPath: '/api/visual-curator/resource?' + new URLSearchParams(preview), ...(latest && binding ? { runId: binding.rootRunId } : {}), ...(admission ? { importRunId: admission.runId } : {}), phase: this.progress.has(key) ? 'downloading' : status === 'passed' ? 'approved' : status && ['technical-failed', 'rejected', 'needs-review'].includes(status) ? 'attention' : latest && !['completed', 'failed', 'cancelled'].includes(latest.status) ? 'processing' : saved?.imageVersionId ? 'saved' : 'waiting', ...this.progress.get(key), ...(saved?.errorCode ? { errorCode: saved.errorCode } : {}), ...(snapshot?.changedIds?.includes(item.id) ? { warning: 'server-record-changed' } : {}), ...(transfer ? { transfer: { status: transfer.status, outputDigest: transfer.outputDigest, current: status === 'passed' && output?.blob.digest === transfer.outputDigest, ...(transfer.message ? { message: transfer.message } : {}) } } : {}) }
    }) }
  }
  /** Read a queued image without importing it or changing its processing state.
   * @param id Server image identity. @param snapshotId Current queue snapshot. @param actor Profile reader. @param signal Request lifetime. @returns Bounded raster bytes held only for this response.
   */
  async preview(id: string, snapshotId: string, actor: DomainActor, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
    this.owner(actor)
    const settings = this.settings(), environment = environmentOf(settings)
    const snapshot = snapshotSchema.parse(this.deps.domain.repository.manifest('server-snapshot:' + environment)?.state)
    const imageId = serverImageIdSchema.parse(id), item = snapshot.items.find(item => item.id === imageId)
    if (snapshot.snapshotId !== snapshotId || !item) throw new CuratorError('reference-unavailable', 'server-preview', 'Refresh the server queue before opening this preview.')
    this.validateImage(item, settings)
    const response = await this.client(settings, true).request(item.img_url, { ...this.bounds(signal), method: 'GET', maxBytes: this.deps.config().limits.maxReferenceBytes, headers: { accept: 'image/jpeg,image/png,image/webp' } })
    const mime = rasterMime(response.bytes)
    return { bytes: response.bytes, mime }
  }
  /** @param runId Authorized canvas task. @param actor Profile reader. @returns Server-only transmission states for the same image versions, or absence for local and gallery tasks. */
  transfers(runId: string, actor: DomainActor): Record<string, ServerTransferView> | undefined {
    this.owner(actor)
    const run = this.deps.engine.get(runId, actor)
    if (!isDirectCropRun(run)) return undefined
    const root = z.string().parse(specOf(run).input.sourceRunId), raw = this.deps.domain.repository.manifest('server-binding:' + root)?.state
    if (!raw) return undefined
    const binding = bindingSchema.parse(raw), state = wallpaperRunState(this.deps.domain, run)
    return Object.fromEntries(binding.items.map(source => {
      const saved = this.deps.domain.repository.manifest('server-transfer:' + sourceKey(binding.environment, source, source.sourceVersion))?.state
      const item = state.items.find(item => item.imageVersionId === source.imageVersionId)
      if (!saved) return [source.imageVersionId, binding.environment === environmentOf(this.settings()) ? { status: 'waiting' as const, current: item?.status === 'passed' } : { status: 'failed' as const, current: false, message: 'configuration-required' }]
      const transfer = transferSchema.parse(saved), outputId = item?.attempts.at(-1)?.outputId, output = outputId ? this.deps.domain.repository.get('imageVersion', outputId) : undefined
      return [source.imageVersionId, { status: transfer.status, outputDigest: transfer.outputDigest, current: item?.status === 'passed' && output?.blob.digest === transfer.outputDigest, ...(transfer.message ? { message: transfer.message } : {}) }]
    }))
  }
  /** @param raw Explicit connection fields. @param actor Profile owner. @returns Saved connection and recovery of never-sent approved outputs; accounts and credentials are unchanged. */
  configure(raw: unknown, actor: DomainActor): Promise<ServerQueueView> {
    return this.serial(async () => { this.owner(actor); const settings = serverQueueSettingsSchema.parse(raw); this.validSettings(settings); await this.save(settingsKey, settings); await this.recover(); return this.read(actor) })
  }
  private async pending(settings: ServerQueueSettings, token: string, signal: AbortSignal) {
    const url = serverQueueApiUrl(settings.baseUrl, 'pull'); url.searchParams.set('token', token)
    const response = await this.client(settings).request(url.href, { ...this.bounds(signal), method: 'GET', headers: { accept: 'application/json' } })
    let reply: z.infer<typeof serverPullSchema>
    try { reply = serverPullSchema.parse(JSON.parse(response.bytes.toString('utf8'))) }
    catch (error) { throw new CuratorError('source-protocol-error', 'server-pull', 'The server did not return a valid pending-image list.', { cause: error }) }
    if (reply.data.length > this.deps.config().limits.maxCandidates || reply.total < reply.data.length || new Set(reply.data.map(item => item.id)).size !== reply.data.length) throw new CuratorError('source-protocol-error', 'server-pull', 'The server queue has inconsistent counts, exceeds its item limit or repeats an image identity.')
    for (const item of reply.data) this.validateImage(item, settings)
    return reply
  }
  /** @param actor Profile owner. @param signal Read lifetime. @returns Actual bounded server queue; GET has no request body. */
  pull(actor: DomainActor, signal: AbortSignal): Promise<ServerQueueView> {
    return this.serial(async () => {
      this.owner(actor); const settings = this.settings(); this.validSettings(settings)
      const reply = await this.pending(settings, await this.token(settings), signal), environment = environmentOf(settings)
      const previous = this.deps.domain.repository.manifest('server-snapshot:' + environment), saved = previous ? snapshotSchema.parse(previous.state) : undefined
      const ownedIds = new Set(this.deps.domain.repository.manifests('server-binding:').map(manifest => bindingSchema.parse(manifest.state)).filter(binding => binding.environment === environment).flatMap(binding => binding.items.map(item => item.id)))
      const retained = saved?.items.filter(item => ownedIds.has(item.id)) ?? []
      const changedIds = retained.filter(item => { const fresh = reply.data.find(row => row.id === item.id); return !!fresh && sourceVersion(fresh) !== sourceVersion(item) }).map(item => item.id)
      const items = [...reply.data.map(item => retained.find(prior => prior.id === item.id) ?? item), ...retained.filter(item => !reply.data.some(fresh => fresh.id === item.id))], snapshotId = contentDigest({ pending: reply.data, items, changedIds })
      await this.save('server-snapshot:' + environment, { version: 1, environment, snapshotId, total: reply.total, items, pendingIds: reply.data.map(item => item.id), changedIds })
      return this.read(actor)
    })
  }
  private latest(rootRunId: string): RunRecord | undefined {
    return this.deps.domain.repository.list('run').filter(run => isDirectCropRun(run) && specOf(run).input.sourceRunId === rootRunId).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
  }
  private currentBinding(environment: string, id: ServerImage['id'], version: string, bindings = this.deps.domain.repository.manifests('server-binding:').map(row => bindingSchema.parse(row.state))) {
    const raw = this.deps.domain.repository.manifest('server-owner:' + sourceKey(environment, { id }, version))?.state
    // Released bindings had exclusive ownership before reselection was supported.
    const root = raw ? ownerSchema.parse(raw).rootRunId : undefined
    return bindings.find(binding => binding.environment === environment && (root === undefined || binding.rootRunId === root) && binding.items.some(item => item.id === id && item.sourceVersion === version))
  }

  /** Persist admission before downloading originals; browser disconnects do not cancel accepted work.
   * @param raw Selected server IDs and snapshot identity. @param actor Profile owner. @param signal Admission acknowledgement lifetime. @returns Stable batch identity while imports continue in the Host.
   */
  start(raw: unknown, actor: DomainActor, signal: AbortSignal): Promise<{ runId: string }> {
    return this.serial(async () => {
      this.owner(actor); signal.throwIfAborted()
      const input = admissionInputSchema.parse(raw), settings = this.settings(), environment = environmentOf(settings)
      this.validSettings(settings)
      const runId = this.deps.engine.operationRunId(input.operationId, actor), key = 'server-admission:' + runId
      const rawSaved = this.deps.domain.repository.manifest(key)?.state, prior = rawSaved ? admissionSchema.parse(rawSaved) : undefined
      if (prior && this.deps.domain.repository.manifest('server-admission-hidden:' + runId)) throw new CuratorError('operation-conflict', 'server-import', 'Start a new admission for an archived selection.')
      if (prior && (prior.environment !== environment || contentDigest(prior.input) !== contentDigest(input))) throw new CuratorError('operation-conflict', 'server-start', 'The admission identity already belongs to another selection.')
      if (prior?.status === 'ready' || prior?.status === 'importing' && !this.admissionFailures.has(runId)) return { runId }
      const snapshot = snapshotSchema.parse(this.deps.domain.repository.manifest('server-snapshot:' + environment)?.state)
      if (snapshot.snapshotId !== input.snapshotId || input.ids.length > this.deps.config().limits.maxImportFiles || new Set(input.ids).size !== input.ids.length || input.ids.some(id => !snapshot.items.some(item => item.id === id))) throw new CuratorError('revision-conflict', 'server-start', 'Refresh the server queue and select distinct current images.')
      const admission = { version: 1 as const, runId, environment, input, status: 'importing' as const, createdAt: prior?.createdAt ?? new Date().toISOString() }
      // Ownership changes and POST intents share one queue so a new selection cannot race a send.
      const claim = this.deliveries.then(async () => {
        if (this.read(actor).items.some(item => input.ids.includes(item.id) && serverImageComplete(item))) throw new CuratorError('constraint-conflict', 'server-start', 'The latest approved result is already confirmed by the server.')
        await this.save(key, admission); this.admissionFailures.delete(runId)
        for (const id of input.ids) {
          const item = snapshot.items.find(item => item.id === id)!
          await this.save('server-owner:' + sourceKey(environment, item, sourceVersion(item)), { version: 1, rootRunId: runId })
        }
      })
      this.deliveries = claim.then(() => {}, () => {}); await claim
      const background = this.serial(async () => {
        try {
          if (environmentOf(this.settings()) !== environment) throw new CuratorError('revision-conflict', 'server-import', 'Restore the original server connection before continuing this import.')
          await this.startNow(input, actor, this.deps.signal)
          await this.save(key, { ...admission, status: 'ready' })
        } catch (error) { await this.save(key, { ...admission, status: this.deps.signal.aborted ? 'interrupted' : 'failed', errorCode: safeFailure(error).code }) }
      })
      void background.catch(error => { this.admissionFailures.set(runId, safeFailure(error).code) })
      return { runId }
    })
  }
  /** Hide a failed admission while retaining originals, bindings and delivery receipts.
   * @param raw Admission identity. @param actor Profile owner. @returns Idempotent list-removal receipt.
   */
  removeImport(raw: unknown, actor: DomainActor): Promise<{runId: string; deleted: true}> {
    return this.serial(async () => {
      this.owner(actor)
      const {runId}=z.strictObject({runId:z.string().min(1),operationId:z.string().optional()}).parse(raw),key='server-admission-hidden:'+runId
      const record=admissionSchema.parse(this.deps.domain.repository.manifest('server-admission:'+runId)?.state)
      if(record.environment!==environmentOf(this.settings()))throw new CuratorError('owner-denied','server-import-delete','Open the original connection before removing this admission.')
      if(this.deps.domain.repository.manifest(key))return {runId,deleted:true}
      if(!['failed','interrupted'].includes(record.status)||this.deps.domain.repository.get('run',runId))throw new CuratorError('constraint-conflict','server-import-delete','Only failed or interrupted original imports may be removed.')
      await this.save(key,{version:1,runId});return {runId,deleted:true}
    })
  }
  /** @param raw Saved admission identity. @param actor Profile owner. @param signal Acknowledgement lifetime. @returns The same batch identity; verified originals are reused. */
  retryImport(raw: unknown, actor: DomainActor, signal: AbortSignal): Promise<{ runId: string }> {
    this.owner(actor)
    const { runId } = z.strictObject({ runId: z.string().min(1) }).parse(raw)
    const admission = admissionSchema.parse(this.deps.domain.repository.manifest('server-admission:' + runId)?.state)
    if (admission.environment !== environmentOf(this.settings()) || admission.status === 'ready') throw new CuratorError('revision-conflict', 'server-import', 'Open this admission under its original server connection.')
    return this.start(admission.input, actor, signal)
  }
  /** @param raw Selected server IDs and snapshot identity. @param actor Profile owner. @param signal Import lifetime. @returns The existing or newly admitted crop batch; retries retain verified originals. */
  private async startNow(raw: unknown, actor: DomainActor, signal: AbortSignal): Promise<{ runId: string }> {
    this.owner(actor)
    const input = admissionInputSchema.parse(raw)
    const settings = this.settings(), environment = environmentOf(settings), limits = this.deps.config().limits
    const snapshot = snapshotSchema.parse(this.deps.domain.repository.manifest('server-snapshot:' + environment)?.state)
    if (snapshot.snapshotId !== input.snapshotId || input.ids.length > limits.maxImportFiles || new Set(input.ids).size !== input.ids.length) throw new CuratorError('revision-conflict', 'server-start', 'Refresh the server selection and choose a bounded set of distinct images.')
    const selected = input.ids.map(id => { const item = snapshot.items.find(item => item.id === id); if (!item) throw new CuratorError('revision-conflict', 'server-start', 'A selected image is absent from the saved queue.'); return item })
    const linkedSignal = AbortSignal.any([signal, this.deps.signal]), imported = new Map<string, { imageVersionId: string; sourceDigest: string }>()
    let cursor = 0, spent = 0, reserved = 0
    const failures: unknown[] = []
    await Promise.all(Array.from({ length: Math.min(settings.concurrency, limits.maxConcurrentRequests, selected.length) }, async () => {
      while (cursor < selected.length) {
        const item = selected[cursor++]!, version = sourceVersion(item), key = sourceKey(environment, item, version), aggregateId = 'server-import:' + key
        try {
          linkedSignal.throwIfAborted(); this.validateImage(item, settings)
          const previous = this.deps.domain.repository.manifest(aggregateId), prior = previous ? importedSchema.parse(previous.state) : undefined
          if (prior?.imageVersionId && prior.sourceDigest) { this.deps.domain.authorizedImage(prior.imageVersionId, actor); imported.set(item.id, { imageVersionId: prior.imageVersionId, sourceDigest: prior.sourceDigest }); continue }
          const bound = Math.min(limits.maxImportBytes, limits.maxDownloadBytes - spent - reserved)
          if (bound <= 0) throw new CuratorError('budget-exhausted', 'server-import', 'The selected original download budget is exhausted.')
          reserved += bound; this.progress.set(key, { receivedBytes: 0 })
          let bytes: Buffer
          try {
            const response = await this.client(settings, true).request(item.img_url, { ...this.bounds(linkedSignal), method: 'GET', maxBytes: bound, timeoutMs: limits.originalDownloadTimeoutMs ?? limits.requestTimeoutMs, ...(limits.originalDownloadIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: limits.originalDownloadIdleTimeoutMs }), maxRedirects: 0, onProgress: progress => this.progress.set(key, progress) })
            bytes = response.bytes; spent += bytes.length
          } finally { reserved -= bound }
          if (item.md5 && createHash('md5').update(bytes).digest('hex') !== item.md5.toLowerCase() || item.size && Number(item.size) !== bytes.length) throw new CuratorError('source-protocol-error', 'server-import', 'The downloaded original does not match its server checksum or byte count.')
          const files = await this.deps.files.importBytes(bytes, undefined, linkedSignal), created = importedRecords(actor.profileId, actor, files, { kind: 'provider', providerId: 'oppo-server-v1', providerAssetId: item.id, accountIdentity: environment, description: item.name, obtainedAt: new Date().toISOString() }, 'bytes-allowed')
          const saved = { version: 1, imageVersionId: created.image.id, previewImageVersionId: created.preview.id, sourceDigest: files.originalBlob.digest }
          await this.deps.domain.repository.commit({ aggregateId, expectedRevision: previous?.revision ?? 0, operationId: randomUUID(), request: { environment, id: item.id, sourceVersion: version }, records: created.records, state: saved })
          imported.set(item.id, saved)
        } catch (error) { failures.push(error); if (!linkedSignal.aborted) await this.save(aggregateId, { version: 1, errorCode: safeFailure(error).code }) }
        finally { this.progress.delete(key) }
      }
    }))
    if (failures.length) throw failures[0]
    const rootRunId = this.deps.engine.operationRunId(input.operationId, actor), key = 'server-binding:' + rootRunId
    const binding = { version: 1, environment, rootRunId, items: selected.map(item => ({ id: item.id, sourceVersion: sourceVersion(item), ...imported.get(item.id)! })) }
    const old = this.deps.domain.repository.manifest(key)
    if (old && contentDigest(old.state) !== contentDigest(binding)) throw new CuratorError('operation-conflict', 'server-start', 'The operation identity already belongs to another server selection.')
    if (!old) await this.save(key, binding)
    return await this.deps.direct.start({ operationId: input.operationId, name: input.name, ...(input.imageRoute === undefined ? {} : { imageRoute: input.imageRoute }), source: { kind: 'server', photos: selected.map(item => ({ id: imported.get(item.id)!.imageVersionId, title: item.name })) } }, actor, linkedSignal)
  }

  /** @param run Settled processing batch. @param imageVersionId Explicit upload-only retry, omitted for batch delivery. @returns Completion of serialized deliveries and receipt writes. */
  deliver(run: RunRecord, imageVersionId?: string): Promise<void> {
    const work = this.deliveries.then(() => this.deliverNow(run.id, imageVersionId)); this.deliveries = work.then(() => {}, () => {}); return work
  }
  private async deliverNow(runId: string, imageVersionId?: string): Promise<void> {
    const run = this.deps.domain.require('run', runId)
    if (!isDirectCropRun(run) || run.status !== 'completed') return
    const rootRunId = z.string().parse(specOf(run).input.sourceRunId), manifest = this.deps.domain.repository.manifest('server-binding:' + rootRunId)
    if (!manifest || !wallpaperAcceptsWork(this.deps.domain, run)) return
    const binding = bindingSchema.parse(manifest.state), settings = this.settings(), actor: DomainActor = { kind: 'human', id: 'profile-owner', profileId: this.deps.domain.profileId }
    if (environmentOf(settings) !== binding.environment || this.latest(rootRunId)?.id !== runId) return
    const state = wallpaperRunState(this.deps.domain, run), signal = this.deps.signal
    const ready: { source: z.infer<typeof bindingSchema>['items'][number]; key: string; bytes: Buffer; outputDigest: string }[] = []
    for (const source of binding.items) {
      if (imageVersionId !== undefined && source.imageVersionId !== imageVersionId) continue
      if (this.currentBinding(binding.environment, source.id, source.sourceVersion)?.rootRunId !== rootRunId) continue
      const item = state.items.find(item => item.imageVersionId === source.imageVersionId)
      if (item?.status !== 'passed') continue
      const key = 'server-transfer:' + sourceKey(binding.environment, source, source.sourceVersion), raw = this.deps.domain.repository.manifest(key)?.state
      const prior = raw ? transferSchema.parse(raw) : undefined
      if (prior && (prior.status === 'uploading' || prior.status === 'unknown' || prior.status === 'failed' && prior.runId === runId)) continue
      let approved
      try { approved = await this.deps.direct.approvedFile(run.id, source.imageVersionId, actor, signal) }
      catch (error) { if (signal.aborted) return; continue }
      if (prior?.status === 'uploaded' && prior.outputDigest === approved.image.blob.digest) continue
      const original = this.deps.domain.authorizedImage(source.imageVersionId, actor).asset.originalBlob
      if (original?.digest !== source.sourceDigest || approved.bytes.length > settings.maxUploadBytes) { await this.save(key, { version: 1, status: 'failed', outputDigest: approved.image.blob.digest, runId: run.id, message: 'source-or-upload-budget-mismatch' }); continue }
      ready.push({ source, key, bytes: approved.bytes, outputDigest: approved.image.blob.digest })
    }
    if (!ready.length) return
    let token: string, pending: ServerImage[]
    try { token = await this.token(settings); pending = (await this.pending(settings, token, signal)).data }
    catch (error) {
      for (const row of ready) await this.save(row.key, { version: 1, status: 'failed', outputDigest: row.outputDigest, runId, message: safeFailure(error).code })
      return
    }
    const verified: typeof ready = []
    for (const row of ready) {
      const fresh = pending.find(item => item.id === row.source.id)
      if (fresh && sourceVersion(fresh) === row.source.sourceVersion) verified.push(row)
      else await this.save(row.key, { version: 1, status: 'failed', outputDigest: row.outputDigest, runId, message: 'revision-conflict' })
    }
    // OperateImage permits at most 20 matching index pairs in one request.
    for (let offset = 0; offset < verified.length; offset += 20) {
      const batch = verified.slice(offset, offset + 20), ids = batch.map(row => row.source.id)
      const form = new FormData(); form.append('token', token)
      batch.forEach((row, index) => { form.append(`ids[${index}]`, row.source.id); form.append(`images[${index}]`, new Blob([new Uint8Array(row.bytes)], { type: 'image/png' }), row.source.id + '-' + row.outputDigest.slice(0, 12) + '.png') })
      const request = new Request(serverQueueApiUrl(settings.baseUrl, 'receive'), { method: 'POST', body: form }), body = new Uint8Array(await request.arrayBuffer())
      const current = this.deps.domain.require('run', runId)
      if (signal.aborted || current.status !== 'completed' || !wallpaperAcceptsWork(this.deps.domain, current) || this.latest(rootRunId)?.id !== runId || environmentOf(this.settings()) !== binding.environment || batch.some(row => this.currentBinding(binding.environment, row.source.id, row.source.sourceVersion)?.rootRunId !== rootRunId)) return
      for (const row of batch) await this.save(row.key, { version: 1, status: 'uploading', outputDigest: row.outputDigest, runId, receiptIds: ids })
      try {
        // The durable intent precedes the first POST; neither redirects nor transport retries are permitted.
        const response = await this.client(settings).request(request.url, { ...this.bounds(signal), method: 'POST', headers: { 'content-type': request.headers.get('content-type')!, accept: 'application/json' }, body })
        let parsed: unknown
        try { parsed = JSON.parse(response.bytes.toString('utf8')) } catch (error) { throw new CuratorError('source-protocol-error', 'server-upload', 'The server upload response was not JSON.', { cause: error }) }
        const rejected = z.object({ success: z.literal(false), data: z.array(z.unknown()).length(0) }).safeParse(parsed).success
        // A successful HTTP status alone never confirms file acceptance. Persist only protocol fields for local rechecking.
        const receipt = savedReceipt(parsed, token)
        const status = rejected ? 'failed' : acceptedReceipt(receipt, ids) ? 'uploaded' : 'unknown'
        for (const row of batch) await this.save(row.key, { version: 1, status, outputDigest: row.outputDigest, runId, receiptIds: ids, ...(receipt ? { response: receipt } : {}), ...(status === 'uploaded' ? {} : { message: status === 'failed' ? 'server-rejected' : 'unrecognized-receipt' }) })
      } catch (error) {
        for (const row of batch) await this.save(row.key, { version: 1, status: 'unknown', outputDigest: row.outputDigest, runId, receiptIds: ids, message: safeFailure(error).code })
      }
    }
  }
  /** Resume never-sent approved deliveries after restart; unknown and completed transmissions are not repeated. */
  async recover(): Promise<void> {
    for (const manifest of this.deps.domain.repository.manifests('server-binding:')) {
      const binding = bindingSchema.parse(manifest.state), latest = this.latest(binding.rootRunId)
      if (latest?.status === 'completed') await this.deliver(latest)
    }
  }
  /** @param raw Exact server image and root batch. @param actor Profile owner. @param retry True only for a previously explicit rejection or pre-send failure. @returns Rechecked or retried transmission state; image generation is never invoked. */
  transmission(raw: unknown, actor: DomainActor, retry: boolean): Promise<ServerQueueView> {
    return this.serial(() => this.transmissionNow(raw, actor, retry))
  }
  private async transmissionNow(raw: unknown, actor: DomainActor, retry: boolean): Promise<ServerQueueView> {
    this.owner(actor)
    const input = z.strictObject({ runId: z.string(), id: serverImageIdSchema }).parse(raw), settings = this.settings()
    const binding = bindingSchema.parse(this.deps.domain.repository.manifest('server-binding:' + input.runId)?.state), latest = this.latest(input.runId)
    if (binding.environment !== environmentOf(settings) || !latest) throw new CuratorError('revision-conflict', 'server-upload', 'Restore the server connection and open the latest image batch.')
    const source = binding.items.find(item => item.id === input.id)
    if (!source) throw new CuratorError('owner-denied', 'server-upload', 'This server image does not belong to the selected batch.')
    if (retry) {
      if (this.currentBinding(binding.environment, source.id, source.sourceVersion)?.rootRunId !== input.runId) throw new CuratorError('revision-conflict', 'server-upload', 'A newer batch owns this server image.')
      const key = 'server-transfer:' + sourceKey(binding.environment, source, source.sourceVersion), previous = transferSchema.parse(this.deps.domain.repository.manifest(key)?.state)
      if (previous.status !== 'failed') throw new CuratorError('constraint-conflict', 'server-upload', 'An uncertain or completed upload cannot be sent again.')
      const approved = await this.deps.direct.approvedFile(latest.id, source.imageVersionId, actor, this.deps.signal)
      if (previous.outputDigest !== approved.image.blob.digest) throw new CuratorError('revision-conflict', 'server-upload', 'The latest approved file differs from this transmission; verify the server record first.')
      await this.save(key, { ...previous, status: 'waiting' }); await this.deliver(latest, source.imageVersionId)
    } else {
      const key = 'server-transfer:' + sourceKey(binding.environment, source, source.sourceVersion), raw = this.deps.domain.repository.manifest(key)?.state
      const previous = raw ? transferSchema.parse(raw) : undefined
      if (previous?.status === 'unknown' && acceptedReceipt(previous.response, previous.receiptIds ?? [source.id])) {
        const { message: _message, ...confirmed } = previous
        await this.save(key, { ...confirmed, status: 'uploaded' })
      }
    }
    return this.read(actor)
  }
  /** @returns Completion after admitted actions and active uploads have stopped. */
  async drain(): Promise<void> { await Promise.all([this.actions, this.deliveries]) }
}
