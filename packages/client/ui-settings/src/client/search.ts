/** Feature-owned settings search entries; indexing never mounts a form. */
import { Service, type Context } from '@deepseek-ai/cordis'

/** A localized setting and its optional DOM anchor on the owning page. */
export interface SettingsSearchEntry {
  /** Unique feature-qualified id within the client registry. */
  id: string
  /** Existing settings.section registration id. */
  sectionId: string
  /** Resolve the setting's label in the current locale. */
  label: () => string
  /** Stable heading/control selector; absent entries locate their exact label. */
  target?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsSearch: SettingsSearch
  }
}

/** Client registry shared by settings contributors and the settings shell. */
export class SettingsSearch extends Service {
  private entries: readonly SettingsSearchEntry[] = []
  private listeners = new Set<() => void>()

  /** @param ctx - settings provider context. */
  constructor(ctx: Context) { super(ctx, 'settingsSearch') }

  /** Read the current search contributions.
   * @returns Stable entries until registration or disposal changes the index.
   */
  getSnapshot(): readonly SettingsSearchEntry[] { return this.entries }

  /** Observe registration and disposal changes.
   * @param listener - index observer.
   * @returns Observer disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Register one feature-owned entry inside a contributor's ctx.effect.
   * @param entry - localized label and owning section.
   * @returns Idempotent registration disposer.
   */
  register(entry: SettingsSearchEntry): () => void {
    if (this.entries.some(item => item.id === entry.id)) throw new Error(`Duplicate settings search id: ${entry.id}`)
    this.entries = [...this.entries, entry]
    this.publish()
    return () => {
      if (!this.entries.includes(entry)) return
      this.entries = this.entries.filter(item => item !== entry)
      this.publish()
    }
  }

  private publish(): void { for (const listener of this.listeners) listener() }
}
