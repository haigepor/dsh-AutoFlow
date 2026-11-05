/** Provider-owned auxiliary image generation; these operations never enter the conversation loop. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Caller-owned identity persisted before one image request is dispatched. */
export type ImageGenerationId = Branded<'Llm.ImageGenerationId'>

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
  readonly size: string
  readonly quality: 'auto' | 'low' | 'medium' | 'high'
  readonly signal: AbortSignal
}

/** Originals remain downloadable independently of model-safe normalized previews. */
export interface GeneratedImage {
  readonly original: FileAttachmentRef
  readonly preview: ImageAttachmentRef
}

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
}
