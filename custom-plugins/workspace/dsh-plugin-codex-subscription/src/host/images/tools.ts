/** Native image tools return canonical JSON and pure, replayable attachment presentations. */
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageOwner, ImagesFacade, ImageTask } from './types.ts'
import { ImageServiceError } from './errors.ts'

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  taskId: { type: 'string', required: true }, state: { type: 'string', enum: ['queued', 'sent', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'], required: true },
  prompt: { type: 'string', required: true }, model: { type: 'string', required: true },
  createdAt: { type: 'number', required: true }, deadlineAt: { type: 'number', required: true },
  includeImages: { type: 'boolean', required: true },
  assets: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true }, mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    attachmentId: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
    originalAttachmentId: { type: 'string', required: true }, originalBytes: { type: 'integer', required: true }, name: { type: 'string', required: true },
  } } },
  error: { required: true, oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
    code: { type: 'string', required: true }, message: { type: 'string', required: true },
    status: { required: true, oneOf: [{ type: 'null' }, { type: 'integer' }] },
    retryAt: { required: true, oneOf: [{ type: 'null' }, { type: 'number' }] },
    requestId: { required: true, oneOf: [{ type: 'null' }, { type: 'string' }] },
  } }] },
} } as const

/** Pure canonical value omits owner identity, credentials, account identity, and request headers.
 * @param task Safe service result.
 * @param includeImages Whether the current model route positively declares image input.
 * @returns Stable JSON for model history and tool UI metadata.
 */
export function imageToolValue(task: ImageTask, includeImages: boolean) {
  return {
    taskId: task.id, state: task.state, prompt: task.prompt, model: task.model, createdAt: task.createdAt, deadlineAt: task.deadlineAt, includeImages,
    assets: task.assets.map(asset => ({ id: asset.id, mimeType: asset.preview.mediaType, attachmentId: String(asset.preview.attachmentId),
      bytes: asset.preview.bytes, width: asset.preview.width, height: asset.preview.height,
      originalAttachmentId: String(asset.original.attachmentId), originalBytes: asset.original.bytes, name: asset.original.name })),
    error: task.error === undefined ? null : { code: task.error.code, message: task.error.message, status: task.error.status ?? null,
      retryAt: task.error.retryAt ?? null, requestId: task.error.requestId ?? null },
  }
}

/** Pure model rendering uses durable preview references; original references remain in canonical JSON.
 * @param value Canonical image result.
 * @returns Model content blocks logged by the standard tools runtime.
 */
export function renderImageToolValue(value: ReturnType<typeof imageToolValue>): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }, ...(value.includeImages ? value.assets.map(asset => ({ type: 'image' as const,
    attachment: { attachmentId: AttachmentId(asset.attachmentId), mediaType: asset.mimeType, bytes: asset.bytes,
      width: asset.width, height: asset.height, name: asset.name },
  })) : [])]
}

/** Create the generate/result pair against a shared service without registering effects.
 * @param images Initialized image service, shared with MCP and relay callers.
 * @param options Resolved wait configuration and exact model-image admission.
 * @returns Two registry-ready native tool definitions.
 */
export function createImageTools(images: ImagesFacade, options: { quickWaitMs(): number; admitImages(exec: ToolRunContext): Promise<boolean>;
  resolveAttachments?(ids: readonly string[], exec: ToolRunContext): Promise<string[]> }): ToolDefinition[] {
  return [
    defineTool({ name: 'codex_image_generate',
      description: 'Generate or edit images with the signed-in Codex subscription. Returns a durable task within 20 seconds. If pending, use codex_image_result with its taskId. Never resubmit unknown work or regenerate missing outputs of a partial result automatically. To edit an uploaded image, use referenceAttachmentIds: ["latest"], or attachment IDs from this Session. Public image URLs/data URLs are also supported. Local paths are unsupported.',
      parameters: {
        prompt: { type: 'string', required: true }, model: { type: 'string' }, size: { type: 'string' }, n: { type: 'integer' },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] }, background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
        outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        referenceImages: { type: 'array', items: { type: 'string' } },
        referenceAttachmentIds: { type: 'array', items: { type: 'string' }, description: 'Attachment IDs from this Session, or latest for its most recent visible image. Generated image IDs resolve to their preserved originals.' },
        mask: { type: 'string', description: 'Optional mask data URL or public URL; requires referenceImages. The backend validates mask geometry and transparency support.' },
        maskAttachmentId: { type: 'string', description: 'A mask attachment from this Session. Use instead of mask, with at least one reference image.' },
      },
      output: { schema: outputSchema, render: (_args, value) => renderImageToolValue(value),
        presentationMeta: (_args, value) => ({ codexImage: { version: 1, operation: 'generate', ...value } }) },
      presentCall: args => ({ card: 'generic', title: 'Codex image', kind: 'execute', rawInput: args.prompt }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'Codex image', content: result.content }),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const owner = sessionOwner(exec)
        const { referenceAttachmentIds, maskAttachmentId, ...input } = args
        if (maskAttachmentId !== undefined && input.mask !== undefined) throw new ImageServiceError('invalid-image-mask', 'Supply mask or maskAttachmentId, not both.')
        const ids = [...(referenceAttachmentIds ?? []), ...(maskAttachmentId === undefined ? [] : [maskAttachmentId])]
        if (ids.length > 0) {
          if (options.resolveAttachments === undefined) throw new ImageServiceError('image-attachment-unavailable', 'Session image references are unavailable in this Host.')
          const references = await options.resolveAttachments(ids, exec)
          if (maskAttachmentId !== undefined) {
            const mask = references.pop()
            if (mask === undefined) throw new ImageServiceError('image-attachment-unavailable', 'The mask attachment could not be resolved.')
            input.mask = mask
          }
          input.referenceImages = [...(input.referenceImages ?? []), ...references]
        }
        exec.signal.throwIfAborted()
        const accepted = await images.submit(input, owner)
        const task = await images.getResult(accepted.id, owner, { waitMs: Math.min(20_000, options.quickWaitMs()), signal: exec.signal })
        return imageToolValue(task, await options.admitImages(exec))
      },
    }),
    defineTool({ name: 'codex_image_result',
      description: 'Read a Codex image task from this Session, optionally wait up to 20 seconds, or cancel local work. Cancellation after dispatch cannot confirm whether the remote image was generated. Use existing task IDs; do not repeatedly resubmit pending or unknown work.',
      parameters: { taskId: { type: 'string', required: true }, waitMs: { type: 'integer' }, cancel: { type: 'boolean' } },
      isConcurrencySafe: args => args.cancel !== true,
      output: { schema: outputSchema, render: (_args, value) => renderImageToolValue(value),
        presentationMeta: (_args, value) => ({ codexImage: { version: 1, operation: 'result', ...value } }) },
      presentCall: args => ({ card: 'generic', title: 'Codex image result', kind: 'read', rawInput: args.taskId }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'Codex image result', content: result.content }),
      async execute(args, exec) {
        const owner = sessionOwner(exec)
        if (args.waitMs !== undefined && (!Number.isInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 20_000)) throw new ImageServiceError('invalid-image-wait', 'waitMs must be an integer from 0 to 20000.')
        exec.signal.throwIfAborted()
        const task = args.cancel === true ? await images.cancel(args.taskId, owner)
          : await images.getResult(args.taskId, owner, { waitMs: args.waitMs ?? 0, signal: exec.signal })
        return imageToolValue(task, await options.admitImages(exec))
      },
    }),
  ]
}

function sessionOwner(exec: ToolRunContext): ImageOwner {
  if (exec.agent === undefined) throw new ImageServiceError('image-session-required', 'A Session is required to use Codex image tools.')
  return { kind: 'session', sessionId: exec.agent.session.id, toolCallId: exec.callId }
}
