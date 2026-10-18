/** Profile-isolated records with cross-process writer coordination. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { itemSchema, failure } from '../shared/contracts.js'
import { mappingSchema } from '../../config-schema.js'
const stateFields = { source: z.object({ url: z.string(), mapping: mappingSchema, importedAt: z.string() }).strict().nullable(), items: z.array(itemSchema) }
const stateSchema = z.object({ schema: z.literal(2), ...stateFields }).strict()
const legacySchema = z.object({ schema: z.literal(1), ...stateFields }).strict()

/** Hash a stable string. @param {string} text Identity. @returns {string} Hex digest. */
export function hash(text) { return createHash('sha256').update(text).digest('hex') }
/** Create a private directory chain without following user-controlled links. @param {string} path Directory. @returns {Promise<void>} Completion after validation. */
export async function storageDirectory(path) {
  const absolute = resolve(path)
  if (absolute !== parse(absolute).root) await storageDirectory(dirname(absolute))
  let info
  try { info = await lstat(absolute) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (info) {
    const systemAlias = process.platform === 'darwin' && info.isSymbolicLink()
      && ({ '/tmp': '/private/tmp', '/var': '/private/var' })[absolute] === await realpath(absolute)
    if (!info.isDirectory() && !systemAlias) throw failure('storage-path')
  } else await mkdir(absolute, { mode: 0o700 }).catch(async error => { if (error.code !== 'EEXIST' || !(await lstat(absolute)).isDirectory()) throw error })
}

/** Atomic state owner; readers see complete commits and never credentials. */
export class Store {
  constructor(home, profile, config) {
    this.root = join(resolve(home), '.plugins', 'dsh-plugin-article-image', 'profiles', hash(resolve(profile)))
    this.file = join(this.root, 'state.v2.json'); this.legacyFile = join(this.root, 'state.json'); this.config = config
    this.writes = Promise.resolve()
  }
  async readFile(path) {
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (!info.isFile() || info.size > this.config.maxStateBytes) throw failure('storage-size')
    return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
  }
  async readUnlocked() {
    const current = await this.readFile(this.file)
    if (current !== null) return stateSchema.parse(JSON.parse(current))
    const original = await this.readFile(this.legacyFile)
    if (original === null) return { schema: 2, source: null, items: [] }
    const legacy = legacySchema.parse(JSON.parse(original))
    const state = stateSchema.parse({ ...legacy, schema: 2, items: legacy.items.map(item => ({ ...item, legacy: Boolean(item.article || item.plan), approval: item.approval })) })
    const backupDirectory = join(this.root, 'legacy')
    await storageDirectory(backupDirectory)
    const backup = join(backupDirectory, `state.v1.${hash(original)}.json`)
    const existing = await this.readFile(backup)
    if (existing !== null && existing !== original) throw failure('storage-integrity')
    if (existing === null) await writeFileAtomic(backup, original, { mode: 0o600, dirMode: 0o700 })
    // Publish only a fully validated successor; the legacy source is never modified.
    await writeFileAtomic(this.file, JSON.stringify(state) + '\n', { mode: 0o600, dirMode: 0o700 })
    return state
  }
  async read() {
    await storageDirectory(this.root)
    const current = await this.readFile(this.file)
    if (current !== null) return stateSchema.parse(JSON.parse(current))
    return this.serialize(() => withFileLock(this.file, () => this.readUnlocked()))
  }
  /** Queue this owner's writers before taking the cross-process lock; rejection never poisons later writes. @param {Function} operation Owned transaction. @returns {Promise<unknown>} Transaction result. */
  serialize(operation) {
    const pending = this.writes.then(operation)
    this.writes = pending.then(() => {}, () => {})
    return pending
  }
  update(operation) {
    return this.serialize(async () => {
      await storageDirectory(this.root)
      return withFileLock(this.file, async () => {
        const state = await this.readUnlocked(), result = await operation(state)
        const text = JSON.stringify(stateSchema.parse(state)) + '\n'
        if (Buffer.byteLength(text) > this.config.maxStateBytes) throw failure('storage-size')
        await writeFileAtomic(this.file, text, { mode: 0o600, dirMode: 0o700 })
        return result
      })
    })
  }
}
