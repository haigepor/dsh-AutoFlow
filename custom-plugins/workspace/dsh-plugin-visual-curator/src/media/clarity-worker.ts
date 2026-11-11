/** CPU-only luminance super-resolution runs outside the Host event loop. */
import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import * as ort from 'onnxruntime-web/wasm'
import { z } from 'zod'
import { claritySettingsSchema } from '../shared/clarity.ts'
import { backgroundResolutionSettingsSchema } from '../shared/background-resolution.ts'

const pixelRect = z.strictObject({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() })
const common = { bytes: z.instanceof(Uint8Array), modelPath: z.string(), maxPixels: z.number().int().positive() }
const taskSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('subject'), regions: z.array(pixelRect).min(1).max(32), protectedRegions: z.array(pixelRect).max(32), policy: claritySettingsSchema }),
  z.strictObject({ ...common, kind: z.literal('background'), width: z.number().int().positive(), height: z.number().int().positive(), policy: backgroundResolutionSettingsSchema }),
])
const modelDigest = '85f36ff88cc504a24af5e0602148bc56a8aa09a58eca8c0da2756f3e8186035e'
// The released ESPCN network consumes fixed 224px tiles and emits 3x luminance. The halo excludes convolution borders.
const tile = 224, halo = 8, core = tile - 2 * halo, scale = 3

async function resolveRgb(rgb: Buffer, width: number, height: number, session: ort.InferenceSession) {
  const resolved = Buffer.alloc(width * scale * height * scale * 3)
  const interpolated = await sharp(rgb, { raw: { width, height, channels: 3 } }).resize(width * scale, height * scale, { kernel: 'cubic' }).raw().toBuffer()
  let tiles = 0
  for (let top = 0; top < height; top += core) for (let left = 0; left < width; left += core) {
    const input = new Float32Array(tile * tile)
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      const i = (Math.max(0, Math.min(height - 1, top + y - halo)) * width + Math.max(0, Math.min(width - 1, left + x - halo))) * 3
      input[y * tile + x] = (rgb[i]! * 0.299 + rgb[i + 1]! * 0.587 + rgb[i + 2]! * 0.114) / 255
    }
    const result = await session.run({ [session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 1, tile, tile]) })
    const values = result[session.outputNames[0]!]!
    if (values.type !== 'float32' || values.dims.join(',') !== '1,1,672,672') throw new Error('clarity-model-output-invalid')
    const luma = values.data
    if (!(luma instanceof Float32Array)) throw new Error('clarity-model-output-invalid')
    for (let y = 0; y < Math.min(core, height - top) * scale; y++) for (let x = 0; x < Math.min(core, width - left) * scale; x++) {
      const at = ((top * scale + y) * width * scale + left * scale + x) * 3
      const value = luma[(y + halo * scale) * tile * scale + x + halo * scale]!
      if (!Number.isFinite(value)) throw new Error('clarity-model-output-invalid')
      const old = interpolated[at]! * 0.299 + interpolated[at + 1]! * 0.587 + interpolated[at + 2]! * 0.114
      const delta = Math.max(0, Math.min(255, value * 255)) - old
      for (let c = 0; c < 3; c++) resolved[at + c] = Math.max(0, Math.min(255, Math.round(interpolated[at + c]! + delta)))
    }
    values.dispose(); tiles++
  }
  return { resolved, tiles }
}

async function run() {
  const task = taskSchema.parse(workerData), started = performance.now()
  let pixels: number
  if (task.kind === 'subject') {
    pixels = task.regions.reduce((total, rect) => total + rect.width * rect.height, 0)
    if (pixels > task.policy.maxSubjectPixels) throw new Error('clarity-region-budget-exceeded')
  } else {
    if (!task.policy.enabled) throw new Error('background-resolution-disabled')
    if (task.width * task.height > task.maxPixels) throw new Error('background-resolution-output-budget-exceeded')
    const metadata = await sharp(task.bytes, { limitInputPixels: task.maxPixels }).metadata()
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error('background-resolution-input-invalid')
    pixels = metadata.width * metadata.height
    if (pixels > task.policy.maxInputPixels) throw new Error('background-resolution-input-budget-exceeded')
    if (pixels * scale * scale > task.maxPixels) throw new Error('background-resolution-intermediate-budget-exceeded')
    if (task.width > metadata.width * scale || task.height > metadata.height * scale) throw new Error('background-resolution-scale-exceeded')
    if (Math.abs(metadata.width - metadata.height * task.width / task.height) > 1) throw new Error('background-resolution-ratio-mismatch')
  }
  const model = await readFile(task.modelPath)
  if (createHash('sha256').update(model).digest('hex') !== modelDigest) throw new Error('clarity-model-digest-mismatch')
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], logSeverityLevel: 3 })
  try {
    const decoded = await sharp(task.bytes, { limitInputPixels: task.maxPixels }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
    const { width, height } = decoded.info
    if (task.kind === 'background') {
      const { resolved, tiles } = await resolveRgb(decoded.data, width, height, session)
      const image = await sharp(resolved, { raw: { width: width * scale, height: height * scale, channels: 3 } }).resize(task.width, task.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()
      return { bytes: image, model: 'espcn-x3-luma' as const, modelSha256: modelDigest, durationMs: performance.now() - started, pixels, tiles, sourceWidth: width, sourceHeight: height, outputWidth: task.width, outputHeight: task.height }
    }
    for (const rect of [...task.regions, ...task.protectedRegions]) if (rect.left + rect.width > width || rect.top + rect.height > height) throw new Error('clarity-region-outside-image')
    const output = Buffer.from(decoded.data), touched = new Uint8Array(width * height)
    let tiles = 0
    for (const rect of task.regions) {
      const rgb = await sharp(decoded.data, { raw: { width, height, channels: 3 } }).extract(rect).raw().toBuffer()
      const resolution = await resolveRgb(rgb, rect.width, rect.height, session), resolved = resolution.resolved
      tiles += resolution.tiles
      const sampled = await sharp(resolved, { raw: { width: rect.width * scale, height: rect.height * scale, channels: 3 } }).resize(rect.width, rect.height, { kernel: 'lanczos3' }).raw().toBuffer()
      for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
        const global = (rect.top + y) * width + rect.left + x
        if (touched[global]) continue
        touched[global] = 1
        const weight = task.policy.blend * Math.min(1, Math.min(x, y, rect.width - 1 - x, rect.height - 1 - y) / task.policy.featherPixels)
        for (let c = 0; c < 3; c++) output[global * 3 + c] = Math.round(decoded.data[global * 3 + c]! * (1 - weight) + sampled[(y * rect.width + x) * 3 + c]! * weight)
      }
    }
    // Identity-bearing and other critical regions retain their exact baseline pixels.
    for (const rect of task.protectedRegions) for (let y = rect.top; y < rect.top + rect.height; y++) {
      const start = (y * width + rect.left) * 3, end = start + rect.width * 3
      decoded.data.copy(output, start, start, end)
    }
    let changedPixels = 0
    for (let index = 0; index < width * height; index++) if (touched[index] && (output[index * 3] !== decoded.data[index * 3] || output[index * 3 + 1] !== decoded.data[index * 3 + 1] || output[index * 3 + 2] !== decoded.data[index * 3 + 2])) changedPixels++
    const image = await sharp(output, { raw: { width, height, channels: 3 } }).png().toBuffer()
    return { bytes: image, model: 'espcn-x3-luma' as const, modelSha256: modelDigest, durationMs: performance.now() - started, pixels, tiles, changedPixels }
  } finally { await session.release() }
}
void run().then(result => { parentPort!.postMessage({ ok: true, ...result }); parentPort!.close() }, error => { parentPort!.postMessage({ ok: false, code: error instanceof Error ? error.message : 'clarity-processing-failed' }); parentPort!.close() })
