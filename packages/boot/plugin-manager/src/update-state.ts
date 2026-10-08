/** Profile-owned automatic choices and target-entry restoration for updates. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readlink, rm, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from 'zod'
import { updateCacheDirectory } from './github-updates.ts'

const settingsSchema = z.object({ version: z.literal(1), automatic: z.record(z.string(), z.boolean()) }).strict()

function settingsPath(profileDir: string): string {
  return join(dirname(updateCacheDirectory(profileDir)), 'settings.json')
}

/** Read explicit automatic installation choices; missing settings means all off.
 * @param profileDir Owning profile.
 * @returns Validated choices by package name.
 */
export function readAutomaticUpdates(profileDir: string): Record<string, boolean> {
  const file = settingsPath(profileDir)
  if (!existsSync(file)) return {}
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 1024 * 1024) throw new Error('Invalid plugin update settings file')
  return settingsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).automatic
}

/** Save a choice without replacing other package choices.
 * @param profileDir Owning profile.
 * @param name Validated package name.
 * @param enabled Explicit user selection.
 */
export async function writeAutomaticUpdate(profileDir: string, name: string, enabled: boolean): Promise<void> {
  const file = settingsPath(profileDir)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await withFileLock(file, async () => {
    await writeFileAtomic(file, JSON.stringify({ version: 1, automatic: { ...readAutomaticUpdates(profileDir), [name]: enabled } }) + '\n', { mode: 0o600 })
  })
}

/** Saved package-manager entry; restore is required before a failed update releases its lock. */
export interface UpdateEntryBackup {
  restore(): Promise<void>
  discard(): Promise<void>
}

/** Snapshot a profile node_modules entry without following its links.
 * @param profileDir Profile whose pnpm transaction owns the entry.
 * @param name Canonical package name.
 * @returns Restoration and cleanup owned by the transaction.
 */
export async function backupUpdateEntry(profileDir: string, name: string): Promise<UpdateEntryBackup> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid update package name')
  const target = join(profileDir, 'node_modules', name)
  const inside = relative(join(profileDir, 'node_modules'), target)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Update target escapes profile')
  const cache = updateCacheDirectory(profileDir)
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(dirname(cache), 'rollback-'))
  const saved = join(temporary, 'entry')
  const original = await lstat(target).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  // Windows pnpm 使用目录 junction；保存链接文本，避免 cp 将其重建为需要管理员权限的 symlink。
  const link = original?.isSymbolicLink() ? await readlink(target) : undefined
  const linkType = link === undefined ? undefined
    : process.platform === 'win32' && (await stat(target)).isDirectory() ? 'junction' : 'file'
  try {
    if (original !== undefined && link === undefined) {
      await cp(target, saved, { recursive: true, dereference: false, verbatimSymlinks: true })
    }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
  return {
    async restore() {
      const current = await lstat(target).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      })
      if (current !== undefined) {
        if (current.isSymbolicLink()) await unlink(target)
        else await rm(target, { recursive: true, force: true })
      }
      if (original !== undefined) {
        await mkdir(dirname(target), { recursive: true })
        if (link !== undefined) await symlink(link, target, linkType)
        else await cp(saved, target, { recursive: true, dereference: false, verbatimSymlinks: true })
      }
    },
    async discard() { await rm(temporary, { recursive: true, force: true }) },
  }
}
