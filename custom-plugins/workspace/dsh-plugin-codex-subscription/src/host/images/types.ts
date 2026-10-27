/** Shared durable image tasks; credentials and inline image bytes never enter these records. */
import type { FileAttachmentRef, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { AccountsFacade } from '../accounts/types.ts'
import type { ImageAssetId, ImageTaskId } from './ids.ts'

/** Caller identity used for every task and asset read. Session tools share their Session's tasks. */
export type ImageOwner = { kind: 'session'; sessionId: string; toolCallId?: string } | { kind: 'gateway'; keyId: string }

/** References accept public HTTP(S) or bounded image data URLs, never local paths. */
export interface ImageInput {
  prompt: string
  model?: string | undefined
  size?: string | undefined
  n?: number | undefined
  quality?: 'auto' | 'low' | 'medium' | 'high' | undefined
  background?: 'auto' | 'opaque' | 'transparent' | undefined
  outputFormat?: 'png' | 'jpeg' | 'webp' | undefined
  referenceImages?: string[] | undefined
  mask?: string | undefined
}

/** One original image and the AttachmentStore's normalized, model-safe preview. */
export interface ImageAsset {
  id: string
  mimeType: ImageMediaType
  original: FileAttachmentRef
  preview: ImageAttachmentRef
}

/** Sent includes the durable dispatch marker; its remote outcome is uncertain after interruption. */
export type ImageTaskState = 'queued' | 'sent' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown'

/** Persisted safe failure, deliberately excluding backend bodies, URLs and credential values. */
export interface ImageFailure { code: string; message: string; status?: number; retryAt?: number; requestId?: string }

/** Safe task projection shared by native tools, settings, MCP and the authenticated relay. */
export interface ImageTask {
  id: string
  owner: ImageOwner
  state: ImageTaskState
  prompt: string
  model: string
  createdAt: number
  updatedAt: number
  deadlineAt: number
  accountKey?: string
  assets: ImageAsset[]
  error?: ImageFailure
}

/** Business records use nominal IDs; public ImageTask remains a JSON projection for wire consumers. */
export interface ImageAssetRecord extends Omit<ImageAsset, 'id'> { id: ImageAssetId }
/** Host storage and scheduling records carry nominal task and asset identifiers. */
export interface ImageTaskRecord extends Omit<ImageTask, 'id' | 'assets'> { id: ImageTaskId; assets: ImageAssetRecord[] }

/** Caller-owned repository; writes settle only after durable storage succeeds. */
export interface ImageTaskRepository {
  get(id: ImageTaskId): Promise<ImageTaskRecord | undefined>
  list(): Promise<ImageTaskRecord[]>
  put(task: ImageTaskRecord): Promise<void>
  delete(id: ImageTaskId): Promise<void>
  close(): Promise<void>
}

/** A bounded decoded image, held only while a request or attachment write is executing. */
export interface ImageBytes { data: Uint8Array; mimeType: ImageMediaType; name?: string }

/** Production integrations and validated deployment limits supplied by the composition root. */
export interface ImageServiceSettings {
  baseUrl: string
  defaultModel: string
  timeoutMs: number
  maxConcurrent: number
  maxQueued: number
  maxReferenceImages: number
  maxImageBytes: number
  maxResponseBytes: number
  maxPromptChars: number
  maxRedirects: number
  maxHistoryTasks: number
}

/** Runtime integrations are stable while each accepted task captures its deployment settings. */
export interface ImageServiceOptions extends ImageServiceSettings {
  clientVersion: string
  repository: ImageTaskRepository
  withAccount: AccountsFacade['withAccount']
  saveAssets(images: readonly ImageBytes[]): Promise<ImageAssetRecord[]>
  validateReference(image: ImageBytes): Promise<void>
  readAsset(asset: ImageAsset, signal?: AbortSignal): Promise<ImageBytes>
  fetch: typeof globalThis.fetch
  /** Optional test/provider override; omitted uses the address-pinned public network loader. */
  readRemoteImage?(url: string, signal: AbortSignal): Promise<ImageBytes>
  now?: () => number
  id?: () => string
  /** Reports failed durable terminal writes to the Host's owned error surface. */
  reportError(error: Error): void
}

/** Shared task operations. Cancelling a result wait does not cancel its accepted generation. */
export interface ImagesFacade {
  submit(input: ImageInput, owner: ImageOwner): Promise<ImageTask>
  getResult(id: string, owner: ImageOwner, options?: { waitMs?: number; signal?: AbortSignal }): Promise<ImageTask>
  cancel(id: string, owner: ImageOwner): Promise<ImageTask>
  list(owner: ImageOwner): Promise<ImageTask[]>
  readAsset(taskId: string, assetId: string, owner: ImageOwner, signal?: AbortSignal): Promise<ImageBytes>
}
