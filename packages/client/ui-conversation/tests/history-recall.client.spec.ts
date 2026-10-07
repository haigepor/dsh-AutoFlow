// @vitest-environment jsdom
// The ↑↓ recall cursor over the input-history bucket: entry guards (IME,
// availability, empty bucket), the caret-boundary entry from a non-empty
// draft, walking back and forward, restoring the pre-recall baseline past
// the newest entry, and the external-write reset that protects a user's
// fresh draft. Caret probes are exercised directly on a contenteditable.

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import type { LexicalEditor } from 'lexical'
import { caretAtEnd, caretAtStart, HistoryRecall } from '../src/client/input/history-recall.ts'
import type { HistoryRecallEnv } from '../src/client/input/history-recall.ts'
import { remember, resetInputHistoryForTests } from '../src/client/input/history.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'

const SCOPE = 'C:/proj/recall'

it('recalls through the session keyboard face while respecting composer and attachment locks', () => {
  resetInputHistoryForTests()
  const shell = new SessionInputShell({
    actx: new Context(),
    historyScope: () => SCOPE,
    defaultSink: vi.fn(),
    commandAttachments: {
      serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token,
    },
  })
  onTestFinished(() => { shell.dispose(); resetInputHistoryForTests() })
  expect(shell.hasHistory()).toBe(false)
  remember('submitted task', SCOPE)
  expect(shell.hasHistory()).toBe(true)
  expect(shell.recallHistory('up', false, false)).toBe(false)
  expect(shell.recallHistory('up', true, true)).toBe(false)
  expect(shell.recallHistory('up', false, true)).toBe(true)
  expect(shell.snapshot.draft).toBe('submitted task')
  expect(shell.recallHistory('down', false, true)).toBe(true)
  expect(shell.snapshot.draft).toBe('')
  shell.addAttachments(['file-1' as DraftAttachmentId])
  expect(shell.recallHistory('up', false, true)).toBe(false)
  shell.dispose()
  expect(shell.recallHistory('up', false, true)).toBe(false)
})

function seed(): void {
  resetInputHistoryForTests()
  remember('oldest', SCOPE)
  remember('middle', SCOPE)
  remember('newest', SCOPE)
}

/** A real headless editor so the recall write's `selectEnd` update runs. */
function headlessEditor(): LexicalEditor {
  return createHeadlessEditor({ namespace: 'recall', onError: (error) => { throw error } })
}

function env(over: Partial<HistoryRecallEnv> & { editor?: () => LexicalEditor | null } = {}): {
  env: HistoryRecallEnv
  setDraft: ReturnType<typeof vi.fn<(text: string) => void>>
  draft: { current: string }
  available: { current: boolean }
} {
  const draft = { current: '' }
  const available = { current: true }
  const setDraft = vi.fn<(text: string) => void>((text) => { draft.current = text })
  const editor = over.editor ?? headlessEditor
  return {
    env: {
      available: () => available.current,
      draft: () => draft.current,
      setDraft,
      editor,
      scope: () => SCOPE,
      ...over,
    },
    setDraft,
    draft,
    available,
  }
}

/** A contenteditable with a collapsed caret at `offset` of its single text node. */
function editableWithCaret(text: string, offset: number): HTMLElement {
  const root = document.createElement('div')
  root.contentEditable = 'true'
  root.textContent = text
  document.body.appendChild(root)
  const selection = window.getSelection()
  const range = document.createRange()
  range.setStart(root.firstChild!, offset)
  range.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(range)
  return root
}

function domEditor(root: HTMLElement): LexicalEditor {
  const text = root.textContent ?? ''
  const offset = window.getSelection()?.getRangeAt(0).startOffset ?? 0
  const editor = createEditor({ namespace: 'recall-dom', onError: (error) => { throw error } })
  editor.setRootElement(root)
  editor.update(() => {
    $getRoot().clear().append($createParagraphNode().append($createTextNode(text)))
  }, { discrete: true })
  const range = document.createRange()
  range.setStart(document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode()!, offset)
  range.collapse(true)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  return editor
}

describe('caret boundary probes', () => {
  it('answers true only for a collapsed caret at the content start', () => {
    const root = editableWithCaret('hello', 0)
    try {
      expect(caretAtStart(root)).toBe(true)
      expect(caretAtEnd(root)).toBe(false)
    } finally { root.remove() }
  })

  it('answers true only for a collapsed caret at the content end', () => {
    const root = editableWithCaret('hello', 5)
    try {
      expect(caretAtEnd(root)).toBe(true)
      expect(caretAtStart(root)).toBe(false)
    } finally { root.remove() }
  })

  it('refuses a spanning selection, an absent selection, and an absent root', () => {
    const root = editableWithCaret('hello', 1)
    try {
      const selection = window.getSelection()!
      const range = document.createRange()
      range.setStart(root.firstChild!, 1)
      range.setEnd(root.firstChild!, 4)
      selection.removeAllRanges()
      selection.addRange(range)
      expect(caretAtStart(root)).toBe(false)
      expect(caretAtEnd(root)).toBe(false)
      selection.removeAllRanges()
      expect(caretAtStart(root)).toBe(false)
      expect(caretAtEnd(root)).toBe(false)
      expect(caretAtStart(null)).toBe(false)
      expect(caretAtEnd(null)).toBe(false)
    } finally { root.remove() }
  })
})

describe('history recall cursor', () => {
  it('passes the gesture through when composing, unavailable, or the bucket is empty', () => {
    seed()
    const withEnv = env({ available: () => false })
    const recall = new HistoryRecall(withEnv.env)
    expect(recall.onArrow('up', false)).toBe(false)

    const composing = env()
    expect(new HistoryRecall(composing.env).onArrow('up', true)).toBe(false)
    expect(composing.setDraft).not.toHaveBeenCalled()

    resetInputHistoryForTests()
    const empty = env()
    expect(new HistoryRecall(empty.env).onArrow('down', false)).toBe(false)
  })

  it('walks from the newest entry backward and stays at the oldest', () => {
    seed()
    const withEnv = env()
    const recall = new HistoryRecall(withEnv.env)
    expect(recall.onArrow('up', false)).toBe(true)
    expect(withEnv.draft.current).toBe('newest')
    expect(recall.onArrow('up', false)).toBe(true)
    expect(withEnv.draft.current).toBe('middle')
    expect(recall.onArrow('up', false)).toBe(true)
    expect(withEnv.draft.current).toBe('oldest')
    expect(recall.onArrow('up', false)).toBe(true)
    expect(withEnv.draft.current).toBe('oldest')
  })

  it('walks forward and restores the pre-recall baseline past the newest entry', () => {
    seed()
    const withEnv = env()
    const recall = new HistoryRecall(withEnv.env)
    recall.onArrow('up', false)
    recall.onArrow('up', false) // middle
    recall.onArrow('down', false)
    expect(withEnv.draft.current).toBe('newest')
    recall.onArrow('down', false)
    expect(withEnv.draft.current).toBe('')
    expect(withEnv.setDraft).toHaveBeenLastCalledWith('')
  })

  it('enters from a non-empty draft at either caret boundary (↑ start, ↓ end)', () => {
    seed()
    const atStartRoot = editableWithCaret('draft text', 0)
    try {
      const editor = domEditor(atStartRoot)
      const atStart = env({ editor: () => editor })
      atStart.draft.current = 'draft text'
      const recall = new HistoryRecall(atStart.env)
      expect(recall.onArrow('up', false)).toBe(true)
      expect(atStart.draft.current).toBe('newest')
      recall.onArrow('down', false)
      expect(atStart.draft.current).toBe('draft text')
    } finally { atStartRoot.remove() }

    seed()
    const atEndRoot = editableWithCaret('draft text', 10)
    try {
      const editor = domEditor(atEndRoot)
      const atEnd = env({ editor: () => editor })
      atEnd.draft.current = 'draft text'
      const recall = new HistoryRecall(atEnd.env)
      expect(recall.onArrow('down', false)).toBe(true)
      expect(atEnd.draft.current).toBe('newest')
    } finally { atEndRoot.remove() }

    seed()
    const midRoot = editableWithCaret('draft text', 3)
    try {
      const editor = domEditor(midRoot)
      const mid = env({ editor: () => editor })
      mid.draft.current = 'draft text'
      const recall = new HistoryRecall(mid.env)
      expect(recall.onArrow('up', false)).toBe(false)
      expect(recall.onArrow('down', false)).toBe(false)
      expect(mid.draft.current).toBe('draft text')
    } finally { midRoot.remove() }
  })

  it('restores the entered-from draft on the down walk even after walking to the oldest', () => {
    seed()
    const atEndRoot = editableWithCaret('my draft', 8)
    try {
      const editor = domEditor(atEndRoot)
      const withEnv = env({ editor: () => editor })
      withEnv.draft.current = 'my draft'
      const recall = new HistoryRecall(withEnv.env)
      expect(recall.onArrow('down', false)).toBe(true) // enters from the end boundary
      recall.onArrow('up', false)
      recall.onArrow('up', false) // oldest
      recall.onArrow('down', false)
      recall.onArrow('down', false)
      recall.onArrow('down', false)
      expect(withEnv.draft.current).toBe('my draft')
    } finally { atEndRoot.remove() }
  })

  it('drops the cursor when the draft diverges from the last recalled text', () => {
    seed()
    // No editor seat: boundary probes answer false, the empty-draft entries
    // never consult the caret.
    const withEnv = env({ editor: () => null })
    const recall = new HistoryRecall(withEnv.env)
    recall.onArrow('up', false) // newest, from the empty draft
    withEnv.draft.current = 'user took over'
    expect(recall.onArrow('down', false)).toBe(false) // cursor reset → not browsing
    withEnv.draft.current = ''
    expect(recall.onArrow('up', false)).toBe(true)
    expect(withEnv.setDraft).toHaveBeenLastCalledWith('newest')
  })

  it('runs the write through the editor update (caret to the draft end)', () => {
    seed()
    const editor = headlessEditor()
    const update = vi.spyOn(editor, 'update')
    const withEnv = env({ editor: () => editor })
    const recall = new HistoryRecall(withEnv.env)
    expect(recall.onArrow('up', false)).toBe(true)
    expect(withEnv.setDraft).toHaveBeenCalledWith('newest')
    expect(update).toHaveBeenCalled()
  })

  it('starts a fresh recall after switching workspace even when draft text is equal', () => {
    seed()
    remember('other oldest', 'other')
    remember('newest', 'other')
    const first = env()
    const recall = new HistoryRecall(first.env)
    recall.onArrow('up', false)
    const root = editableWithCaret('newest', 0)
    try {
      const editor = domEditor(root)
      const second = env({ scope: () => 'other', editor: () => editor })
      second.draft.current = 'newest'
      recall.rebind(second.env)
      expect(recall.onArrow('up', false)).toBe(true)
      expect(second.draft.current).toBe('newest')
    } finally { root.remove() }
  })

  it('leaves an external edit untouched on the next arrow at the caret boundary', () => {
    seed()
    const root = editableWithCaret('user draft', 10)
    try {
      const editor = domEditor(root)
      const state = env({ editor: () => editor })
      const recall = new HistoryRecall(state.env)
      recall.onArrow('up', false)
      state.draft.current = 'user draft'
      expect(recall.onArrow('down', false)).toBe(false)
      expect(state.draft.current).toBe('user draft')
    } finally { root.remove() }
  })

  it('passes boundary entry through when the editor is unavailable', () => {
    seed()
    const state = env({ editor: () => null })
    state.draft.current = 'draft'
    const recall = new HistoryRecall(state.env)
    expect(recall.onArrow('up', false)).toBe(false)
    expect(recall.onArrow('down', false)).toBe(false)
    state.draft.current = ''
    expect(recall.onArrow('down', false)).toBe(false)
  })

  it('keeps the current draft when a pruned bucket no longer has the next entry', () => {
    seed()
    const state = env({ editor: () => null })
    const recall = new HistoryRecall(state.env)
    recall.onArrow('up', false)
    recall.onArrow('up', false)
    recall.onArrow('up', false)
    resetInputHistoryForTests()
    remember('replacement', SCOPE)
    expect(recall.onArrow('down', false)).toBe(true)
    expect(state.draft.current).toBe('oldest')
  })
})
