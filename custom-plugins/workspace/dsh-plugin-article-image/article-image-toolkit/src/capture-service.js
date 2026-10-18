/** Private immutable rich snapshots for standalone MCP; legacy state.json remains independent. */
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { createCapture } from './capture.js'
import { snapshotSchema, hashSnapshot } from './capture-contracts.js'
import { failure, idSchema } from './contracts.js'

async function privateDirectory(path) {
  const absolute = resolve(path)
  if (absolute !== parse(absolute).root) await privateDirectory(dirname(absolute))
  let info
  try { info = await lstat(absolute) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (info) {
    const systemAlias = process.platform === 'darwin' && info.isSymbolicLink() && ({ '/tmp': '/private/tmp', '/var': '/private/var' })[absolute] === await realpath(absolute)
    if (!info.isDirectory() && !systemAlias) throw failure('capture-storage-path')
  } else await mkdir(absolute, { mode: 0o700 }).catch(async error => { if (error.code !== 'EEXIST' || !(await lstat(absolute)).isDirectory()) throw error })
}
async function diskUsage(path, depth = 0) {
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'writer.lock') continue
    const file = join(path, entry.name), info = await lstat(file)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isDirectory() && depth > 0)) throw failure('capture-storage-path')
    bytes += info.isDirectory() ? await diskUsage(file, depth + 1) : info.size
  }
  return bytes
}
function boundedQuality(quality) { return { status: quality.status, reasons: quality.reasons.slice(0, 10), reasonsTruncated: quality.reasons.length > 10 } }
function splitJson(value, maxChars) {
  const result = []; let part = ''
  for (const character of value) {
    if (part.length + character.length > maxChars) { result.push(part); part = '' }
    part += character
  }
  if (part) result.push(part)
  return result
}

/** Standalone storage adapter over the same capture kernel consumed by the workbench. */
export class CaptureSourceService {
  /** @param {object} config Resolved toolkit limits. @param {object} dependencies Optional capture engine and shared anonymous Cookie jar. */
  constructor(config, dependencies = {}) {
    this.config = config; this.root = join(resolve(config.dataDir), 'capture-sources')
    this.engine = dependencies.capture ?? createCapture(config.capture, { jar: dependencies.jar })
    // 录制复用同一个隔离浏览器，避免为同一页面另起一套渲染栈。
    this.renderer = dependencies.renderer ?? null
    this.life = new AbortController(); this.active = new Set()
  }

  /** Capture and atomically publish a rich snapshot without importing a sheet or mutating old records. @param {object} input URL/language. @param {AbortSignal} signal Cancellation. @param {Function|undefined} onProgress Capture event observer. @returns {Promise<object>} Bounded summary without bytes or disk paths. */
  captureSource(input, signal, onProgress) {
    const operation = this.captureAndSave(input, signal, onProgress)
    this.active.add(operation)
    void operation.finally(() => this.active.delete(operation)).catch(error => { void error })
    return operation
  }

  async captureAndSave(input, signal, onProgress) {
    const combined = AbortSignal.any([this.life.signal, ...(signal ? [signal] : [])])
    if (combined.aborted) throw failure('article-interrupted')
    const result = await this.engine.capture(input.url, { language: input.language ?? '', signal: combined, onProgress })
    const snapshot = snapshotSchema.parse(result.snapshot)
    if (snapshot.requestedUrl !== input.url || hashSnapshot(snapshot) !== snapshot.sourceHash) throw failure('capture-snapshot-integrity')
    const ready = snapshot.assets.filter(asset => asset.status === 'ready'), assets = new Map(result.assets.map(asset => [asset.id, asset.bytes]))
    if (assets.size !== result.assets.length || assets.size !== ready.length) throw failure('capture-asset-integrity')
    for (const asset of ready) {
      const bytes = assets.get(asset.id)
      if (!Buffer.isBuffer(bytes) || bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.contentHash) throw failure('capture-asset-integrity')
    }
    const json = JSON.stringify(snapshot) + '\n', size = Buffer.byteLength(json) + ready.reduce((sum, asset) => sum + asset.byteLength, 0)
    if (Buffer.byteLength(json) > this.config.maxStateBytes || size > this.config.maxCaptureDiskBytes) throw failure('capture-storage-size')
    await privateDirectory(this.root)
    let lockFailure = null, release
    try { release = await lockfile.lock(join(this.root, 'writer'), { realpath: false, onCompromised: () => { lockFailure = failure('capture-storage-lock') } }) }
    catch (error) { void error; throw failure('capture-storage-lock') }
    try {
      const staging = join(this.root, `.pending-${randomBytes(16).toString('hex')}`), target = join(this.root, snapshot.id)
      if ((await readdir(this.root)).filter(name => /^[a-f0-9]{32}$/.test(name)).length >= this.config.maxCaptureSnapshots || await diskUsage(this.root) + size > this.config.maxCaptureDiskBytes) throw failure('capture-storage-size')
      try { await lstat(target); throw failure('capture-snapshot-exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
      try {
        await mkdir(staging, { mode: 0o700 })
        for (const asset of ready) {
          if (combined.aborted) throw failure('article-interrupted')
          if (lockFailure) throw lockFailure
          await writeFile(join(staging, `${asset.id}.bin`), assets.get(asset.id), { flag: 'wx', mode: 0o600 })
        }
        await writeFile(join(staging, 'snapshot.json'), json, { flag: 'wx', mode: 0o600 })
        if (combined.aborted) throw failure('article-interrupted')
        if (lockFailure) throw lockFailure
        await rename(staging, target)
      } finally {
        const cleanup = resolve(staging)
        if (dirname(cleanup) !== resolve(this.root) || !/^\.pending-[a-f0-9]{32}$/.test(basename(cleanup))) throw failure('capture-storage-path')
        await privateDirectory(this.root)
        let info
        try { info = await lstat(cleanup) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure('capture-storage-path')
        await rm(cleanup, { recursive: true, force: true })
      }
    } finally {
      try { await release() } catch (error) { void error; throw failure('capture-storage-lock') }
    }
    return { snapshotId: snapshot.id, sourceHash: snapshot.sourceHash, title: snapshot.title.slice(0, 160),
      blocks: snapshot.blocks.length, images: snapshot.assets.length, quality: boundedQuality(snapshot.quality), generationAvailable: false }
  }

  async read(snapshotId) {
    idSchema.parse(snapshotId)
    await privateDirectory(this.root)
    const directory = join(this.root, snapshotId)
    let info
    try { info = await lstat(directory) } catch (error) { if (error.code === 'ENOENT') throw failure('capture-snapshot-missing'); throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('capture-storage-path')
    const file = join(directory, 'snapshot.json'), stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.config.maxStateBytes) throw failure('capture-storage-size')
    const snapshot = snapshotSchema.parse(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await readFile(file))))
    if (snapshot.id !== snapshotId || hashSnapshot(snapshot) !== snapshot.sourceHash) throw failure('capture-snapshot-integrity')
    return snapshot
  }

  /** Page exact rich blocks and asset metadata; oversized values use ordered reconstructable JSON fragments. @param {object} input Snapshot id and entry offset. @returns {Promise<object>} Bounded page, never image bytes or local paths. */
  sourcePage(input) {
    const operation = this.readPage(input)
    this.active.add(operation)
    void operation.finally(() => this.active.delete(operation)).catch(error => { void error })
    return operation
  }

  async readPage(input) {
    if (this.life.signal.aborted) throw failure('tools-unavailable')
    const snapshot = await this.read(input.snapshotId), entries = []
    if (this.life.signal.aborted) throw failure('tools-unavailable')
    const offset = input.offset ?? 0, budget = this.config.toolResultBytes
    const result = { snapshotId: snapshot.id, sourceHash: snapshot.sourceHash, title: snapshot.title.slice(0, 160), quality: boundedQuality(snapshot.quality), offset,
      totalEntries: 0, blocks: [], assets: [], fragments: [], nextOffset: null }
    const available = budget - Buffer.byteLength(JSON.stringify(result)) - 512
    if (available < 256) throw failure('response-size')
    const chunkChars = Math.max(20, Math.floor(available / 8))
    for (const [kind, values] of [['block', snapshot.blocks], ['asset', snapshot.assets]]) {
      for (const value of values) {
        const json = JSON.stringify(value)
        if (Buffer.byteLength(json) <= available) entries.push({ kind, value })
        else {
          const chunks = splitJson(json, chunkChars)
          for (let part = 0; part < chunks.length; part++) entries.push({ kind: 'fragment', value: { kind, id: value.id, part, totalParts: chunks.length, json: chunks[part] } })
        }
      }
    }
    result.totalEntries = entries.length
    let end = offset
    while (end < entries.length && end - offset < this.config.pageSize) {
      const entry = entries[end], field = entry.kind === 'block' ? 'blocks' : entry.kind === 'asset' ? 'assets' : 'fragments'
      const candidate = { ...result, [field]: [...result[field], entry.value], nextOffset: end + 1 < entries.length ? end + 1 : null }
      if (Buffer.byteLength(JSON.stringify(candidate)) > budget) break
      Object.assign(result, candidate); end++
    }
    if (end === offset && offset < entries.length) throw failure('response-size')
    return result
  }

  /** Cancel capture and await asset publication and owned browser teardown. @returns {Promise<void>} Quiescence. */
  async dispose() {
    this.life.abort()
    await this.engine.dispose()
    await Promise.allSettled([...this.active])
  }
}
