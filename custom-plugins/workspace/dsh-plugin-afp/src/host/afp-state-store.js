import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, parse } from 'node:path'
import { resolveConfig } from '../../config-schema.js'
import { setTimeout as delay } from 'node:timers/promises'

/** Stable filesystem segment; never exposes account names. @param {string} value Identity. @returns {string} Hash. */
export function digest(value) { return createHash('sha256').update(value).digest('hex') }

/** Atomically replace a record without unlinking the previous version.
 * @param {string} source Complete temporary file.
 * @param {string} destination Existing or new record path.
 * @param {object} options Resolved retry budget and filesystem provider.
 * @returns {Promise<void>} Resolves after replacement; rejects the last rename error when the budget expires.
 */
export async function replaceRecordFile(source, destination, { retries, delayMs, platform = process.platform, renameFile = rename }) {
  for (let attempt = 0; ; attempt++) {
    try { await renameFile(source, destination); return }
    catch (error) {
      // POSIX 权限拒绝是持续错误；仅 Windows 的共享占用把 EPERM/EACCES 当作暂时失败。
      const transient = ['EBUSY', 'EINTR'].includes(error.code) || platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)
      if (!transient || attempt >= retries) throw error
      await delay(delayMs)
    }
  }
}

async function stat(file) {
  try { return await lstat(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function directory(file) {
  const absolute = resolve(file)
  if (absolute !== parse(absolute).root) await directory(dirname(absolute))
  const info = await stat(absolute)
  if (info && !info.isDirectory()) {
    // macOS 的系统临时目录经过这两个固定别名；其他链接仍拒绝，不能重定向 profile 存储。
    const systemTarget = process.platform === 'darwin' && ({ '/var': '/private/var', '/tmp': '/private/tmp' })[absolute]
    if (!systemTarget || !info.isSymbolicLink() || await realpath(absolute) !== systemTarget) throw new Error('AFP storage refuses symlinks and non-directories')
    await directory(systemTarget)
  }
  if (!info) {
    try { await mkdir(absolute, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST' || !(await stat(absolute))?.isDirectory()) throw error }
  }
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error('Invalid AFP id')
  return value
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid AFP lock owner')
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

/** Profile-isolated JSON records and Home-wide process locks. No credential values are stored here. */
export class Store {
  constructor(home, profile, maxBytes, config = resolveConfig()) {
    this.root = join(resolve(home), '.plugins', 'dsh-plugin-afp')
    this.profile = join(this.root, 'profiles', digest(profile))
    this.maxBytes = maxBytes
    this.writeRetryCount = config.stateWriteRetryCount
    this.writeRetryDelayMs = config.stateWriteRetryDelayMs
  }
  async read(file) {
    await directory(dirname(file))
    const info = await stat(file)
    if (!info?.isFile() || info.size > this.maxBytes) throw new Error('Missing, unsafe or oversized AFP record')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
    const record = JSON.parse(text)
    if (record?.schema !== 1) throw new Error('Unsupported AFP record schema')
    return record
  }
  async write(file, record) {
    await directory(dirname(file))
    const text = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(text) > this.maxBytes) throw new Error('AFP state exceeds maxStateBytes')
    const info = await stat(file)
    if (info && !info.isFile()) throw new Error('Unsafe AFP record')
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
      await replaceRecordFile(temp, file, { retries: this.writeRetryCount, delayMs: this.writeRetryDelayMs })
    }
    finally { try { await unlink(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  async createRun(categories, settings) {
    const run = { schema: 1, id: randomUUID(), categories, settings, status: 'created', createdAt: Date.now(),
      searchState: null, pending: null, groups: {}, decisions: [] }
    await this.saveRun(run)
    return run
  }
  async readRun(runId) {
    const run = await this.read(join(this.profile, 'runs', `${id(runId)}.json`))
    if (run.id !== runId || !Array.isArray(run.categories) || !run.categories.length || run.categories.some(item => typeof item !== 'string')
      || !run.groups || typeof run.groups !== 'object' || !Array.isArray(run.decisions)
      || !['created', 'running', 'ready', 'paused', 'cancelled', 'failed'].includes(run.status)
      || (run.pending !== null && (!run.pending || !Array.isArray(run.pending.candidates) || !run.categories.includes(run.pending.category)))) throw new Error('Invalid AFP run record')
    // 已发布的 schema:1 运行记录保留原设置，并显式补齐新增部署默认值。
    run.settings = resolveConfig(run.settings)
    if (run.reviews !== undefined && (!Array.isArray(run.reviews) || run.reviews.some(item => typeof item?.id !== 'string'
      || !run.categories.includes(item.category) || !Number.isSafeInteger(item.attempts) || item.attempts < 0
      || !['preview', 'vision', 'confirmation', 'done', 'failed'].includes(item.phase)))) throw new Error('Invalid AFP review checkpoint')
    if (run.dedup !== undefined && (!run.dedup || typeof run.dedup.collections !== 'object'
      || !run.dedup.collections || Object.values(run.dedup.collections).some(item => typeof item?.fingerprint !== 'string'
        || !Number.isSafeInteger(item.readAt) || !Array.isArray(item.ids) || item.ids.some(id => typeof id !== 'string')))) throw new Error('Invalid AFP dedup checkpoint')
    for (const group of Object.values(run.groups)) {
      if (!Array.isArray(group?.candidates) || !Number.isSafeInteger(group.batches) || group.batches < 0) throw new Error('Invalid AFP run group')
    }
    return run
  }
  saveRun(run) { return this.write(join(this.profile, 'runs', `${id(run.id)}.json`), run) }
  async readPlan(planId) {
    const plan = await this.read(join(this.profile, 'plans', `${id(planId)}.json`))
    if (plan.id !== planId || typeof plan.owner !== 'string' || typeof plan.account !== 'string'
      || !['append', 'replace', 'clear'].includes(plan.operation)
      || !['planned', 'executing', 'completed', 'failed', 'cancelled'].includes(plan.state)
      || !Number.isSafeInteger(plan.expiresAt) || typeof plan.remoteHash !== 'string'
      || !Array.isArray(plan.targets) || !plan.targets.length
      || plan.targets.some(target => typeof target?.category !== 'string' || typeof target?.name !== 'string'
        || (target.id !== null && typeof target.id !== 'string') || !Array.isArray(target.docs)
        || !Number.isSafeInteger(target.existing) || target.existing < 0)) throw new Error('Invalid AFP plan record')
    return plan
  }
  savePlan(plan) { return this.write(join(this.profile, 'plans', `${id(plan.id)}.json`), plan) }
  /** Read the newest compact download outcomes; no destination paths or media URLs are persisted. */
  async readDownloads(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid AFP download history limit')
    let files
    try { files = await readdir(join(this.profile, 'downloads')) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const names = files.filter(file => /^[a-f0-9-]{36}\.json$/.test(file))
    const records = []
    for (const file of names) records.push(await this.readDownload(file.slice(0, -5)))
    return records.sort((left, right) => right.createdAt - left.createdAt).slice(0, limit)
  }
  /** Read and validate one persisted download outcome before projecting it to the page. */
  async readDownload(downloadId) {
    const record = await this.read(join(this.profile, 'downloads', `${id(downloadId)}.json`))
    if (record.id !== downloadId || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)
      || !['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(record.status)
      || !Array.isArray(record.items) || record.items.length > 120
      || record.items.some(item => !item || typeof item.photoId !== 'string' || item.photoId.length > 256
        || !['queued', 'running', 'completed', 'failed', 'pending', 'cancelled'].includes(item.status)
        || typeof item.title !== 'string' || typeof item.rendition !== 'string'
        || item.fileName !== null && (typeof item.fileName !== 'string' || item.fileName !== basename(item.fileName))
        || item.errorCode !== null && typeof item.errorCode !== 'string')) throw new Error('Invalid AFP download record')
    return record
  }
  async saveDownload(record) {
    await this.write(join(this.profile, 'downloads', `${id(record.id)}.json`), record)
    const files = await readdir(join(this.profile, 'downloads'))
    const records = []
    for (const file of files.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) records.push(await this.readDownload(file.slice(0, -5)))
    for (const stale of records.sort((left, right) => right.createdAt - left.createdAt).slice(30)) {
      await unlink(join(this.profile, 'downloads', `${stale.id}.json`))
    }
  }
  /** Refuse live competitors; recover only a complete lock whose process is gone. */
  async lock(key, operation) {
    const file = join(this.root, 'locks', `${digest(key)}.json`)
    await directory(dirname(file))
    let handle
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await open(file, 'wx', 0o600); break }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        // Recovery is serialized; two processes must never unlink each other's replacement lock.
        const recoveryFile = `${file}.recovery`
        let recovery
        try { recovery = await open(recoveryFile, 'wx', 0o600) }
        catch (failure) { if (failure.code === 'EEXIST') throw new Error('AFP lock recovery busy; inspect its owner before removing the recovery file'); throw failure }
        try {
          const current = await stat(file)
          if (current) {
            const lock = await this.read(file)
            if (alive(lock.pid)) throw new Error('AFP operation busy in another task/profile')
            await unlink(file)
          }
        } finally { await recovery.close(); await unlink(recoveryFile) }
      }
    }
    if (!handle) throw new Error('AFP operation busy')
    try { await handle.writeFile(JSON.stringify({ schema: 1, pid: process.pid }) + '\n', 'utf8'); return await operation() }
    finally { await handle.close(); await unlink(file) }
  }
}
