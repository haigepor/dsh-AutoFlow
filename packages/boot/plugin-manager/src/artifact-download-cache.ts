/** Digest-checked byte intervals for the verified artifact transport; file length never represents progress. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

interface Piece { readonly bytes: number; readonly sha256: string }

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }

/** Owns a separate payload and atomic interval journal, including partial intervals saved on interruption. */
export class ArtifactDownloadRangeCache {
  /** Sparse artifact bytes; only journaled intervals represent reusable progress. */
  readonly payload: string
  private readonly checkpoint: string
  private readonly records = new Map<number, Piece>()
  private saving: Promise<void> = Promise.resolve()
  private pieceBytes: number

  /**
   * @param directory - App-owned cache root; each artifact gets its own interval files.
   * @param identity - Digest of checked version, original URL, size, and official checksum.
   * @param total - Checked whole-file byte length.
   * @param pieceBytes - Interval length for a new journal; existing journals retain their interval length.
   * @param measured - Records flush and atomic journal time; omitted when no diagnostic observer is present.
   */
  constructor(private readonly directory: string, private readonly identity: string, private readonly total: number,
    pieceBytes: number, private readonly measured?: (ms: number, bytes: number) => void) {
    this.pieceBytes = pieceBytes
    this.payload = join(directory, `ranges-${identity}.part`)
    this.checkpoint = join(directory, `ranges-${identity}.json`)
  }

  /** Bytes backed by a flushed journal entry, independently of sparse file allocation. */
  get bytes(): number { return [...this.records.values()].reduce((sum, entry) => sum + entry.bytes, 0) }
  /** Number of fixed intervals in this artifact. */
  get count(): number { return Math.ceil(this.total / this.pieceBytes) }
  /**
   * Resolve the positional-write offset of one interval.
   * @param index - Zero-based interval.
   * @returns Absolute starting byte.
   */
  start(index: number): number { return index * this.pieceBytes }
  /**
   * Resolve the bounded length of one interval.
   * @param index - Zero-based interval.
   * @returns Checked length, including a shorter last interval.
   */
  length(index: number): number { return Math.min(this.pieceBytes, this.total - this.start(index)) }
  /**
   * Read the verified prefix of an interval.
   * @param index - Zero-based interval.
   * @returns Reusable prefix length.
   */
  saved(index: number): number { return this.records.get(index)?.bytes ?? 0 }

  /**
   * Keep interval recovery enabled after a concurrency configuration change.
   * @returns Whether this artifact has an interval journal, including when concurrency is now one.
   */
  async exists(): Promise<boolean> {
    try { await stat(this.checkpoint); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }

  /**
   * Verify every recorded interval or import an already verified legacy prefix into a separate file.
   * @param legacy - Original contiguous cache, retained unchanged during conversion.
   * @param legacyBytes - Prefix verified by the legacy checkpoint reader; zero imports no bytes.
   */
  async restore(legacy: string, legacyBytes: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    let document: unknown
    try { document = JSON.parse(await readFile(this.checkpoint, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (object(document) && document.version === 1 && document.identity === this.identity && document.total === this.total
      && typeof document.pieceBytes === 'number' && Number.isSafeInteger(document.pieceBytes)
      && document.pieceBytes >= 65536 && document.pieceBytes <= 64 * 1024 * 1024 && Array.isArray(document.pieces)) {
      this.pieceBytes = document.pieceBytes
      const seen = new Set<number>()
      for (const entry of document.pieces) {
        if (!object(entry) || typeof entry.index !== 'number' || !Number.isSafeInteger(entry.index)
          || entry.index < 0 || entry.index >= this.count || seen.has(entry.index)
          || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
          || entry.bytes > this.length(entry.index) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) continue
        seen.add(entry.index)
        try {
          const digest = await this.digest(entry.index, entry.bytes)
          if (digest.bytes === entry.bytes && digest.sha256 === entry.sha256) {
            this.records.set(entry.index, { bytes: entry.bytes, sha256: entry.sha256 })
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      const file = await open(this.payload, 'a', 0o600)
      await file.close()
      await this.write()
      return
    }
    await this.reset()
    if (legacyBytes > 0) await copyFile(legacy, this.payload)
    else { const file = await open(this.payload, 'w', 0o600); await file.close() }
    for (let index = 0; this.start(index) < legacyBytes; index++) {
      const bytes = Math.min(this.length(index), legacyBytes - this.start(index))
      const digest = await this.digest(index, bytes)
      if (digest.bytes !== bytes) throw new Error('Artifact download legacy prefix copy was truncated')
      this.records.set(index, { bytes, sha256: digest.sha256 })
    }
    const file = await open(this.payload, 'r+')
    try { await file.sync(); await this.write() } finally { await file.close() }
  }

  /**
   * Flush received bytes before publishing an atomic interval checkpoint.
   * @param index - Interval exclusively owned by the caller until this save settles.
   * @param bytes - Received and written prefix length, never allocation length.
   * @param sha256 - Digest of that prefix, including any restored bytes.
   * @param file - Shared positional-write handle, kept open until all saves settle.
   * @returns Completion of payload sync followed by atomic journal publication.
   */
  save(index: number, bytes: number, sha256: string, file: FileHandle): Promise<void> {
    const operation = this.saving.then(async () => {
      const started = performance.now()
      await file.sync()
      const previous = this.records.get(index)
      this.records.set(index, { bytes, sha256 })
      try { await this.write() }
      catch (error) { if (previous === undefined) this.records.delete(index); else this.records.set(index, previous); throw error }
      this.measured?.(performance.now() - started, bytes - (previous?.bytes ?? 0))
    })
    this.saving = operation.catch(() => { /* The transfer owner receives the failure and drains all interval writers. */ })
    return operation
  }

  /** Remove only this artifact's interval files after native preparation or failed whole-file verification. */
  async reset(): Promise<void> {
    await this.saving
    for (const path of [this.checkpoint, this.payload]) {
      try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.records.clear()
  }

  private async digest(index: number, bytes: number): Promise<{ bytes: number; sha256: string }> {
    const digest = createHash('sha256')
    let received = 0
    for await (const chunk of createReadStream(this.payload, { start: this.start(index), end: this.start(index) + bytes - 1 })) {
      const buffer = chunk as Buffer
      received += buffer.length; digest.update(buffer)
    }
    return { bytes: received, sha256: digest.digest('hex') }
  }

  private async write(): Promise<void> {
    await writeFileAtomic(this.checkpoint, `${JSON.stringify({ version: 1, identity: this.identity, total: this.total,
      pieceBytes: this.pieceBytes, pieces: [...this.records].map(([index, entry]) => ({ index, ...entry })) })}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}
