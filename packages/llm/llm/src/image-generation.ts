/** Provider-owned auxiliary image generation; these operations never enter the conversation loop. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Caller-owned identity persisted before one image request is dispatched. */
export type ImageGenerationId = Branded<'Llm.ImageGenerationId'>

/** Provider-owned accepted task identity, used only with its saved provider and model route. */
export type ImageGenerationTaskId = Branded<'Llm.ImageGenerationTaskId'>

/** An explicitly advertised image model, separate from conversational model catalogs. */
export interface ImageGenerationModel {
  readonly id: string
  readonly name: string
}

/** Exact auxiliary request. Providers honor cancellation and never retry an uncertain dispatch. */
export interface ImageGenerationRequest {
  readonly id: ImageGenerationId
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly references: readonly ImageAttachmentRef[]
  /** Optional PNG edit mask for the first reference; omission generates or edits without a mask. */
  readonly mask?: FileAttachmentRef
  readonly size: string
  readonly quality: 'auto' | 'low' | 'medium' | 'high'
  readonly signal: AbortSignal
}

/** Originals remain downloadable independently of model-safe normalized previews. */
export interface GeneratedImage {
  readonly original: FileAttachmentRef
  readonly preview: ImageAttachmentRef
}

/** Persistable route and operation identity; reading this handle never starts another generation. */
export interface ImageGenerationHandle {
  readonly id: ImageGenerationId
  readonly provider: string
  readonly model: string
  /** Omit to find an already accepted operation by caller ID; this never dispatches new work. */
  readonly taskId?: ImageGenerationTaskId
}

/** Accepted generation and its durable outputs; unknown dispatches must not be retried automatically. */
export interface ImageGenerationTask extends ImageGenerationHandle {
  readonly taskId: ImageGenerationTaskId
  readonly state: 'queued' | 'sent' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown'
  readonly images: readonly GeneratedImage[]
  readonly error?: { readonly code: string; readonly message: string }
}

/** Optional task waits are bounded by the provider; omission reads the current durable state. */
export interface ImageGenerationReadOptions { readonly waitMs?: number; readonly signal?: AbortSignal }

/** Provider implementation registered for one existing LLM route. */
export interface ImageGenerationProvider {
  /** List configured image-generation models.
   * @returns Explicit image-generation models currently configured for this provider.
   */
  listModels(): Promise<readonly ImageGenerationModel[]>
  /** Generate and persist images without retrying an uncertain dispatch.
   * @param request Frozen caller-owned input.
   * @returns Persisted image attachments after successful generation.
   */
  generate(request: ImageGenerationRequest): Promise<readonly GeneratedImage[]>
  /** Accept once by caller identity and reject reuse with different input.
   * @param request Persisted input and cancellation before acceptance.
   * @returns Durable task receipt.
   */
  start?(request: ImageGenerationRequest): Promise<ImageGenerationTask>
  /** Read an accepted operation without resubmission.
   * @param handle Original receipt.
   * @param options Optional bounded wait and read cancellation.
   * @returns Durable task state.
   */
  get?(handle: ImageGenerationHandle, options?: ImageGenerationReadOptions): Promise<ImageGenerationTask>
  /** Cancel accepted work without deleting any saved outputs.
   * @param handle Original receipt.
   * @returns Durable task state.
   */
  cancel?(handle: ImageGenerationHandle): Promise<ImageGenerationTask>
}
