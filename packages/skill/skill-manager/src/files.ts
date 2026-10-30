/** Local skill inventory and recoverable file replacement for trusted settings clients. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import type {
  SkillBackup,
  SkillDirectoryId,
  ManagedDirectory,
  ManagedSkill,
  ManagedSkillId,
  SkillManagementError,
  SkillFileEntry,
} from './types.ts'

const installation = z.object({
  repository: z.string(),
  path: z.string(),
  commit: z.string(),
  files: z.record(z.string(), z.string()),
})
const stateSchema = z.object({
  version: z.literal(1),
  disabled: z.array(z.string()),
  roots: z.array(z.string()),
  categories: z.array(z.string()),
  arrangement: z.record(z.string(), z.object({ category: z.string(), order: z.number() })),
  installations: z.record(z.string(), installation),
  backups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      target: z.string(),
      time: z.string(),
      kind: z.enum(['trash', 'update']),
      directoryId: z.string(),
      installation: installation.optional(),
    }),
  ),
  repositories: z.array(z.object({ repository: z.string(), ref: z.string() })).default([]),
})
/** Persisted management policy and recoverable installation identities. */
export type ManagerState = z.infer<typeof stateSchema>

/** A stable rejection code without exposing filesystem exception text. */
export class ManagementError extends Error {
  /**
   * @param code - localized business failure.
   */
  constructor(readonly code: SkillManagementError) {
    super(code)
  }
}
/** Hash bytes for identity and concurrent-edit checks.
 *
 * @param value - bytes or UTF-8 text.
 *
 * @returns SHA-256 digest.

 */
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
/** Identify a source using its normalized absolute path.
 *
 * @param path - source directory.
 *
 * @returns opaque source identity.

 */
export function directoryId(path: string): SkillDirectoryId {
  return brandString<SkillDirectoryId>(digest(resolve(path)))
}
/** Identify an installed skill copy by its instruction path.
 *
 * @param path - absolute instruction path or provider identity.
 *
 * @returns opaque copy identity.

 */
export function skillId(path: string): ManagedSkillId {
  return brandString<ManagedSkillId>(digest(path))
}
/** Distinguish absence from permission or storage failures.
 *
 * @param path - local path.
 *
 * @returns file facts, or undefined only for a missing path.

 */
export async function statOptional(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
/** Resolve a relative archive member without escaping its destination.
 *
 * @param root - absolute destination.
 *
 * @param name - relative slash-separated member.
 *
 * @returns confined absolute path.

 */
export function containedPath(root: string, name: string): string {
  if (
    !name ||
    isAbsolute(name) ||
    name.includes('\\') ||
    name
      .split('/')
      .some(
        part =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[:\x00-\x1f]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new ManagementError('unsafe-path')
  const path = resolve(root, name)
  if (!relative(resolve(root), path) || relative(resolve(root), path).startsWith(`..${sep}`))
    throw new ManagementError('unsafe-path')
  return path
}
/** Reject linked directory ancestors before any write, including Windows junctions.
 *
 * @param path - exact write destination or containing directory.

 */
export async function assertUnlinked(path: string): Promise<void> {
  let current = resolve(path)
  for (;;) {
    const info = await statOptional(current)
    if (info?.isSymbolicLink()) throw new ManagementError('read-only')
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}
/** Read a bounded, link-free bundle for import, backup and version comparison.
 *
 * @param root - bundle directory.
 *
 * @param maxBytes - total uncompressed byte limit.
 *
 * @param maxFiles - maximum file count.
 *
 * @returns relative members and bytes.

 */
export async function readTree(root: string, maxBytes: number, maxFiles: number): Promise<Record<string, Uint8Array>> {
  const files = Object.create(null) as Record<string, Uint8Array>
  let total = 0
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`
      const child = containedPath(root, name)
      if (entry.isSymbolicLink()) throw new ManagementError('read-only')
      if (entry.isDirectory()) await visit(child, `${name}/`)
      else if (entry.isFile()) {
        const size = (await lstat(child)).size
        if (total + size > maxBytes || Object.keys(files).length >= maxFiles) throw new ManagementError('too-large')
        const bytes = await readFile(child)
        total += bytes.length
        if (total > maxBytes) throw new ManagementError('too-large')
        files[name] = bytes
      }
    }
  }
  await visit(root, '')
  return files
}
/** List bundle members without reading resource contents or following links.
 * @param root - skill bundle directory.
 * @param maxEntries - maximum combined directory and file entries.
 * @returns relative members and whether every directory was readable within the limit.
 */
export async function directoryTree(
  root: string,
  maxEntries: number,
): Promise<{ entries: SkillFileEntry[]; complete: boolean }> {
  const entries: SkillFileEntry[] = []
  let complete = true
  const pending = ['']
  while (pending.length > 0) {
    const prefix = pending.pop()
    if (prefix === undefined) break
    let children
    try {
      children = await readdir(join(root, prefix), { withFileTypes: true })
    } catch (_unreadableDirectory) {
      complete = false
      continue
    }
    children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const child of children) {
      if (entries.length >= maxEntries) return { entries, complete: false }
      const path = prefix ? `${prefix}/${child.name}` : child.name
      const kind = child.isSymbolicLink() ? 'link' : child.isDirectory() ? 'directory' : 'file'
      entries.push({ path, kind })
      if (kind === 'directory') pending.push(path)
    }
  }
  return { entries, complete }
}
/** Compute a deterministic per-file revision index.
 *
 * @param files - relative bundle members.
 *
 * @returns sorted member digests.

 */
export function fileIndex(files: Record<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([path, bytes]) => [path, digest(bytes)]),
  )
}
/** Management-owned JSON state; invalid stored data stops dependent operations. */
export class SkillFiles {
  /** Last committed profile policy and retained backup index. */
  state: ManagerState = {
    version: 1,
    disabled: [],
    roots: [],
    categories: [],
    arrangement: {},
    installations: {},
    backups: [],
    repositories: [],
  }
  /** Resolves after durable state validation; failures block every management operation. */
  readonly ready: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * @param root - private profile data directory.
   * @param maxBytes - bundle bytes.
   * @param maxFiles - bundle file count.
   */
  constructor(
    readonly root: string,
    readonly maxBytes: number,
    readonly maxFiles: number,
  ) {
    this.ready = this.load()
  }
  private async load(): Promise<void> {
    const path = join(this.root, 'state.json')
    if ((await statOptional(path)) === undefined) return
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (_invalidState) {
      throw new ManagementError('storage')
    }
  }
  /** Serialize mutations and atomically commit state; callers publish only after this resolves.
   *
 * @param action - operation whose saved state shares this commit.
   *
 * @returns operation result.

 */
  mutate<T>(action: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ready
      const previous = structuredClone(this.state)
      try {
        const result = await action()
        await assertUnlinked(this.root)
        await mkdir(this.root, { recursive: true })
        const stage = containedPath(this.root, `${randomUUID()}.json`)
        await writeFile(stage, `${JSON.stringify(this.state)}\n`, { encoding: 'utf8', flag: 'wx' })
        await rename(stage, join(this.root, 'state.json'))
        return result
      } catch (error) {
        this.state = previous
        throw error
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }
  /** Inspect every direct file and directory skill, retaining invalid documents for diagnosis.
   *
 * @param directory - authoritative local source.
   *
 * @returns parsed and diagnostic rows.

 */
  async scan(directory: ManagedDirectory): Promise<ManagedSkill[]> {
    const info = await statOptional(directory.path)
    if (info === undefined) return []
    const rows: ManagedSkill[] = []
    for (const entry of await readdir(directory.path, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path =
        entry.isDirectory() || entry.isSymbolicLink()
          ? join(directory.path, entry.name, 'SKILL.md')
          : entry.name.endsWith('.md')
            ? join(directory.path, entry.name)
            : undefined
      if (path === undefined || (await statOptional(path)) === undefined) continue
      let document: string
      if ((await lstat(path)).size > this.maxBytes) {
        document = ''
      } else document = await readFile(path, 'utf8')
      const canonicalPath = await realpath(path)
      const id = skillId(canonicalPath)
      const row: ManagedSkill = {
        id,
        directoryId: directory.id,
        name: entry.name.replace(/\.md$/u, ''),
        description: '',
        path: canonicalPath,
        revision: digest(document),
        enabled: directory.enabled && !this.state.disabled.includes(id),
        modelInvocable: false,
        userInvocable: false,
        writable: directory.writable && !entry.isSymbolicLink() && !(await lstat(path)).isSymbolicLink(),
        valid: false,
        diagnostics: [],
        effective: false,
        category: this.state.arrangement[id]?.category ?? '',
        order: this.state.arrangement[id]?.order ?? 0,
        ...(this.state.installations[id] === undefined
          ? {}
          : { repository: this.state.installations[id].repository, commit: this.state.installations[id].commit }),
      }
      try {
        const parsed = parseSkillDocument(document)
        Object.assign(row, {
          name: parsed.name,
          description: parsed.description,
          modelInvocable: parsed.invocation.modelInvocable,
          userInvocable: parsed.invocation.userInvocable,
          valid: true,
        })
      } catch (error) {
        row.diagnostics.push(error instanceof Error ? error.message : 'Invalid skill')
      }
      rows.push(row)
    }
    return rows
  }
  /** Replace a bundle with backup and rollback on file or state-commit failure.
   *
 * @param target - trusted, checked target directory.
   *
 * @param files - validated bundle members.
   *
 * @param overwrite - caller explicitly accepted replacement.
   *
 * @returns rollback and cleanup callbacks; caller commits state before finishing.

 */
  async replace(
    target: string,
    files: Record<string, Uint8Array>,
    overwrite: boolean,
  ): Promise<{ rollback: () => Promise<void>; finish: () => Promise<void> }> {
    await assertUnlinked(target)
    const exists = await statOptional(target)
    if (exists !== undefined && !overwrite) throw new ManagementError('conflict')
    await mkdir(dirname(target), { recursive: true })
    const stage = containedPath(dirname(target), `.skill-stage-${randomUUID()}`)
    const previous = containedPath(dirname(target), `.skill-previous-${randomUUID()}`)
    await mkdir(stage)
    let moved = false
    try {
      for (const [name, bytes] of Object.entries(files)) {
        const path = containedPath(stage, name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, bytes, { flag: 'wx' })
      }
      if (exists !== undefined) {
        await rename(target, previous)
        moved = true
      }
      await rename(stage, target)
    } catch (error) {
      if (moved) await rename(previous, target)
      await rm(stage, { recursive: true, force: true })
      throw error
    }
    return {
      rollback: async () => {
        await rm(target, { recursive: true, force: true })
        if (moved) await rename(previous, target)
      },
      finish: async () => {
        if (moved) await rm(previous, { recursive: true, force: true })
      },
    }
  }
  /** Retain a skill before deletion or update.
   *
 * @param row - exact current copy.
 * @param kind - deletion or update history.
   *
 * @returns backup metadata and private content path.

 */
  async backup(row: ManagedSkill, kind: SkillBackup['kind']): Promise<{ record: SkillBackup; path: string }> {
    await assertUnlinked(row.path)
    const id = brandString<SkillBackup['id']>(randomUUID())
    const path = containedPath(this.root, `backups/${id}`)
    const flat = basename(row.path) !== 'SKILL.md'
    const target = flat ? row.path : dirname(row.path)
    const files = flat
      ? { [basename(row.path)]: await readFile(row.path) }
      : await readTree(target, this.maxBytes, this.maxFiles)
    await mkdir(path, { recursive: true })
    for (const [name, bytes] of Object.entries(files)) {
      const file = containedPath(path, name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes, { flag: 'wx' })
    }
    const record = { id, name: row.name, target, time: new Date().toISOString(), kind }
    this.state.backups.push({ ...record, directoryId: row.directoryId, installation: this.state.installations[row.id] })
    return { record, path }
  }
}
