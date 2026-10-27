/** OpenAI image codecs share durable generation tasks with native tools and MCP. */
import { z } from 'zod'
import type { ImageInput, ImageOwner, ImageTask } from '../images/types.ts'
import { object, RelayError, string } from './http.ts'
import type { RelayDependencies } from './types.ts'

/** Wire schema for the service's supported generation options. */
export const imageInputSchema = z.object({ prompt: z.string().trim().min(1), model: z.string().min(1).optional(), size: z.string().min(1).optional(), n: z.number().int().min(1).max(4).optional(), quality: z.enum(['auto', 'low', 'medium', 'high']).optional(), background: z.enum(['auto', 'opaque', 'transparent']).optional(), outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(), referenceImages: z.array(z.string().min(1)).optional(), mask: z.string().min(1).optional() }).strict()

/** Decode JSON or a bounded multipart upload into one image generation input.
 * @param bytes - Body bounded by the listener before decoding.
 * @param contentType - Original Content-Type, including multipart boundary.
 * @param edit - Whether this route requires a reference image.
 * @returns supported options plus the desired response encoding.
 */
export async function parseImageRequest(bytes: Buffer, contentType: string, edit: boolean): Promise<{ input: ImageInput; format: 'b64_json' | 'url' }> {
  let body: Record<string, unknown>
  const references: string[] = []
  let mask: string | undefined
  if (contentType.startsWith('multipart/form-data')) {
    let form: FormData
    try { form = await new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }).formData() }
    catch { throw new RelayError(400, 'invalid_multipart', 'The multipart form is invalid.') }
    body = {}
    for (const [key, value] of form.entries()) {
      if (key === 'image' || key === 'image[]' || key === 'mask') {
        if (key === 'mask' && mask !== undefined) throw new RelayError(400, 'invalid_request', 'Only one mask is supported.')
        let image: string
        if (typeof value === 'string') image = value
        else {
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.type)) throw new RelayError(400, 'invalid_image', 'Uploaded images must be PNG, JPEG, or WebP.')
          image = `data:${value.type};base64,${Buffer.from(await value.arrayBuffer()).toString('base64')}`
        }
        if (key === 'mask') mask = image
        else references.push(image)
      } else if (typeof value !== 'string') throw new RelayError(400, 'unsupported_parameter', 'Only image file uploads are supported.')
      else if (Object.hasOwn(body, key)) throw new RelayError(400, 'invalid_request', 'Duplicate form fields are not supported.')
      else body[key] = key === 'n' ? Number(value) : value
    }
  } else {
    if (!contentType.startsWith('application/json')) throw new RelayError(415, 'unsupported_media_type', 'Use JSON or multipart/form-data.')
    try { body = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
    catch (error) {
      if (error instanceof RelayError) throw error
      throw new RelayError(400, 'invalid_json', 'The body must contain valid UTF-8 JSON.')
    }
    for (const raw of [body.image, body.images, body.reference_images, body.referenceImages]) {
      if (raw === undefined) continue
      const values: unknown[] = Array.isArray(raw) ? raw : [raw]
      for (const value of values) references.push(typeof value === 'string' ? value : string(object(value).image_url, 'image_url'))
    }
    if (body.mask !== undefined) mask = typeof body.mask === 'string' ? body.mask : string(object(body.mask).image_url, 'mask.image_url')
  }
  if (mask !== undefined && !edit) throw new RelayError(400, 'unsupported_parameter', 'A mask requires the image edit route.')
  const format = body.response_format ?? 'b64_json'
  if (format !== 'b64_json' && format !== 'url') throw new RelayError(400, 'invalid_request', 'response_format must be b64_json or url.')
  const supported = new Set(['prompt', 'model', 'size', 'n', 'quality', 'background', 'output_format', 'response_format', 'image', 'images', 'reference_images', 'referenceImages', 'mask'])
  for (const key of Object.keys(body)) if (!supported.has(key)) throw new RelayError(400, 'unsupported_parameter', `${key} is not supported by this subscription image backend.`)
  const candidate: Record<string, unknown> = { prompt: body.prompt }
  for (const key of ['model', 'size', 'n', 'quality', 'background']) if (body[key] !== undefined) candidate[key] = body[key]
  if (body.output_format !== undefined) candidate.outputFormat = body.output_format
  if (references.length > 0) candidate.referenceImages = references
  if (mask !== undefined) candidate.mask = mask
  const parsed = imageInputSchema.safeParse(candidate)
  if (!parsed.success) throw new RelayError(400, 'invalid_image_request', 'The image generation options are invalid.')
  if (edit && references.length === 0) throw new RelayError(400, 'missing_image', 'An image edit requires at least one reference image.')
  return { input: parsed.data, format }
}

/** Wait repeatedly within the gateway budget; a disconnected wait never cancels accepted work.
 * @param dependencies - Shared task operations.
 * @param initial - Accepted image task.
 * @param owner - Authenticated task owner.
 * @param waitMs - Total wait budget.
 * @param signal - Wait cancellation.
 * @returns the terminal task or a typed pending error containing its public id.
 */
export async function waitImage(dependencies: RelayDependencies, initial: ImageTask, owner: ImageOwner, waitMs: number, signal: AbortSignal): Promise<ImageTask> {
  let task = initial
  const deadline = Date.now() + waitMs
  while ((task.state === 'queued' || task.state === 'sent') && Date.now() < deadline) {
    signal.throwIfAborted()
    task = await dependencies.images.getResult(task.id, owner, { waitMs: Math.min(20_000, Math.max(1, deadline - Date.now())), signal })
  }
  if (task.state === 'queued' || task.state === 'sent') throw new RelayError(504, 'image_task_pending', `Image task ${task.id} is still running. Retrieve it with generation_result; do not submit the request again.`)
  if (task.state !== 'succeeded') throw new RelayError(task.state === 'outcome-unknown' ? 409 : task.error?.status ?? 502,
    task.state === 'outcome-unknown' ? 'image_outcome_unknown' : 'image_generation_failed', `Image task ${task.id} ${task.state}. Check its task status before retrying.`,
    task.error === undefined ? {} : { ...(task.error.retryAt === undefined ? {} : { retryAt: task.error.retryAt }), ...(task.error.requestId === undefined ? {} : { requestId: task.error.requestId }) })
  if (task.assets.length === 0) throw new RelayError(502, 'invalid_image_result', 'The completed image task has no saved images.')
  return task
}

/** Public task status excludes private attachment metadata and scheduler account identities.
 * @param task - Durable task projection after its owner check.
 * @returns transport-safe status and result references.
 */
export function publicImageTask(task: ImageTask): Record<string, unknown> {
  return { task_id: task.id, status: task.state, model: task.model, created_at: task.createdAt, updated_at: task.updatedAt, assets: task.assets.map(asset => ({ id: asset.id, mime_type: asset.mimeType })), ...(task.error === undefined ? {} : { error: { code: task.error.code, message: task.error.message } }) }
}
