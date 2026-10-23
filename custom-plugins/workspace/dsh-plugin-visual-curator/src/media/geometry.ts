import { invalidInput } from './errors.ts'

/** Coordinates on the EXIF-oriented image, expressed as fractions of its dimensions. */
export interface NormalizedRect { x: number; y: number; width: number; height: number }
/** Integer region extracted before resizing. */
export interface PixelRect { left: number; top: number; width: number; height: number }
/** Reduced ratio and exact output size; this implementation never enlarges pixels. */
export interface CropUsage { aspectP: number; aspectQ: number; targetWidth: number; targetHeight: number }
/** Width and height of the normalized parent. */
export interface ImageGeometry { width: number; height: number }
/** Stable identifier for floor/ceil, largest exact-ratio window and centered remainder. */
export const CROP_ALGORITHM = 'integer-ratio-center-v1'

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

/** Validate an untrusted normalized rectangle without clamping it.
 * @param value JSON rectangle from a user or model.
 * @returns Finite, positive-area coordinates within the image.
 */
export function parseRect(value: unknown): NormalizedRect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidInput('A crop rectangle is required.')
  if (!('x' in value && 'y' in value && 'width' in value && 'height' in value)) throw invalidInput('The crop rectangle is incomplete.')
  const { x, y, width, height } = value
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
    || ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0
    || x + width > 1 || y + height > 1) throw invalidInput('The crop rectangle must be finite and inside the image.')
  return { x, y, width, height }
}

/** Resolve a suggestion to the deterministic exact-ratio source window.
 * @param requestedRect Untrusted normalized suggestion; invalid coordinates are rejected.
 * @param source Dimensions after applying EXIF orientation.
 * @param usage Validated ratio and exact target pixels.
 * @returns Requested rectangle, effective source pixels and algorithm identifier.
 */
export function resolveCrop(requestedRect: unknown, source: ImageGeometry, usage: CropUsage): { requestedRect: NormalizedRect; effectivePixelRect: PixelRect; algorithm: string } {
  const rect = parseRect(requestedRect)
  const values = [source.width, source.height, usage.aspectP, usage.aspectQ, usage.targetWidth, usage.targetHeight]
  if (!values.every(n => Number.isSafeInteger(n) && n > 0) || gcd(usage.aspectP, usage.aspectQ) !== 1
    || BigInt(usage.targetWidth) * BigInt(usage.aspectQ) !== BigInt(usage.targetHeight) * BigInt(usage.aspectP)) throw invalidInput('The output ratio and dimensions are incompatible.')
  const left = Math.floor(rect.x * source.width)
  const top = Math.floor(rect.y * source.height)
  const right = Math.ceil((rect.x + rect.width) * source.width)
  const bottom = Math.ceil((rect.y + rect.height) * source.height)
  const k = Math.floor(Math.min((right - left) / usage.aspectP, (bottom - top) / usage.aspectQ))
  const width = usage.aspectP * k
  const height = usage.aspectQ * k
  if (k < 1 || width < usage.targetWidth || height < usage.targetHeight) throw invalidInput('The crop has insufficient source pixels; enlargement is disabled.')
  return {
    requestedRect: rect,
    effectivePixelRect: { left: left + Math.floor((right - left - width) / 2), top: top + Math.floor((bottom - top - height) / 2), width, height },
    algorithm: CROP_ALGORITHM,
  }
}
