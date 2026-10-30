/** Probe the link type a filesystem case needs, without changing Host privileges. */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from './temp-tree.ts'

/**
 * Check whether this process can create a real symbolic link.
 * @param kind - file or directory link used by the owning case.
 * @returns false only when Windows denies the required privilege.
 */
export function canCreateSymbolicLink(kind: 'file' | 'dir'): boolean {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-symlink-probe-'))
  try {
    const target = join(root, 'target')
    if (kind === 'dir') mkdirSync(target)
    else writeFileSync(target, 'probe\n')
    // Windows 目录联接不代表进程拥有创建文件或目录符号链接的权限。
    symlinkSync(target, join(root, 'link'), kind)
    return true
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') return false
    throw error
  } finally {
    removeTree(root)
  }
}
