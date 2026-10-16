/** Profile-isolated records with cross-process writer coordination. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { itemSchema, failure } from '../shared/contracts.js'
import { mappingSchema } from '../../config-schema.js'
const stateSchema = z.object({ schema: z.literal(1), source: z.object({ url: z.string(), mapping: mappingSchema, importedAt: z.string() }).strict().nullable(), items: z.array(itemSchema) }).strict()

/** Hash a stable string. @param {string} text Identity. @returns {string} Hex digest. */
export function hash(text) { return createHash('sha256').update(text).digest('hex') }
async function directory(path) {
  const absolute = resolve(path)
  if (absolute !== parse(absolute).root) await directory(dirname(absolute))
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
    this.file = join(this.root, 'state.json'); this.config = config
  }
  async read() {
    await directory(this.root)
    let info
    try { info = await lstat(this.file) } catch (error) { if (error.code === 'ENOENT') return { schema: 1, source: null, items: [] }; throw error }
    if (!info.isFile() || info.size > this.config.maxStateBytes) throw failure('storage-size')
    return stateSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(this.file))))
  }
  async update(operation) {
    await directory(this.root)
    return withFileLock(this.file, async () => {
      const state = await this.read(), result = await operation(state)
      const text = JSON.stringify(stateSchema.parse(state)) + '\n'
      if (Buffer.byteLength(text) > this.config.maxStateBytes) throw failure('storage-size')
      await writeFileAtomic(this.file, text, { mode: 0o600, dirMode: 0o700 })
      return result
    })
  }
}
