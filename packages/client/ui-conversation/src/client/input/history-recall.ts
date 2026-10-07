/**
 * Arrow-key recall over the input-history bucket: ↑ walks backward through
 * the entries, ↓ forward, and past the newest restores the draft the user
 * was composing when recall began. Wired behind the composer keymap's menu
 * arbitration — a recall is consulted only when no trigger menu consumes the
 * arrow. Browsing ends the moment the draft diverges from what recall last
 * wrote (the user took over), protecting their new draft as the baseline.
 */
import { $getRoot } from 'lexical'
import type { LexicalEditor } from 'lexical'
import { list } from './history.ts'

/** Live environment the controller reads at event time; reassigned per render. */
export interface HistoryRecallEnv {
  /** Whether a recall write is accepted right now (live phase, locks, attachments). */
  available(): boolean
  /** The current draft text. */
  draft(): string
  /** The sanctioned draft write path (InputActions.setDraft). */
  setDraft(text: string): void
  /** The editor whose root hosts the caret. */
  editor(): LexicalEditor | null
  /** The bucket scope ({@link historyScopeOf}). */
  scope(): string
}

/** The collapsed caret range, or null when the selection is absent or spans text. */
function collapsedCaret(): Range | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return null
  return selection.getRangeAt(0)
}

/**
 * Whether the caret sits at the start of the root's content.
 * @param root - the composer contenteditable root.
 * @returns true when no content precedes the caret.
 */
export function caretAtStart(root: HTMLElement | null): boolean {
  const caret = collapsedCaret()
  if (root === null || caret === null) return false
  const probe = document.createRange()
  probe.selectNodeContents(root)
  probe.setEnd(caret.startContainer, caret.startOffset)
  return probe.toString() === ''
}

/**
 * Whether the caret sits at the end of the root's content.
 * @param root - the composer contenteditable root.
 * @returns true when no content follows the caret.
 */
export function caretAtEnd(root: HTMLElement | null): boolean {
  const caret = collapsedCaret()
  if (root === null || caret === null) return false
  const probe = document.createRange()
  // selectNodeContents resets both endpoints, so it precedes the caret start.
  probe.selectNodeContents(root)
  probe.setStart(caret.startContainer, caret.startOffset)
  return probe.toString() === ''
}

/**
 * The recall cursor state machine. One instance rides the resident composer;
 * {@link HistoryRecallEnv} is reassigned every render so handlers read live
 * values without re-arming the keymap.
 */
export class HistoryRecall {
  private env: HistoryRecallEnv
  /** Position in the bucket while browsing; null when not browsing. */
  private cursor: number | null = null
  /** The draft to restore when ↓ walks past the newest entry. */
  private baseline = ''
  /** The last text this controller wrote; divergence means the user took over. */
  private lastWritten: string | null = null
  private scope: string

  constructor(env: HistoryRecallEnv) {
    this.env = env
    this.scope = env.scope()
  }

  /**
   * Replace the event-time environment.
   * @param env - current input and editor accessors.
   */
  rebind(env: HistoryRecallEnv): void {
    this.env = env
  }

  /**
   * Handle one plain arrow gesture.
   * @param key - the arrow direction.
   * @param composing - whether an IME composition is active (IME owns arrows).
   * @returns true = the gesture was consumed (the keymap preventDefaults it).
   */
  onArrow(key: 'up' | 'down', composing: boolean): boolean {
    if (composing || !this.env.available()) return false
    const scope = this.env.scope()
    if (scope !== this.scope) {
      this.stopBrowsing()
      this.scope = scope
    }
    if (this.cursor !== null && this.env.draft() !== this.lastWritten) {
      this.stopBrowsing()
      return false
    }
    const entries = list(scope)
    const newest = entries[0]
    if (newest === undefined) return false
    if (key === 'up') {
      if (this.cursor === null) {
        // Entering recall from a non-empty draft requires the caret at the
        // start boundary; an empty draft is trivially at every boundary.
        if (this.env.draft() !== '' && !caretAtStart(this.env.editor()?.getRootElement() ?? null)) return false
        this.baseline = this.env.draft()
        this.cursor = 0
        this.write(newest)
        return true
      }
      const older = this.cursor + 1
      const entry = entries[older]
      if (entry !== undefined) {
        this.cursor = older
        this.write(entry)
      }
      return true
    }
    if (this.cursor === null) {
      // A non-empty draft also enters from its end boundary with ↓ (the
      // newest entry first); an empty draft has nothing to walk forward to.
      if (this.env.draft() === '' || !caretAtEnd(this.env.editor()?.getRootElement() ?? null)) return false
      this.baseline = this.env.draft()
      this.cursor = 0
      this.write(newest)
      return true
    }
    if (this.cursor > 0) {
      const newer = this.cursor - 1
      const entry = entries[newer]
      if (entry === undefined) return true
      this.cursor = newer
      this.write(entry)
      return true
    }
    // ↓ past the newest entry restores the pre-recall draft.
    const baseline = this.baseline
    this.stopBrowsing()
    this.write(baseline)
    return true
  }

  private stopBrowsing(): void {
    this.cursor = null
    this.baseline = ''
  }

  private write(text: string): void {
    this.lastWritten = text
    this.env.setDraft(text)
    // Recall lands the caret at the draft's end, the ordinary position after
    // filling the box — and keeps ↓ caret-at-end probes meaningful.
    this.env.editor()?.update(() => { $getRoot().selectEnd() })
  }
}
