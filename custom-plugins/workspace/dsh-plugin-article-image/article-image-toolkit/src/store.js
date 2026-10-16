/** Profile-isolated records with cross-process writer coordination and atomic commits. */
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { itemSchema, failure } from './contracts.js'
import { mappingSchema } from './config.js'

const stateSchema = z.object({ schema: z.literal(1), source: z.object({ url: z.string(), mapping: mappingSchema, importedAt: z.string() }).strict().nullable(), items: z.array(itemSchema) }).strict()

/** Ensure a directory chain exists, rejecting a non-directory at any level. @param {string} path Target directory. @returns {Promise<void>} Completion. */
async function ensureDirectory(path) {
  const absolute = resolve(path)
  if (dirname(absolute) !== absolute) await ensureDirectory(dirname(absolute))
  let info
  // stat 而非 lstat：macOS 的 /tmp、/var 是指向 /private 的符号链接，跟随链接才能接受这类合法目录。
  try { info = await stat(absolute) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (info) {
    if (!info.isDirectory()) throw failure('storage-path')
    return
  }
  await mkdir(absolute, { mode: 0o700 }).catch(async error => { if (error.code !== 'EEXIST' || !(await stat(absolute)).isDirectory()) throw error })
}

/** Acquire an exclusive writer lock with stale-holder recovery. @param {string} lock Lock file path. @param {number} staleMs Age after which a lock is reclaimed. @returns {Promise<Function>} Release function. */
async function acquireLock(lock, staleMs) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`)
      await handle.close()
      return async () => { await unlink(lock).catch(() => {}) }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let age = 0
    try { age = Date.now() - (await stat(lock)).mtimeMs } catch { continue }
    // 崩溃的写入者不会释放锁；超过陈旧阈值后直接接管，避免永久阻塞。
    if (age > staleMs) await rm(lock, { force: true }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw failure('storage-lock')
}

/** Write a file atomically: temp file in the target directory, then rename. @param {string} file Target path. @param {string} text Contents. @param {number} mode File mode. @returns {Promise<void>} Completion. */
async function writeAtomic(file, text, mode) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, text, { mode })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Atomic state owner; readers see complete commits and never credentials. */
export class Store {
  constructor(dataDir, config) {
    this.root = resolve(dataDir)
    this.file = join(this.root, 'state.json')
    this.lock = join(this.root, 'state.lock')
    this.config = config
  }
  /** Read the current state, returning an empty record before the first import. @returns {Promise<object>} Validated state. */
  async read() {
    await ensureDirectory(this.root)
    let info
    try { info = await stat(this.file) } catch (error) { if (error.code === 'ENOENT') return { schema: 1, source: null, items: [] }; throw error }
    if (!info.isFile() || info.size > this.config.maxStateBytes) throw failure('storage-size')
    return stateSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(this.file))))
  }
  /** Apply a mutation under the writer lock and commit it atomically. @param {Function} operation State mutation returning a result. @returns {Promise<unknown>} Operation result. */
  async update(operation) {
    await ensureDirectory(this.root)
    const release = await acquireLock(this.lock, 30000)
    try {
      const state = await this.read(), result = await operation(state)
      const text = JSON.stringify(stateSchema.parse(state)) + '\n'
      if (Buffer.byteLength(text) > this.config.maxStateBytes) throw failure('storage-size')
      await writeAtomic(this.file, text, 0o600)
      return result
    } finally { await release() }
  }
}
