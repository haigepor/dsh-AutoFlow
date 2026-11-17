/** Private image-directory ownership and verified filesystem transfers; no task metadata is rewritten. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, statfs, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { checkCancelled, MediaError } from './errors.ts'

/** A durable migration references digest names rather than creating new business image references. */
export const storageMigrationFileSchema = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() })
export type StorageMigrationFile = z.infer<typeof storageMigrationFileSchema>
const ownerName = '.visual-curator-storage.json'
const ownerSchema = z.strictObject({ version: z.literal(1), profileId: z.string() })

/** @param directory Private media root. @returns Canonical directory; directory links are rejected. */
export async function checkedStorageDirectory(directory: string): Promise<string> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaError('reference-unavailable', 'storage-migration', false, 'The image directory is unavailable or linked.', 'Choose a writable local directory.')
  return await realpath(directory)
}

/** @param root Private media root. @returns Regular files with stable relative names; links cannot enter maintenance inventories. */
export async function imageStorageInventory(root: string) {
  const files: { ref: string; bytes: number; mtime: number; inode: number; device: number }[] = []
  const walk = async (directory: string): Promise<void> => {
    await checkedStorageDirectory(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new MediaError('reference-unavailable', 'storage-migration', false, 'A private storage entry is linked.', 'Remove the directory link before managing storage.')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new MediaError('reference-unavailable', 'storage-migration', false, 'A private storage file changed.', 'Refresh storage and retry.')
        files.push({ ref: relative(root, path).split(sep).join('/'), bytes: stat.size, mtime: stat.mtimeMs, inode: stat.ino, device: stat.dev })
      }
    }
  }
  await walk(root)
  return files.sort((left, right) => left.ref.localeCompare(right.ref))
}

/** @param ref Relative file name. @returns Whether it names a canonical image blob. */
export function isImageStorageBlob(ref: string): boolean { return /^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(ref) && ref.slice(6, 8) === ref.slice(9, 11) }

/** @param directory Candidate root. @param profileId Owning profile. @param defaultDirectory Original profile-private root. @returns Owned canonical directory. */
export async function ownedStorageDirectory(directory: string, profileId: string, defaultDirectory: string): Promise<string> {
  const canonical = await checkedStorageDirectory(directory)
  if (relative(defaultDirectory, canonical) === '') return canonical
  const ownerStat = await lstat(join(canonical, ownerName))
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw new MediaError('owner-denied', 'storage-migration', false, 'The storage owner record is linked or invalid.', 'Choose an empty directory.')
  const file = await open(join(canonical, ownerName), 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4096) throw new MediaError('owner-denied', 'storage-migration', false, 'The storage owner record is invalid.', 'Choose an empty directory or this profile’s image directory.')
    const owner = ownerSchema.parse(JSON.parse(await file.readFile('utf8')))
    if (owner.profileId !== profileId) throw new MediaError('owner-denied', 'storage-migration', false, 'This image directory belongs to another profile.', 'Choose a separate image directory.')
    return canonical
  } finally { await file.close() }
}

/** @param directory Explicit folder-picker result. @param source Current canonical root. @param profileId Owning profile. @param defaultDirectory Original root, whose writer lock stays in place. @returns Writable, owned target without overwriting existing files. */
export async function prepareStorageDirectory(directory: string, source: string, profileId: string, defaultDirectory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new MediaError('invalid-input', 'storage-migration', false, 'Choose an absolute image directory.', 'Select a directory with the folder picker.')
  const target = await checkedStorageDirectory(resolve(directory))
  const contains = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
  if (contains(source, target) || contains(target, source)) throw new MediaError('storage-directory-overlap', 'storage-migration', false, 'The source and target directories overlap.', 'Choose a separate directory.')
  const entries = await readdir(target)
  if (entries.includes(ownerName)) await ownedStorageDirectory(target, profileId, defaultDirectory)
  else {
    if (entries.length && relative(defaultDirectory, target) !== '') throw new MediaError('storage-directory-not-empty', 'storage-migration', false, 'The selected directory contains unrelated files.', 'Choose an empty directory.')
    const owner = await open(join(target, ownerName), 'wx', 0o600)
    try { await owner.writeFile(JSON.stringify({ version: 1, profileId }) + '\n', 'utf8'); await owner.sync() } finally { await owner.close() }
  }
  // New image writes publish digest files with exclusive hard links on the selected filesystem.
  const probe = join(target, `.migration-probe-${randomUUID()}`), linked = `${probe}.link`
  const file = await open(probe, 'wx', 0o600)
  await file.close()
  try { await link(probe, linked); await unlink(linked) }
  finally { await unlink(probe) }
  return target
}

/** @param directory Owned directory. @param file Validated digest entry. @returns Contained regular file path, or absence for an unpublished destination. */
async function blobPath(directory: string, file: StorageMigrationFile): Promise<string | undefined> {
  await checkedStorageDirectory(directory)
  const shard = join(directory, 'blobs', file.digest.slice(0, 2))
  try {
    await checkedStorageDirectory(join(directory, 'blobs')); await checkedStorageDirectory(shard)
    const path = join(shard, file.digest), stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MediaError('reference-unavailable', 'storage-migration', false, 'A storage file is unavailable or linked.', 'Check the image directories before retrying.')
    return path
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** @param directory Owned directory. @param file Expected immutable image. @param signal Migration lifetime. @returns Whether the expected file exists; changed bytes always reject. */
export async function verifyStorageFile(directory: string, file: StorageMigrationFile, signal: AbortSignal): Promise<boolean> {
  const path = await blobPath(directory, file)
  if (path === undefined) return false
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) { checkCancelled(signal); hash.update(chunk); bytes += chunk.length }
  if (bytes !== file.bytes || hash.digest('hex') !== file.digest) throw new MediaError('storage-checksum-mismatch', 'storage-migration', false, 'Image bytes do not match their saved digest.', 'Restore the matching image before retrying migration.')
  return true
}

/** @param target Owned target. @param files Frozen source inventory. @returns After checking space for missing files; existing payloads are verified separately. */
export async function checkMigrationSpace(target: string, files: readonly StorageMigrationFile[]): Promise<void> {
  let required = 0
  for (const file of files) if (await blobPath(target, file) === undefined) required += file.bytes
  const space = await statfs(target)
  if (space.bavail * space.bsize < required) throw new MediaError('storage-space-insufficient', 'storage-migration', false, 'The selected drive has insufficient free space.', 'Choose a directory on a drive with sufficient free space.')
}

/** @param source Owned source. @param target Owned target. @param file Frozen immutable entry. @param migrationId Owning durable operation. @param signal Host-owned lifetime. @param progress Bytes copied within this file. @returns After exclusive publication; existing different bytes are never overwritten. */
export async function copyStorageFile(source: string, target: string, file: StorageMigrationFile, migrationId: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  if (await verifyStorageFile(target, file, signal)) { progress(file.bytes); return }
  const sourcePath = await blobPath(source, file)
  if (sourcePath === undefined) throw new MediaError('reference-unavailable', 'storage-migration', false, 'A source image is missing.', 'Restore the source image before migrating.')
  const shard = join(target, 'blobs', file.digest.slice(0, 2))
  for (const directory of [join(target, 'blobs'), shard]) {
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    await checkedStorageDirectory(directory)
  }
  const temporary = join(target, `.migration-${migrationId}-${file.digest}.tmp`)
  try { await unlink(temporary) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const hash = createHash('sha256'); let copied = 0
  try {
    await pipeline(createReadStream(sourcePath), new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); copied += chunk.length; progress(copied); done(null, chunk) } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
    if (copied !== file.bytes || hash.digest('hex') !== file.digest) throw new MediaError('storage-checksum-mismatch', 'storage-migration', false, 'The source image changed during copying.', 'Restore the matching source image and retry.')
    const handle = await open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    checkCancelled(signal)
    await link(temporary, join(shard, file.digest))
  } finally {
    try { await unlink(temporary) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  }
}

/** @param source Owned inactive source. @param target Active verified target. @param file Confirmed transferred image. @param signal Host-owned lifetime. @returns After removing only the matching old digest file; absence supports interrupted cleanup. */
export async function removeTransferredFile(source: string, target: string, file: StorageMigrationFile, signal: AbortSignal): Promise<void> {
  if (!await verifyStorageFile(target, file, signal)) throw new MediaError('reference-unavailable', 'storage-migration', false, 'A migrated image is missing.', 'Reconnect or restore the target directory before removing old files.')
  if (!await verifyStorageFile(source, file, signal)) return
  checkCancelled(signal)
  const path = await blobPath(source, file)
  if (path !== undefined) await unlink(path)
}
