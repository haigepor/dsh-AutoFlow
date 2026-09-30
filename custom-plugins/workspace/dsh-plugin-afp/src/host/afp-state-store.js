import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, parse } from 'node:path'
import { resolveConfig } from '../../config-schema.js'

/** Stable filesystem segment; never exposes account names. @param {string} value Identity. @returns {string} Hash. */
export function digest(value) { return createHash('sha256').update(value).digest('hex') }

async function stat(file) {
  try { return await lstat(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function directory(file) {
  const absolute = resolve(file)
  if (absolute !== parse(absolute).root) await directory(dirname(absolute))
  const info = await stat(absolute)
  if (info && !info.isDirectory()) throw new Error('AFP storage refuses symlinks and non-directories')
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
  constructor(home, profile, maxBytes) {
    this.root = join(resolve(home), '.plugins', 'dsh-plugin-afp')
    this.profile = join(this.root, 'profiles', digest(profile))
    this.maxBytes = maxBytes
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
    try { await writeFile(temp, text, { flag: 'wx', mode: 0o600 }); await rename(temp, file) }
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
    resolveConfig(run.settings)
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
