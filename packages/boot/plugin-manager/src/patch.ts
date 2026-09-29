/** Comment-preserving profile plugin enablement edits. */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isMap, isSeq, parseDocument } from 'yaml'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Replace the last matching override or append one after existing insertions.
 * @param filename Current profile patch file.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param enabled Desired entry enablement.
 * @returns Whether the file changed.
 */
export async function writePluginEnabled(filename: string, id: string, name: string, enabled: boolean): Promise<boolean> {
  return writePluginEnabledBatch(filename, [{ id, name, enabled }])
}

/** Read the last profile override for a bundle row, or its declared default.
 * @param filename Current profile patch file.
 * @param id Bundle row ID.
 * @param defaultEnabled State declared by the bundle.
 * @returns Effective saved selection.
 */
export function readPluginFeatureEnabled(filename: string, id: string, defaultEnabled: boolean): boolean {
  let text: string
  try { text = readFileSync(filename, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultEnabled
    throw error
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  for (let index = document.contents.items.length - 1; index >= 0; index--) {
    const item = document.contents.items[index]
    if (!isMap(item) || item.has('insert') || document.getIn([index, 'id']) !== id) continue
    const disabled = document.getIn([index, 'disabled'])
    if (typeof disabled === 'boolean') return !disabled
  }
  return defaultEnabled
}

/** Write several row choices in one profile patch transaction.
 * @param filename Current profile patch file.
 * @param changes Complete row choices to persist together.
 * @returns Whether the file changed.
 */
export async function writePluginEnabledBatch(
  filename: string,
  changes: readonly { id: string; name: string; enabled: boolean }[],
): Promise<boolean> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  loadOptionalPatches('dsh', filename)
  const items = document.contents.items
  let changed = false
  for (const { id, name, enabled } of changes) {
    const target = items.findLast((item, index) => {
      if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
      const expectedName = document.getIn([index, 'name'])
      return !expectedName || expectedName === name
    })
    if (isMap(target)) {
      if (document.getIn([items.indexOf(target), 'disabled']) === !enabled) continue
      document.setIn([items.indexOf(target), 'disabled'], !enabled)
    } else {
      document.add({ id, disabled: !enabled })
    }
    changed = true
  }
  if (!changed) return false
  await writeFileAtomic(filename, String(document), { mode: 0o600 })
  return true
}
