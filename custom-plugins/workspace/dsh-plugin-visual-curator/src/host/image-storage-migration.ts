/** Profile-owned background migration keeps relative image identities and commits the directory switch only after verification. */
import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import { z } from 'zod'
import type { JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { DomainRepository } from '../domain/repository.ts'
import { contentDigest } from '../domain/repository.ts'
import type { AssetFiles } from '../media/assets.ts'
import { checkCancelled, MediaError } from '../media/errors.ts'
import { checkedStorageDirectory, checkMigrationSpace, copyStorageFile, imageStorageInventory, isImageStorageBlob, ownedStorageDirectory, prepareStorageDirectory, removeTransferredFile, storageMigrationFileSchema, verifyStorageFile } from '../media/storage-directory.ts'
import { imageStorageMigrationIdSchema, imageStorageMigrationSchema, imageStorageUsageSchema } from '../shared/image-storage.ts'
import { CuratorError } from '../shared/errors.ts'
import { referencedImageStorageFiles } from './image-storage.ts'
import { safeFailure, toJson } from './runtime.ts'

const key = 'image-storage-location:v1'
const savedMigrationSchema = imageStorageMigrationSchema.extend({ files: z.array(storageMigrationFileSchema), autoResume: z.boolean() })
const stateSchema = z.strictObject({ version: z.literal(1), directory: z.string().min(1), usage: imageStorageUsageSchema, migration: savedMigrationSchema })
type State = z.infer<typeof stateSchema>
type Usage = z.infer<typeof imageStorageUsageSchema>

/** One profile location and its resumable transfer; the default profile writer lock never moves. */
export class ImageStorageMigration {
  private state: State | undefined
  private live: { controller: AbortController; done: Promise<JobOutcome>; cancelledByUser: boolean } | undefined
  private admitting = false
  private pendingRecovery = false
  private stopping = false
  /** @param dependencies Existing profile writer, private files, background jobs and Host lifetime. */
  constructor(private readonly dependencies: { profileId: string; defaultDirectory: string; repository(): DomainRepository; readUsage(): Promise<Usage>; files: AssetFiles; jobs: Pick<JobRegistry, 'start'>; signal: AbortSignal; settled(): Promise<void> }) {}
  /** Whether new image work must wait for transfer or an unresolved location commit. */
  get active(): boolean { return this.admitting || this.live !== undefined || this.pendingRecovery || this.state?.migration.status === 'blocked' }
  /** @returns Current public progress without file inventories or operation receipts. */
  progress() {
    if (!this.state) return undefined
    const { files, autoResume, ...view } = this.state.migration
    return { ...view }
  }
  /** @returns Pre-cutover accounting while transfer holds image writes; the completed directory is rescanned normally. */
  cachedUsage(): Usage | undefined { return this.active ? this.state?.usage : undefined }
  /** Load the committed location before any image task recovery; missing external storage never falls back silently.
   * @returns Whether background recovery must precede automatic image work.
   */
  async initialize(): Promise<boolean> {
    const saved = this.dependencies.repository().manifest(key)
    if (!saved) return false
    this.state = stateSchema.parse(saved.state)
    const directory = await ownedStorageDirectory(this.state.directory, this.dependencies.profileId, this.dependencies.defaultDirectory)
    await this.dependencies.files.activateStorageDirectory(directory, async () => {})
    const migration = this.state.migration
    this.pendingRecovery = migration.status === 'running' || migration.status === 'blocked' || migration.status === 'interrupted' && migration.autoResume
    return this.pendingRecovery
  }
  private async save(state: State, operationId: string = randomUUID()): Promise<State> {
    const manifest = this.dependencies.repository().manifest(key)
    await this.dependencies.repository().commit({ aggregateId: key, expectedRevision: manifest?.revision ?? 0, operationId, request: toJson(state), records: [], state: toJson(state) })
    this.state = state
    return state
  }
  /** @param raw Explicit directory and stable human operation identity. @returns After durable admission; transfer does not depend on the dialog lifetime. */
  async start(raw: unknown): Promise<void> {
    const input = z.strictObject({ operationId: imageStorageMigrationIdSchema, directory: z.string().min(1), sourceDirectory: z.string().min(1), confirm: z.literal(true) }).parse(raw)
    if (this.state?.migration.id === input.operationId) return
    if (this.dependencies.repository().receipt(input.operationId)) throw new CuratorError('revision-conflict', 'storage-migration', 'This migration request no longer identifies the current image location.')
    if (this.active || this.stopping) throw new CuratorError('constraint-conflict', 'storage-migration', 'Image storage is already being managed.')
    if (relative(input.sourceDirectory, this.dependencies.files.root) !== '') throw new CuratorError('revision-conflict', 'storage-migration', 'The current image location changed.')
    this.admitting = true
    try {
      const usage = await this.dependencies.readUsage()
      const source = await checkedStorageDirectory(this.dependencies.files.root)
      const target = await prepareStorageDirectory(input.directory, source, this.dependencies.profileId, this.dependencies.defaultDirectory)
      checkCancelled(this.dependencies.signal)
      const state: State = { version: 1, directory: source, usage, migration: { id: input.operationId, status: 'running', phase: 'preparing', sourceDirectory: source, targetDirectory: target, totalBytes: 0, totalFiles: 0, copiedBytes: 0, copiedFiles: 0, verifiedBytes: 0, verifiedFiles: 0, removedBytes: 0, removedFiles: 0, files: [], autoResume: true } }
      const saved = await this.save(state, input.operationId)
      await this.schedule(saved)
    } finally { this.admitting = false }
  }
  /** @param raw Existing migration identity; absence is reserved for automatic startup recovery. @returns After the same durable transfer resumes. */
  async resume(raw?: unknown): Promise<void> {
    if (raw !== undefined) {
      const input = z.strictObject({ id: imageStorageMigrationIdSchema }).parse(raw)
      if (input.id !== this.state?.migration.id) throw new CuratorError('revision-conflict', 'storage-migration', 'Refresh the current migration before retrying.')
    }
    if (!this.state || this.live || this.stopping) return
    if (this.state.migration.status === 'completed') return
    const state = this.state
    this.admitting = true
    try {
      const usage = raw === undefined ? state.usage : await this.dependencies.readUsage()
      const saved = await this.save({ ...state, usage, migration: { ...state.migration, status: 'running', autoResume: true, errorCode: undefined } })
      this.pendingRecovery = false
      await this.schedule(saved)
    } finally { this.admitting = false }
  }
  private async schedule(state: State): Promise<void> {
    if (this.stopping) { await this.save({ ...state, migration: { ...state.migration, status: 'interrupted', autoResume: true } }); return }
    const controller = new AbortController(), live = { controller, done: Promise.resolve<JobOutcome>({ status: 'completed' }), cancelledByUser: false }
    this.live = live
    try {
      this.dependencies.jobs.start({ kind: 'visual-curator', label: 'Image storage migration', run: () => {
        live.done = this.execute(live, state)
        return { done: live.done, cancel: () => { live.cancelledByUser = true; controller.abort() } }
      } })
    } catch (error) {
      controller.abort(); await live.done; this.live = undefined
      const state = this.state
      if (state) await this.save({ ...state, migration: { ...state.migration, status: 'failed', autoResume: false, errorCode: safeFailure(error).code } })
      throw error
    }
  }
  private async execute(live: { controller: AbortController; cancelledByUser: boolean }, initial: State): Promise<JobOutcome> {
    const signal = AbortSignal.any([live.controller.signal, this.dependencies.signal])
    let switching = false, state = initial
    try {
      const { sourceDirectory: source, targetDirectory: target } = initial.migration
      await ownedStorageDirectory(source, this.dependencies.profileId, this.dependencies.defaultDirectory)
      await ownedStorageDirectory(target, this.dependencies.profileId, this.dependencies.defaultDirectory)
      if (relative(initial.directory, source) === '') {
        const inventory = await imageStorageInventory(source)
        const files = inventory.filter(file => isImageStorageBlob(file.ref)).map(file => ({ digest: file.ref.slice(9), bytes: file.bytes }))
        const available = new Set(inventory.map(file => file.ref))
        for (const ref of referencedImageStorageFiles(this.dependencies.repository())) if (!available.has(ref)) throw new MediaError('reference-unavailable', 'storage-migration', false, 'A referenced source image is missing.', 'Restore the original image library before migrating.')
        await checkMigrationSpace(target, files)
        state = await this.save({ ...initial, migration: { ...initial.migration, phase: 'copying', files, totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), copiedBytes: 0, copiedFiles: 0, verifiedBytes: 0, verifiedFiles: 0, removedBytes: 0, removedFiles: 0 } })
        for (const file of files) {
          checkCancelled(signal)
          const migration = state.migration, completed = migration.copiedBytes
          await copyStorageFile(source, target, file, migration.id, signal, bytes => { migration.copiedBytes = completed + bytes })
          migration.copiedFiles++
        }
        state = await this.save({ ...state, migration: { ...state.migration, phase: 'verifying' } })
        for (const file of files) {
          if (!await verifyStorageFile(target, file, signal)) throw new MediaError('reference-unavailable', 'storage-migration', false, 'A copied image is missing.', 'Reconnect the target directory and retry.')
          state.migration.verifiedFiles++; state.migration.verifiedBytes += file.bytes
        }
        const current = (await imageStorageInventory(source)).filter(file => isImageStorageBlob(file.ref)).map(file => ({ digest: file.ref.slice(9), bytes: file.bytes }))
        if (contentDigest(current) !== contentDigest(files)) throw new CuratorError('revision-conflict', 'storage-migration', 'The source image inventory changed during migration.')
        switching = true
        await this.dependencies.files.activateStorageDirectory(target, async () => { checkCancelled(signal); state = await this.save({ ...state, directory: target, migration: { ...state.migration, phase: 'removing-source' } }) })
        switching = false
      }
      const usage = await this.dependencies.files.maintainStorage(referencedImageStorageFiles(this.dependencies.repository()))
      state = await this.save({ ...state, usage: { ...usage, cleanupAllowed: false }, migration: { ...state.migration, phase: 'removing-source', removedFiles: 0, removedBytes: 0 } })
      for (const file of state.migration.files) {
        await removeTransferredFile(source, target, file, signal)
        state.migration.removedFiles++; state.migration.removedBytes += file.bytes
      }
      state = await this.save({ ...state, migration: { ...state.migration, status: 'completed', autoResume: false, errorCode: undefined, files: [] } })
      return { status: 'completed' }
    } catch (error) {
      const status = switching ? 'blocked' : signal.aborted ? 'interrupted' : 'failed'
      const failed: State = { ...state, migration: { ...state.migration, status, autoResume: switching || signal.aborted && !live.cancelledByUser, errorCode: safeFailure(error).code } }
      this.state = failed
      await this.save(failed)
      return { status: signal.aborted ? 'killed' : 'failed', detail: safeFailure(error).safeMessage }
    } finally {
      this.live = undefined
      if (!this.stopping) await this.dependencies.settled()
    }
  }
  /** Cancel transfer and drain file handles before the profile writer closes; the committed journal enables restart recovery.
   * @returns Completion after the background job settles.
   */
  async dispose(): Promise<void> { this.stopping = true; const live = this.live; if (live) { live.controller.abort(); await live.done } }
}
