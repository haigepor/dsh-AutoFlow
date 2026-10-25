/** Enumerate explicit human-selected local paths without uploading or copying file contents. */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, basename } from 'node:path'
import { CuratorError } from '../shared/errors.ts'
import type { LocalPathFile } from '../client/contract.ts'

/** Read file metadata beneath an explicitly selected root; symbolic links are reported, never traversed.
 * @param path Absolute file or folder selected by the human. @param kind Expected selection type.
 * @param maxFiles Configured enumeration limit. @param signal Read lifetime.
 * @returns Relative labels and original absolute paths, without image bytes.
 */
export async function listLocalReferences(path: string, kind: 'file' | 'folder' | 'references', maxFiles: number, signal: AbortSignal): Promise<LocalPathFile[]> {
  if (!isAbsolute(path)) throw new CuratorError('invalid-input', 'local-reference', 'An absolute local path is required.')
  const files: LocalPathFile[] = []
  try {
    const root = await realpath(path), stat = await lstat(path)
    if (stat.isSymbolicLink() || (kind === 'folder' ? !stat.isDirectory() : kind === 'file' ? !stat.isFile() : !stat.isFile() && !stat.isDirectory())) throw new CuratorError('invalid-input', 'local-reference', 'Select an ordinary local image file or folder.')
    const directory = stat.isDirectory()
    async function visit(filePath: string): Promise<void> {
      signal.throwIfAborted()
      const entry = await lstat(filePath)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const entries = await readdir(filePath)
        for (const name of entries.sort()) await visit(join(filePath, name))
      } else {
        if (files.length >= maxFiles) throw new CuratorError('invalid-input', 'local-reference', 'The folder exceeds the configured local reference count. Select a smaller subfolder.')
        files.push({ path: filePath, name: directory ? relative(root, filePath).replaceAll('\\', '/') : basename(filePath), size: entry.size, readable: entry.isFile() && !entry.isSymbolicLink() })
      }
    }
    await visit(root)
    return files
  } catch (error) { signal.throwIfAborted(); if (error instanceof CuratorError) throw error; throw new CuratorError('reference-unavailable', 'local-reference', 'The selected local path cannot be read.', { cause: error }) }
}
