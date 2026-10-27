import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, parse } from 'node:path'
import { resolveConfig } from '../../config-schema.js'
import { setTimeout as delay } from 'node:timers/promises'
import { CATEGORY_PROFILES } from '../vendor/auto-afp-img/afp-photo-search.mjs'

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
function validateBindings(values) {
  const keys = CATEGORY_PROFILES.map(profile => profile.key)
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.entries(values).some(([key, value]) => !keys.includes(key) || value !== null && (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.id !== 'string' || !value.id || value.id.length > 256 || /[\u0000-\u001f\u007f]/.test(value.id)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256
      || /[\u0000-\u001f\u007f]/.test(value.name) || Object.keys(value).some(field => !['id', 'name'].includes(field))))) throw new Error('Invalid AFP category bindings')
  const ids = Object.values(values).filter(Boolean).map(value => value.id)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate AFP category bindings')
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid AFP lock owner')
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

function historyFingerprint(info) {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}
function historyGuid(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}
function validateHistory(record, account) {
  if (record.account !== account || !record.records || typeof record.records !== 'object' || Array.isArray(record.records)) throw new Error('Invalid AFP approved history')
  for (const [runId, entry] of Object.entries(record.records)) {
    id(runId)
    if (!entry || typeof entry.fingerprint !== 'string' || entry.account !== null && typeof entry.account !== 'string'
      || !Array.isArray(entry.ids) || entry.ids.some(value => typeof value !== 'string' || !value)
      || !Array.isArray(entry.guids) || entry.guids.some(value => !historyGuid(value))) throw new Error('Invalid AFP approved history')
  }
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
    if (!info) throw Object.assign(new Error('Missing AFP record'), { code: 'ENOENT' })
    if (!info.isFile() || info.size > this.maxBytes) throw new Error('Unsafe or oversized AFP record')
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
  /** Read and validate one active report, or its archived copy when explicitly requested.
   * @param {string} runId Saved report UUID.
   * @param {object} [options] archived selects the archive; omission reads only active reports.
   * @returns {Promise<object>} Validated report with resolved settings; missing and invalid reports reject.
   */
  async readRun(runId, { archived = false } = {}) {
    const run = await this.read(join(this.profile, archived ? 'archived-runs' : 'runs', `${id(runId)}.json`))
    if (run.id !== runId || !Array.isArray(run.categories) || !run.categories.length || run.categories.some(item => typeof item !== 'string')
      || !run.groups || typeof run.groups !== 'object' || !Array.isArray(run.decisions)
      || !['created', 'running', 'ready', 'paused', 'cancelled', 'failed'].includes(run.status)
      || (run.pending !== null && (!run.pending || !Array.isArray(run.pending.candidates) || !run.categories.includes(run.pending.category)))) throw new Error('Invalid AFP run record')
    // 已发布的 schema:1 运行记录保留原设置，并显式补齐新增部署默认值。
    run.settings = resolveConfig(run.settings)
    if (run.bindings !== undefined) validateBindings(run.bindings)
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
  /** Read prior completed approvals, including archived and partially completed reports.
   * @param {string} account Authenticated account; callers hold its existing account lock.
   * @param {string} currentRunId Current report, whose decisions remain owned by its workflow.
   * @param {AbortSignal} signal Preparation cancellation and deadline.
   * @returns {Promise<object>} Independent canonical-ID and GUID sets; incomplete or untrusted history rejects.
   * The derived index reuses only unchanged source files, and never changes the original reports.
   */
  async readApprovedHistory(account, currentRunId, signal) {
    if (typeof account !== 'string' || !account) throw new Error('Invalid AFP history account')
    id(currentRunId)
    signal.throwIfAborted()
    const file = join(this.profile, 'approved-history', `${digest(account)}.json`)
    let cached = { schema: 1, account, records: {} }
    try { cached = await this.read(file) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    validateHistory(cached, account)
    const sources = new Map()
    for (const kind of ['runs', 'archived-runs']) {
      const folder = join(this.profile, kind)
      await directory(folder)
      for (const name of await readdir(folder)) if (/^[a-f0-9-]{36}\.json$/.test(name)) sources.set(id(name.slice(0, -5)), kind)
    }
    const records = {}, ids = new Set(), guids = new Set()
    for (const [runId, preferred] of sources) {
      signal.throwIfAborted()
      if (runId === currentRunId) {
        if (cached.records[runId]) records[runId] = cached.records[runId]
        continue
      }
      let entry
      // 归档是一次原子移动；只为这次位置变化补读另一目录，不能把消失的历史当空集。
      for (let attempt = 0; attempt < 2; attempt++) {
        let kind = preferred
        const alternate = preferred === 'runs' ? 'archived-runs' : 'runs'
        if (attempt && await stat(join(this.profile, alternate, `${runId}.json`))) kind = alternate
        const source = join(this.profile, kind, `${runId}.json`)
        const before = await stat(source)
        if (!before && attempt === 0) continue
        if (!before?.isFile() || before.size > this.maxBytes) throw new Error('Unsafe or missing AFP history source')
        const fingerprint = historyFingerprint(before), previous = cached.records[runId]
        if (previous?.fingerprint === fingerprint) { entry = previous; break }
        let run
        try { run = await this.readRun(runId, { archived: kind === 'archived-runs' }) }
        catch (error) { if (error.code === 'ENOENT' && attempt === 0) continue; throw error }
        const after = await stat(source)
        if (!after || historyFingerprint(after) !== fingerprint) {
          if (attempt === 0) continue
          throw new Error('AFP history changed while reading')
        }
        entry = { fingerprint, account: run.account ?? null, ids: [], guids: [] }
        if (run.account === account) {
          const photos = new Map(Object.values(run.groups).flatMap(group => group.candidates.map(photo => [photo.id, photo])))
          const keptIds = new Set(), keptGuids = new Set()
          for (const decision of run.decisions) {
            if (!decision || typeof decision.id !== 'string' || !decision.id || typeof decision.keep !== 'boolean') throw new Error('Invalid AFP historical decision')
            if (!decision.keep || decision.reason === 'preview or vision request failed') continue
            keptIds.add(decision.id)
            const guid = photos.get(decision.id)?.guid
            if (historyGuid(guid)) keptGuids.add(guid)
          }
          entry.ids = [...keptIds]; entry.guids = [...keptGuids]
        }
        break
      }
      if (!entry) throw new Error('AFP history could not be verified')
      records[runId] = entry
      if (entry.account === account) {
        for (const value of entry.ids) ids.add(value)
        for (const value of entry.guids) guids.add(value)
      }
    }
    signal.throwIfAborted()
    if (JSON.stringify(records) !== JSON.stringify(cached.records)) await this.write(file, { schema: 1, account, records })
    signal.throwIfAborted()
    return { ids, guids }
  }
  /** Archive under the same run lock as refresh; records and their references remain recoverable. */
  async archiveRun(runId) {
    id(runId)
    return this.lock(`run:${runId}`, async () => {
      await this.readRun(runId)
      const destination = join(this.profile, 'archived-runs', `${runId}.json`)
      await directory(dirname(destination))
      if (await stat(destination)) throw new Error('AFP archive already exists')
      await rename(join(this.profile, 'runs', `${runId}.json`), destination)
      return { runId, archived: true }
    })
  }
  async readPlan(planId) {
    const plan = await this.read(join(this.profile, 'plans', `${id(planId)}.json`))
    if (plan.id !== planId || typeof plan.owner !== 'string' || typeof plan.account !== 'string'
      || !['append', 'replace', 'clear'].includes(plan.operation)
      || !['planned', 'executing', 'completed', 'failed', 'cancelled'].includes(plan.state)
      || !Number.isSafeInteger(plan.expiresAt) || typeof plan.remoteHash !== 'string'
      || plan.bindingHash !== undefined && (typeof plan.bindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.bindingHash))
      || !Array.isArray(plan.targets) || !plan.targets.length
      || plan.targets.some(target => typeof target?.category !== 'string' || typeof target?.name !== 'string'
        || (target.id !== null && typeof target.id !== 'string') || !Array.isArray(target.docs)
        || !Number.isSafeInteger(target.existing) || target.existing < 0)) throw new Error('Invalid AFP plan record')
    return plan
  }
  savePlan(plan) { return this.write(join(this.profile, 'plans', `${id(plan.id)}.json`), plan) }
  /** Bindings are profile/account-local; null disables legacy name matching without rewriting runs. */
  async readBindings(account) {
    if (typeof account !== 'string' || !account) throw new Error('Invalid AFP binding account')
    let record
    try { record = await this.read(join(this.profile, 'bindings', `${digest(account)}.json`)) }
    catch (error) { if (error.code === 'ENOENT') return { schema: 1, account, values: {} }; throw error }
    if (record.account !== account) throw new Error('Invalid AFP binding account')
    validateBindings(record.values)
    return record
  }
  async saveBindings(account, values) {
    if (typeof account !== 'string' || !account) throw new Error('Invalid AFP binding account')
    validateBindings(values)
    await this.write(join(this.profile, 'bindings', `${digest(account)}.json`), { schema: 1, account, values })
  }
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
