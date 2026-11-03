/** Version-bound, plain-text release notes from the official desktop update feed. */

/** Display order shared by the dialog and release publisher. */
export const DESKTOP_RELEASE_NOTE_CATEGORIES = ['features', 'improvements', 'fixes', 'other'] as const

/** One reviewed user-visible change, with stable identity for consolidation. */
export interface DesktopReleaseNote {
  readonly id: string
  readonly category: typeof DESKTOP_RELEASE_NOTE_CATEGORIES[number]
  readonly text: { readonly en: string; readonly 'zh-CN': string }
}

/** The official feed and GitHub Release carry the same reviewed items. */
export interface DesktopReleaseNotes {
  readonly schemaVersion: 1
  readonly version: string
  readonly items: readonly DesktopReleaseNote[]
}

/**
 * Validate external feed or repository JSON without interpreting HTML or Markdown.
 * @param value - Untrusted structured notes.
 * @param version - Exact checked feed or build version.
 * @returns Bounded bilingual notes; missing, duplicate, placeholder and mismatched data rejects.
 */
export function parseDesktopReleaseNotes(value: unknown, version: string): DesktopReleaseNotes {
  const invalid = (): never => { throw new Error('desktop release notes: expected reviewed bilingual notes for the exact build version') }
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('version' in value) || value.version !== version || !('items' in value) || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > 80) return invalid()
  const ids = new Set<string>()
  const items: DesktopReleaseNote[] = value.items.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('id' in item) || typeof item.id !== 'string'
      || !/^[a-z][a-z0-9-]{2,79}$/u.test(item.id) || ids.has(item.id) || !('category' in item)
      || !DESKTOP_RELEASE_NOTE_CATEGORIES.some(category => category === item.category) || !('text' in item)
      || typeof item.text !== 'object' || item.text === null || !('en' in item.text) || !('zh-CN' in item.text)) return invalid()
    const text = (value: unknown): string => {
      if (typeof value !== 'string' || value.trim() !== value || value.length < 3 || value.length > 600
        || /[\x00-\x1f\x7f]|\b(?:TODO|TBD|FIXME)\b|待补充|待整理/iu.test(value)) return invalid()
      return value
    }
    const category = DESKTOP_RELEASE_NOTE_CATEGORIES.find(category => category === item.category)
    if (category === undefined) return invalid()
    ids.add(item.id)
    return { id: item.id, category, text: { en: text(item.text.en), 'zh-CN': text(item.text['zh-CN']) } }
  })
  return { schemaVersion: 1, version, items }
}
