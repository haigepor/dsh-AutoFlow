/** Cordis Loader configuration file discovery. */

import { execFileSync } from 'node:child_process'
import { globSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * Return repository-relative Cordis Loader YAML paths under `root`.
 *
 * Translation consistency records are YAML sidecars, never Loader inputs.
 *
 * @param root Repository root to scan.
 * @returns Sorted repository-relative Loader configuration paths.
 */
export function cordisConfigFiles(root: string): string[] {
  return globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
    cwd: root,
    exclude: ['.claude/**', 'node_modules/**', 'vendor/**', '**/*.i18n.yaml'],
  }).sort()
}

/** Read a Loader config, including Git symlinks checked out as text on Windows.
 * Only index-declared links are followed; all targets must remain inside the repository.
 * @param root Repository root.
 * @param file Repository-relative config path.
 * @returns Config source text, with declared link stubs resolved.
 */
export function readCordisConfig(root: string, file: string): string {
  const repository = realpathSync(root)
  const visited = new Set<string>()
  let path = resolve(repository, file)
  for (;;) {
    const local = relative(repository, path)
    if (local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local)) {
      throw new Error(`Cordis config link leaves repository: ${file}`)
    }
    if (visited.has(path)) throw new Error(`Cyclic Cordis config link: ${file}`)
    visited.add(path)
    const physical = realpathSync(path)
    if (physical !== path) {
      path = physical
      continue
    }
    const text = readFileSync(path, 'utf8')
    // A regular YAML scalar is never interpreted as a link without Git's mode.
    if (!/^[^\r\n]+\.(?:yml|yaml)\s*$/.test(text)) return text
    const entry = execFileSync('git', ['--literal-pathspecs', 'ls-files', '--stage', '--', local.replaceAll('\\', '/')], { cwd: repository, encoding: 'utf8' })
    if (!entry.startsWith('120000 ')) return text
    path = resolve(dirname(path), text.trim())
  }
}
