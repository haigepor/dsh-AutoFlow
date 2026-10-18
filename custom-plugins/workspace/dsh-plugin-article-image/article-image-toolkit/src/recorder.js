/** Network capture records: private raw exchanges plus a redacted index for tools. */
import { mkdir, readFile, readdir, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { failure, idSchema } from './contracts.js'
import { inventory } from './endpoints.js'
import { buildHar, parseHar } from './har.js'

const CAPTURE_ID = /^[a-f0-9]{32}$/
const RECORDABLE = new Set(['document', 'xhr', 'fetch', 'websocket'])

/** Create the private capture root, rejecting symbolic links and foreign file types. @param {string} path Absolute directory. @returns {Promise<void>} Completion. */
async function privateDirectory(path) {
  const absolute = resolve(path)
  if (absolute !== parse(absolute).root) await privateDirectory(dirname(absolute))
  let info
  try { info = await lstat(absolute) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('capture-storage-path')
    return
  }
  await mkdir(absolute, { mode: 0o700 }).catch(async error => { if (error.code !== 'EEXIST' || !(await lstat(absolute)).isDirectory()) throw error })
}

/** Write a file atomically inside an owned directory. @param {string} file Target path. @param {string|Buffer} data Contents. @param {number} mode File mode. @returns {Promise<void>} Completion. */
async function writeAtomic(file, data, mode) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, data, { mode })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * One capture owns a private directory: a redacted index for tools and a raw directory
 * that only replay and explicit reveal read. Raw payloads never leave this store.
 */
export class Recorder {
  /** @param {object} config Resolved toolkit limits. */
  constructor(config) {
    this.config = config
    this.root = join(resolve(config.dataDir), 'captures')
    this.exportRoot = join(resolve(config.dataDir), 'exports')
  }

  /** Record one page load, delegating the browser to the caller. @param {string} url Requested URL. @param {object} options Scope, renderer and cancellation. @returns {Promise<object>} Capture summary. */
  async record(url, options) {
    const { renderer, signal, scope = this.config.recordScope, language = '' } = options
    if (!renderer) throw failure('capture-renderer-missing')
    const exchanges = []
    let dropped = 0, bytes = 0
    const limit = this.config.maxRecordEntries
    await renderer.render(url, {
      signal, markup: false,
      onExchange: entry => {
        if (scope === 'api' && !RECORDABLE.has(entry.resourceType)) return
        if (exchanges.length >= limit) { dropped += 1; return }
        const size = entry.response.bodyBytes ?? 0
        if (bytes + size > this.config.maxRecordDiskBytes) { dropped += 1; return }
        bytes += size
        exchanges.push({ ...entry, index: exchanges.length, language })
      },
    })
    if (!exchanges.length) throw failure('capture-empty')
    const endpoints = inventory(exchanges)
    const capture = {
      id: randomBytes(16).toString('hex'),
      requestedUrl: url,
      scope,
      createdAt: new Date().toISOString(),
      entries: exchanges.length,
      dropped,
      bytes,
      endpoints,
    }
    await this.persist(capture, exchanges)
    return capture
  }

  /** Publish raw exchanges and the redacted index atomically. @param {object} capture Capture metadata. @param {object[]} exchanges Recorded exchanges. @returns {Promise<void>} Completion. */
  async persist(capture, exchanges) {
    await privateDirectory(this.root)
    const staging = join(this.root, `.pending-${randomBytes(16).toString('hex')}`), target = join(this.root, capture.id)
    try {
      await mkdir(staging, { mode: 0o700 })
      await mkdir(join(staging, 'raw'), { mode: 0o700 })
      for (const exchange of exchanges) await writeFile(join(staging, 'raw', `${String(exchange.index).padStart(5, '0')}.json`), JSON.stringify(exchange), { flag: 'wx', mode: 0o600 })
      await writeFile(join(staging, 'index.json'), JSON.stringify(capture) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(staging, target)
    } finally {
      const cleanup = resolve(staging)
      if (dirname(cleanup) === resolve(this.root) && /^\.pending-[a-f0-9]{32}$/.test(basename(cleanup))) await rm(cleanup, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Read a capture index. @param {string} captureId Capture id. @returns {Promise<object>} Capture metadata. */
  async index(captureId) {
    idSchema.parse(captureId)
    const file = join(this.root, captureId, 'index.json')
    let info
    try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') throw failure('capture-missing'); throw error }
    if (!info.isFile() || info.isSymbolicLink()) throw failure('capture-storage-path')
    if (info.size > this.config.maxStateBytes) throw failure('capture-storage-size')
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await readFile(file)))
  }

  /** Read one raw exchange. @param {string} captureId Capture id. @param {number} index Entry position. @returns {Promise<object>} Raw exchange. */
  async exchange(captureId, index) {
    const capture = await this.index(captureId)
    if (!Number.isInteger(index) || index < 0 || index >= capture.entries) throw failure('capture-index')
    const file = join(this.root, captureId, 'raw', `${String(index).padStart(5, '0')}.json`)
    let info
    try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') throw failure('capture-index'); throw error }
    if (!info.isFile() || info.isSymbolicLink()) throw failure('capture-storage-path')
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await readFile(file)))
  }

  /** Append a replayed exchange to a capture so the original stays comparable. @param {string} captureId Capture id. @param {object} exchange Replay result. @returns {Promise<number>} New entry index. */
  async append(captureId, exchange) {
    const capture = await this.index(captureId)
    const index = capture.entries
    await writeFile(join(this.root, captureId, 'raw', `${String(index).padStart(5, '0')}.json`), JSON.stringify({ ...exchange, index, replayed: true }), { flag: 'wx', mode: 0o600 })
    capture.entries = index + 1
    // 索引尚未发布新条目数，显式加入本次重放，避免端点摘要滞后一条。
    capture.endpoints = inventory([...await this.exchanges(captureId), { ...exchange, index, replayed: true }])
    await writeAtomic(join(this.root, captureId, 'index.json'), JSON.stringify(capture) + '\n', 0o600)
    return index
  }

  /** Read every raw exchange of a capture. @param {string} captureId Capture id. @returns {Promise<object[]>} Ordered exchanges. */
  async exchanges(captureId) {
    const capture = await this.index(captureId)
    const result = []
    for (let index = 0; index < capture.entries; index++) result.push(await this.exchange(captureId, index))
    return result
  }

  /** Export a capture as a HAR 1.2 document on disk. @param {string} captureId Capture id. @param {string} version Package version. @returns {Promise<object>} Export summary. */
  async exportHar(captureId, version) {
    const capture = await this.index(captureId)
    const document = buildHar(await this.exchanges(captureId), { version, pages: [{ startedDateTime: capture.createdAt, id: capture.id, title: capture.requestedUrl, pageTimings: {} }] })
    const text = JSON.stringify(document)
    if (Buffer.byteLength(text) > this.config.maxHarBytes) throw failure('har-size')
    await privateDirectory(this.exportRoot)
    await writeAtomic(join(this.exportRoot, `${captureId}.har`), text, 0o600)
    return { file: `exports/${captureId}.har`, bytes: Buffer.byteLength(text), entries: capture.entries }
  }

  /** Import a HAR document from the export directory or memory. @param {object} input File name or inline document. @returns {Promise<object>} Imported capture summary. */
  async importHar(input) {
    let text
    if (input.file !== undefined) {
      // 只接受导出目录下的文件名：拒绝目录穿越与绝对路径，同时容忍 exportHar 返回的 exports/ 前缀。
      const name = basename(input.file)
      if (input.file !== name && input.file !== `exports/${name}`) throw failure('har-invalid')
      if (!/^[a-f0-9]{32}\.har$/.test(name)) throw failure('har-invalid')
      const file = join(this.exportRoot, name)
      let info
      try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') throw failure('har-invalid'); throw error }
      if (!info.isFile() || info.isSymbolicLink()) throw failure('har-invalid')
      if (info.size > this.config.maxHarBytes) throw failure('har-size')
      text = new TextDecoder('utf8', { fatal: true }).decode(await readFile(file))
    } else text = input.har
    if (typeof text !== 'string') throw failure('har-invalid')
    if (Buffer.byteLength(text) > this.config.maxHarBytes) throw failure('har-size')
    let document
    try { document = JSON.parse(text) } catch (error) { void error; throw failure('har-invalid') }
    const exchanges = parseHar(document, { maxEntries: this.config.maxRecordEntries }).map((exchange, index) => ({ ...exchange, index }))
    if (!exchanges.length) throw failure('capture-empty')
    const capture = {
      id: randomBytes(16).toString('hex'),
      requestedUrl: document?.log?.pages?.[0]?.title ?? exchanges[0].request.url,
      scope: 'har',
      createdAt: new Date().toISOString(),
      entries: exchanges.length,
      dropped: 0,
      bytes: exchanges.reduce((sum, exchange) => sum + (exchange.response.bodyBytes ?? 0), 0),
      endpoints: inventory(exchanges),
    }
    await this.persist(capture, exchanges)
    return capture
  }

  /** Remove captures beyond the configured count, oldest first. @returns {Promise<number>} Removed count. */
  async prune() {
    await privateDirectory(this.root)
    const names = (await readdir(this.root)).filter(name => CAPTURE_ID.test(name))
    if (names.length <= this.config.maxCaptureSnapshots) return 0
    const entries = []
    for (const name of names) {
      const info = await lstat(join(this.root, name, 'index.json')).catch(() => null)
      if (info) entries.push({ name, at: info.mtimeMs })
    }
    entries.sort((left, right) => left.at - right.at)
    const excess = entries.slice(0, Math.max(0, entries.length - this.config.maxCaptureSnapshots))
    for (const entry of excess) await rm(join(this.root, entry.name), { recursive: true, force: true })
    return excess.length
  }
}
