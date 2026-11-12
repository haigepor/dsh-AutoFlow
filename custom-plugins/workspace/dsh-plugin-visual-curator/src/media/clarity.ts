/** Bounded, cancellable ESPCN x3 enhancement; source and baseline outputs remain immutable. */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { resolutionProgressSchema, resolveEspcnClarity, type ResolutionProgress } from '../shared/clarity.ts'
import { resolveEspcnBackground } from '../shared/background-resolution.ts'
import type { ClaritySettings } from '../shared/clarity.ts'
import type { BackgroundResolutionSettings } from '../shared/background-resolution.ts'
import { MediaError } from './errors.ts'

interface PixelRect { left: number; top: number; width: number; height: number }
type SubjectInput = { bytes: Uint8Array; regions: PixelRect[]; protectedRegions: PixelRect[]; policy: ClaritySettings; maxPixels: number }
type BackgroundInput = { bytes: Uint8Array; width: number; height: number; policy: BackgroundResolutionSettings; maxPixels: number }
type Task = ({ kind: 'subject' } & SubjectInput) | ({ kind: 'background' } & BackgroundInput)
const resultFields = { ok: z.literal(true), bytes: z.instanceof(Uint8Array), model: z.literal('espcn-x3-luma'), modelSha256: z.string(), durationMs: z.number().nonnegative(), pixels: z.number().int().positive(), tiles: z.number().int().positive() }
const subjectResponseSchema = z.object({ ...resultFields, changedPixels: z.number().int().nonnegative() })
const backgroundResponseSchema = z.object({ ...resultFields, sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(), outputWidth: z.number().int().positive(), outputHeight: z.number().int().positive() })
const failureSchema = z.object({ ok: z.literal(false), code: z.string() })
let queue: Promise<void> = Promise.resolve()

async function execute<T>(input: Task, schema: z.ZodType<T>, signal: AbortSignal, onProgress?: (progress: ResolutionProgress) => void): Promise<T> {
  signal.throwIfAborted()
  onProgress?.({ completed: 0, total: 0, unit: 'tiles' })
  const work = queue.then(async () => {
    signal.throwIfAborted()
    const source = import.meta.url.endsWith('.ts'), prefix = input.kind === 'subject' ? 'clarity' : 'background-resolution'
    const worker = new Worker(new URL(source ? './clarity-worker.ts' : './clarity-worker.js', import.meta.url), { workerData: { ...input, modelPath: fileURLToPath(new URL(source ? '../../assets/models/espcn-x3.onnx' : './assets/models/espcn-x3.onnx', import.meta.url)) } })
    const failure = (code: string) => new MediaError(code, input.kind === 'subject' ? 'wallpaper-clarity' : 'wallpaper-background-resolution', false, 'The independent super-resolution version was not completed.', 'Keep the original and baseline output; inspect the resolution stage before retrying.')
    const result = Promise.withResolvers<T>(), abort = () => result.reject(signal.reason)
    const timeout = setTimeout(() => result.reject(failure(`${prefix}-timeout`)), input.policy.timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    worker.on('message', (raw: unknown) => {
      const message = z.object({ type: z.literal('progress'), completed: z.number(), total: z.number() }).safeParse(raw)
      if (message.success) {
        const progress = resolutionProgressSchema.safeParse({ completed: message.data.completed, total: message.data.total })
        if (!progress.success) result.reject(failure(`${prefix}-worker-invalid-progress`))
        else onProgress?.(progress.data)
        return
      }
      const failed = failureSchema.safeParse(raw)
      if (failed.success) { result.reject(failure(failed.data.code)); return }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) result.reject(failure(`${prefix}-worker-invalid-output`))
      else result.resolve(parsed.data)
    })
    worker.once('error', () => result.reject(failure(`${prefix}-worker-failed`)))
    worker.once('exit', () => result.reject(failure(`${prefix}-worker-failed`)))
    if (signal.aborted) abort()
    try { return await result.promise }
    finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); await worker.terminate() }
  })
  queue = work.then(() => {}, () => {})
  return await work
}

/** Enhance marked subject pixels with ESPCN x3, restoring every critical region exactly.
 * @param input Verified clean wallpaper, pixel-space regions and frozen limits.
 * @param signal Owning task cancellation; terminates the worker even during synchronous inference.
 * @param onProgress Live completed-tile counters, including serial-queue waiting.
 * @returns A separate PNG of the same size and reproducible model/timing evidence.
 */
export async function enhanceWallpaper(input: SubjectInput, signal: AbortSignal, onProgress?: (progress: ResolutionProgress) => void) {
  return await execute({ kind: 'subject', ...input, policy: resolveEspcnClarity(input.policy) }, subjectResponseSchema, signal, onProgress)
}

/** Reconstruct the entire generated background with ESPCN x3 before one final downsample.
 * @param input Immutable provider image, exact target dimensions and frozen CPU/pixel limits.
 * @param signal Owning task cancellation, including in-flight inference.
 * @param onProgress Live completed-tile counters, including serial-queue waiting.
 * @returns A separate PNG and measured source, target and fixed-model evidence; no protected pixels are removed.
 */
export async function superResolveWallpaperBackground(input: BackgroundInput, signal: AbortSignal, onProgress?: (progress: ResolutionProgress) => void) {
  const { ok: _ok, ...result } = await execute({ kind: 'background', ...input, policy: resolveEspcnBackground(input.policy) }, backgroundResponseSchema, signal, onProgress)
  return { ...result, nativeOutputWidth: result.sourceWidth * 3, nativeOutputHeight: result.sourceHeight * 3 }
}
