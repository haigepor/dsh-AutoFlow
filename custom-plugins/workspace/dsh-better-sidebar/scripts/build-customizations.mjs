/** Generate the local bundle's default customCss without modifying upstream UI source. */
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const css = await readFile(new URL('customizations/file-changes.css', root), 'utf8')
const patch = '- insert:\n    - id: better-sidebar\n      name: dsh-better-sidebar\n      config:\n        customCss: |\n'
  + css.trimEnd().split('\n').map(line => line.trim() === '' ? '' : '          ' + line).join('\n') + '\n'
const file = new URL('cordis.patch.yml', root)
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== patch) throw new Error('Run build-customizations.mjs to refresh the bundle patch')
} else await writeFile(file, patch, 'utf8')
