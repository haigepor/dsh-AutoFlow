import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { checkCancelled, invalidInput, MediaError } from './errors.ts'
import { resolveCrop } from './geometry.ts'
import type { CropUsage, ImageGeometry, NormalizedRect, PixelRect } from './geometry.ts'

/** Content-addressed private file; business ownership must be checked before reading it. */
export interface BlobRef { digest: string; byteLength: number; mime: string; storageRef: string }
/** Normalized pixels; orientation records the transformation from the original file. */
export interface ImageFile { blob: BlobRef; width: number; height: number; sourceOrientation: number; processorVersion: string; colorSpace: 'srgb' }
/** Original bytes remain unchanged; normalized and preview blobs are separate versions. */
export interface ImportedFiles { originalBlob: BlobRef; normalized: ImageFile; preview: ImageFile }
/** All deployment-varying import and storage limits are supplied at construction. */
export interface MediaLimits { maxFileBytes: number; maxPixels: number; maxDimension: number; previewMaxDimension: number; maxStorageBytes: number }
/** An immutable derivative with its reproducible processing recipe. */
export interface CropFile extends ImageFile {
  requestedRect: NormalizedRect
  effectivePixelRect: PixelRect
  processing: { algorithm: string; parentDigest: string; recipeDigest: string; encoding: string; targetWidth: number; targetHeight: number }
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function storageRef(hash: string): string { return `blobs/${hash.slice(0, 2)}/${hash}` }
function sniff(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  throw invalidInput('Only JPEG, PNG and static WebP images are supported.')
}

function rejectAnimation(bytes: Buffer, mime: string): void {
  // libpng 可能只解第一帧，因此在解码前拒绝 APNG 的动画控制块。
  if (mime === 'image/png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      if (length > bytes.length - offset - 12) throw invalidInput('The PNG chunk data is incomplete.')
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL') throw invalidInput('Animated images are not supported.')
      if (type === 'IEND') break
      offset += length + 12
    }
  }
}

/** Stores immutable digest blobs; only committed domain references authorize delivery.
 * Failed imports can leave private, unreferenced blobs; callers never publish their references.
 */
export class AssetFiles {
  readonly root: string
  readonly processorVersion = `sharp-${sharp.versions.sharp}/vips-${sharp.versions.vips}/visual-normalize-v1`
  private writing: Promise<void> = Promise.resolve()

  constructor(root: string, readonly limits: MediaLimits) {
    if (!root.trim()) throw invalidInput('A private media directory is required.')
    this.root = resolve(root)
    if (!Object.values(limits).every(n => Number.isSafeInteger(n) && n > 0)) throw invalidInput('Media limits must be positive integers.')
  }

  /** Verify and copy supported bytes, then normalize EXIF orientation and generate a preview.
   * @param input Authorized upload bytes; input is copied before asynchronous work.
   * @param declaredMime Optional HTTP/upload MIME; absent uses verified magic and decoder format.
   * @param signal Optional cancellation; absent allows completion.
   * @returns Immutable original, normalized and preview references; no domain metadata is committed.
   */
  async importBytes(input: Uint8Array, declaredMime?: string, signal?: AbortSignal): Promise<ImportedFiles> {
    checkCancelled(signal)
    if (input.byteLength === 0 || input.byteLength > this.limits.maxFileBytes) throw invalidInput('Image bytes exceed the configured import limit.')
    const bytes = Buffer.from(input)
    const mime = sniff(bytes)
    rejectAnimation(bytes, mime)
    if (declaredMime !== undefined && declaredMime.split(';')[0]?.trim().toLowerCase() !== mime) throw invalidInput('The declared image MIME does not match its bytes.')
    try {
      const metadata = await sharp(bytes, { limitInputPixels: this.limits.maxPixels, animated: true }).metadata()
      const expected = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/png' ? 'png' : 'webp'
      if (metadata.format !== expected || (metadata.pages !== undefined && metadata.pages !== 1)) throw invalidInput('Animated or mismatched image data is not supported.')
      if (metadata.width === undefined || metadata.height === undefined || metadata.width > this.limits.maxDimension || metadata.height > this.limits.maxDimension
        || metadata.width * metadata.height > this.limits.maxPixels) throw invalidInput('Decoded image dimensions exceed the configured limit.')
      const sourceOrientation = metadata.orientation ?? 1
      const normalized = await sharp(bytes, { limitInputPixels: this.limits.maxPixels }).autoOrient().toColourspace('srgb').png().toBuffer({ resolveWithObject: true })
      const preview = await sharp(normalized.data, { limitInputPixels: this.limits.maxPixels }).resize({ width: this.limits.previewMaxDimension, height: this.limits.previewMaxDimension, fit: 'inside', withoutEnlargement: true }).webp({ lossless: true }).toBuffer({ resolveWithObject: true })
      checkCancelled(signal)
      const originalBlob = await this.put(bytes, mime, signal)
      const normalizedBlob = await this.put(normalized.data, 'image/png', signal)
      const previewBlob = await this.put(preview.data, 'image/webp', signal)
      checkCancelled(signal)
      return {
        originalBlob,
        normalized: { blob: normalizedBlob, width: normalized.info.width, height: normalized.info.height, sourceOrientation, processorVersion: this.processorVersion, colorSpace: 'srgb' },
        preview: { blob: previewBlob, width: preview.info.width, height: preview.info.height, sourceOrientation, processorVersion: this.processorVersion, colorSpace: 'srgb' },
      }
    } catch (error) {
      if (error instanceof MediaError) throw error
      throw invalidInput('The image could not be decoded safely.')
    }
  }

  /** Copy an already authorized local file; later edits to that file cannot affect the import.
   * @param path Host-authorized file selection; this method does not authorize arbitrary user paths.
   * @param signal Optional cancellation; absent allows completion.
   * @returns The same immutable files as byte import.
   */
  async importFile(path: string, signal?: AbortSignal): Promise<ImportedFiles> {
    checkCancelled(signal)
    const file = await open(path, constants.O_RDONLY).catch((error: unknown) => {
      // 文件选择可能已失效；跨接口只返回安全诊断，不携带用户路径。
      if (error instanceof Error) throw new MediaError('reference-unavailable', 'import', false, 'The selected image file is no longer readable.', 'Select an accessible image file again.')
      throw new MediaError('reference-unavailable', 'import', false, 'The selected image file is no longer readable.', 'Select an accessible image file again.')
    })
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.limits.maxFileBytes) throw invalidInput('The selected file exceeds the configured import limit.')
      const bytes = Buffer.alloc(stat.size + 1)
      let read = 0
      while (read < bytes.length) {
        checkCancelled(signal)
        const part = await file.read(bytes, read, bytes.length - read, read)
        if (part.bytesRead === 0) break
        read += part.bytesRead
      }
      if (read !== stat.size) throw invalidInput('The selected file changed during import.')
      return await this.importBytes(bytes.subarray(0, read), undefined, signal)
    } finally { await file.close() }
  }

  /** Read an authorized blob after checking the private path, byte count and SHA-256.
   * @param blob Reference from an authorized committed domain record.
   * @param signal Optional cancellation; absent allows completion.
   * @returns Verified bytes; missing, changed and escaped files all fail visibly.
   */
  async read(blob: BlobRef, signal?: AbortSignal): Promise<Buffer> {
    checkCancelled(signal)
    if (!/^[a-f0-9]{64}$/.test(blob.digest) || blob.storageRef !== storageRef(blob.digest)
      || !Number.isSafeInteger(blob.byteLength) || blob.byteLength <= 0 || blob.byteLength > this.limits.maxStorageBytes) throw this.unavailable()
    try {
      await this.privateDirectories(blob.digest, false)
      const root = await realpath(this.root)
      if ((await lstat(join(this.root, blob.storageRef))).isSymbolicLink()) throw this.unavailable()
      const path = await realpath(join(this.root, blob.storageRef))
      const rel = relative(root, path)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw this.unavailable()
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== blob.byteLength) throw this.unavailable()
        const bytes = Buffer.alloc(blob.byteLength + 1)
        let read = 0
        while (read < bytes.length) {
          checkCancelled(signal)
          const part = await file.read(bytes, read, bytes.length - read, read)
          if (part.bytesRead === 0) break
          read += part.bytesRead
        }
        if (read !== blob.byteLength || digest(bytes.subarray(0, read)) !== blob.digest) throw this.unavailable()
        return bytes.subarray(0, read)
      } finally { await file.close() }
    } catch (error) {
      if (error instanceof MediaError) throw error
      throw this.unavailable()
    }
  }

  /** Generate an exact-size crop from the normalized parent without enlargement.
   * @param parent Authorized normalized parent blob.
   * @param source Expected oriented dimensions, checked against the stored bytes.
   * @param rect Normalized proposal, never clamped.
   * @param usage Reduced ratio and exact output dimensions; optional acceptedFormats picks its first supported encoding, absent uses PNG.
   * @param signal Optional cancellation; absent allows completion.
   * @returns A new immutable file and the actual extraction recipe; parent bytes remain intact.
   */
  async crop(parent: BlobRef, source: ImageGeometry, rect: unknown, usage: CropUsage & { acceptedFormats?: readonly string[] }, signal?: AbortSignal): Promise<CropFile> {
    const geometry = resolveCrop(rect, source, usage)
    const bytes = await this.read(parent, signal)
    const metadata = await sharp(bytes, { limitInputPixels: this.limits.maxPixels }).metadata()
    if (metadata.width !== source.width || metadata.height !== source.height || (metadata.orientation !== undefined && metadata.orientation !== 1)) throw invalidInput('Crop coordinates do not match a normalized parent image.')
    const format = usage.acceptedFormats === undefined ? 'image/png' : usage.acceptedFormats.find(f => ['image/png', 'image/jpeg', 'image/webp', 'png', 'jpeg', 'webp'].includes(f))
    if (format === undefined) throw invalidInput('The usage has no supported output image format.')
    let pipeline = sharp(bytes, { limitInputPixels: this.limits.maxPixels }).extract(geometry.effectivePixelRect).resize(usage.targetWidth, usage.targetHeight, { fit: 'fill', withoutEnlargement: true }).toColourspace('srgb')
    const mime = format.includes('jpeg') ? 'image/jpeg' : format.includes('webp') ? 'image/webp' : 'image/png'
    pipeline = mime === 'image/jpeg' ? pipeline.jpeg() : mime === 'image/webp' ? pipeline.webp({ lossless: true }) : pipeline.png()
    const result = await pipeline.toBuffer({ resolveWithObject: true })
    checkCancelled(signal)
    if (result.info.width !== usage.targetWidth || result.info.height !== usage.targetHeight) throw invalidInput('The image processor did not produce the exact required output pixels.')
    const recipe = { algorithm: geometry.algorithm, parentDigest: parent.digest, requestedRect: geometry.requestedRect, effectivePixelRect: geometry.effectivePixelRect, encoding: mime, targetWidth: usage.targetWidth, targetHeight: usage.targetHeight, processorVersion: this.processorVersion }
    const blob = await this.put(result.data, mime, signal)
    return { blob, width: result.info.width, height: result.info.height, sourceOrientation: 1, processorVersion: this.processorVersion, colorSpace: 'srgb', requestedRect: geometry.requestedRect, effectivePixelRect: geometry.effectivePixelRect, processing: { ...recipe, recipeDigest: digest(Buffer.from(JSON.stringify(recipe))) } }
  }

  private unavailable(): MediaError { return new MediaError('reference-unavailable', 'media', false, 'Stored image bytes are missing or have changed.', 'Restore the recorded image or import it as a new asset.') }

  private async privateDirectories(hash: string, create: boolean): Promise<void> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink()) throw this.unavailable()
    const root = await realpath(this.root)
    for (const path of [join(this.root, 'blobs'), join(this.root, 'blobs', hash.slice(0, 2))]) {
      if (create) {
        try { await mkdir(path, { mode: 0o700 }) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        }
      }
      const stat = await lstat(path)
      const rel = relative(root, await realpath(path))
      if (!stat.isDirectory() || stat.isSymbolicLink() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw this.unavailable()
    }
  }

  private async storedBytes(directory: string): Promise<number> {
    let total = 0
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw this.unavailable()
      if (entry.isDirectory()) total += await this.storedBytes(path)
      else if (entry.isFile()) total += (await lstat(path)).size
    }
    return total
  }

  private async put(bytes: Buffer, mime: string, signal?: AbortSignal): Promise<BlobRef> {
    const hash = digest(bytes)
    const blob = { digest: hash, byteLength: bytes.length, mime, storageRef: storageRef(hash) }
    const write = this.writing.then(async () => {
      checkCancelled(signal)
      await this.privateDirectories(hash, true)
      const path = join(this.root, blob.storageRef)
      try { await lstat(path); await this.read(blob, signal); return } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (await this.storedBytes(this.root) + bytes.length > this.limits.maxStorageBytes) throw new MediaError('budget-exhausted', 'media', false, 'The private media storage limit is exhausted.', 'Increase the storage limit or choose a smaller import.')
      const temporary = join(this.root, `.tmp-${randomUUID()}`)
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally { await file.close() }
      try {
        checkCancelled(signal)
        // 硬链接只在完整写入后发布，且不能覆盖同摘要的既有文件。
        await link(temporary, path)
      } finally { await unlink(temporary) }
    })
    this.writing = write.catch(() => { /* Subsequent independent imports may proceed; this caller still receives its error. */ })
    try { await write } catch (error) {
      if (error instanceof MediaError) throw error
      throw new MediaError('storage-commit-failed', 'media', false, 'The private image file could not be committed.', 'Check storage permissions and free space, then retry the operation.')
    }
    return blob
  }
}
