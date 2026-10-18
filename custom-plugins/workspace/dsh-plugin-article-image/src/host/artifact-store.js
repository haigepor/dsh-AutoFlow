/** Immutable JSON records and verified image bytes outside the small profile index. */
import { randomUUID, createHash } from 'node:crypto'
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { hash, storageDirectory } from './store.js'
import { idSchema, hashSchema, failure } from '../shared/contracts.js'

const kinds = z.enum(['snapshots', 'analyses', 'plans', 'inputs'])
const envelopeSchema = z.object({ hash: hashSchema, value: z.json() }).strict()

/** Private artifact owner; callers validate each record's domain schema after reading. */
export class ArtifactStore {
  /** @param {string} root Profile-private path. @param {object} config Explicit byte limits. */
  constructor(root, config) { this.root = root; this.config = config }

  /** Publish a new immutable JSON record. @param {string} kind Record collection. @param {object} value Validated domain value. @returns {Promise<string>} Opaque record identifier. */
  async put(kind, value) {
    const directory = join(this.root, kinds.parse(kind))
    await storageDirectory(directory)
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json) > this.config.maxDocumentBytes) throw failure('storage-size')
    const id = randomUUID().replaceAll('-', '')
    await writeFileAtomic(join(directory, `${id}.json`), JSON.stringify({ hash: hash(json), value }) + '\n', { mode: 0o600, dirMode: 0o700 })
    return id
  }

  /** Verify and read one immutable record. @param {string} kind Collection. @param {string} id Opaque record ID. @returns {Promise<object>} Domain value for parser validation. */
  async get(kind, id) {
    const directory = join(this.root, kinds.parse(kind)), path = join(directory, `${idSchema.parse(id)}.json`)
    await storageDirectory(directory)
    const info = await lstat(path)
    if (!info.isFile()) throw failure('storage-path')
    if (info.size > this.config.maxDocumentBytes + 256) throw failure('storage-size')
    let envelope
    try { envelope = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)))) }
    catch (error) { void error; throw failure('storage-invalid') }
    if (envelope.hash !== hash(JSON.stringify(envelope.value))) throw failure('storage-integrity')
    return envelope.value
  }

  /** Save an image once by its verified bytes. @param {object} asset Image bytes and contentHash. @returns {Promise<void>} Completion after atomic publication. */
  async putAsset(asset) {
    const digest = hashSchema.parse(asset.contentHash), bytes = asset.bytes
    if (!Buffer.isBuffer(bytes) || bytes.length > this.config.maxAssetBytes) throw failure('storage-size')
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw failure('storage-integrity')
    const directory = join(this.root, 'assets'), path = join(directory, `${digest}.bin`)
    await storageDirectory(directory)
    await withFileLock(path, async () => {
      try { await lstat(path); await this.getAsset(digest); return }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      const temporary = join(directory, `${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } finally {
        // Only this operation's unpredictable temporary file is eligible for cleanup.
        await rm(temporary, { force: true })
      }
    })
  }

  /** Read verified original bytes by content digest. @param {string} digest Content hash. @returns {Promise<Buffer>} Original local bytes. */
  async getAsset(digest) {
    const directory = join(this.root, 'assets'), path = join(directory, `${hashSchema.parse(digest)}.bin`)
    await storageDirectory(directory)
    const info = await lstat(path)
    if (!info.isFile()) throw failure('storage-path')
    if (info.size > this.config.maxAssetBytes) throw failure('storage-size')
    const bytes = await readFile(path)
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw failure('storage-integrity')
    return bytes
  }
}
