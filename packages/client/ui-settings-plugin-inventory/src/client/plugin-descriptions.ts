/** Resolve reviewed inventory descriptions without changing package metadata. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { inventoryDescriptions, presetEntryDescriptions } from './locales/plugin-descriptions.ts'

/** Resolve known inventory copy; third-party modules retain their own metadata.
 * @param moduleName Exact module specifier, including exported subpaths.
 * @param entryId Loader identity for separately configured feature rows.
 * @returns Localized description, or undefined for unreviewed modules.
 */
export function inventoryDescription(moduleName: string, entryId: string | null): LocalizedText | undefined {
  const identity = entryId?.replace(/^include:/, '')
  if (moduleName === '@deepseek-ai/dsh-agent-preset' && identity !== undefined) {
    return presetEntryDescriptions[identity] ?? inventoryDescriptions[moduleName]
  }
  return inventoryDescriptions[moduleName]
}
