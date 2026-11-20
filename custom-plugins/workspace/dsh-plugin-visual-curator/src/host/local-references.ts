/** Enumerate explicit human-selected local paths without uploading or copying file contents. */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, basename } from 'node:path'
import { CuratorError } from '../shared/errors.ts'
import type { LocalPathFile } from '../client/contract.ts'

/** Read metadata beneath selected paths. Folder imports list each supported image once and skip links.
 * @param paths Absolute paths selected by the human. @param kind Expected selection type.
 * @param maxFiles Reference enumeration limit, absent when staging direct originals. @param signal Read lifetime.
 * @returns Relative labels and original absolute paths, without image bytes.
 */
export async function listLocalReferences(paths: readonly string[], kind: 'file' | 'folder' | 'folders' | 'references', maxFiles: number | undefined, signal: AbortSignal): Promise<LocalPathFile[]> {
  const imagesOnly = kind === 'folders'
  const visited = new Set<string>()
  const files: LocalPathFile[] = []
  try {
    for (const path of new Set(paths)) {
      signal.throwIfAborted()
      if (!isAbsolute(path)) throw new CuratorError('invalid-input', 'local-reference', 'An absolute local path is required.')
      const root = await realpath(path), stat = await lstat(path)
      const directory = stat.isDirectory()
      if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : kind === 'references' ? !stat.isFile() && !directory : !directory)) throw new CuratorError('invalid-input', 'local-reference', 'Select an ordinary local image file or folder.')
      async function visit(filePath: string): Promise<void> {
        signal.throwIfAborted()
        const entry = await lstat(filePath)
        if (entry.isDirectory()) {
          if (imagesOnly && visited.has(filePath)) return
          if (imagesOnly) visited.add(filePath)
          const entries = await readdir(filePath)
          for (const name of entries.sort()) await visit(join(filePath, name))
          return
        }
        if (imagesOnly && (!entry.isFile() || !/\.(?:jpe?g|png|webp)$/i.test(filePath))) return
        if (maxFiles !== undefined && files.length >= maxFiles) throw new CuratorError('invalid-input', 'local-reference', 'The selection exceeds the configured file count.')
        const name = directory && !imagesOnly ? relative(root, filePath).replaceAll('\\', '/') : basename(filePath)
        files.push({ path: filePath, name, size: entry.size, readable: entry.isFile() })
      }
      await visit(root)
    }
    signal.throwIfAborted()
    return files
  } catch (error) { signal.throwIfAborted(); if (error instanceof CuratorError) throw error; throw new CuratorError('reference-unavailable', 'local-reference', 'The selected local path cannot be read.', { cause: error }) }
}
