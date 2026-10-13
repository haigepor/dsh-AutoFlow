/** CSS-only CodeMirror surface; draft persistence and writes remain with the settings form. */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { cmSurfaceTheme, CmThemeCompartment } from '../../../src/client/cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from '../../../src/client/theme.ts'

/** Render highlighted CSS without changing the parent form's explicit-save semantics. */
export function CssCodeEditor({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const editable = useRef(new Compartment())
  const latest = useRef({ value, disabled, onChange })
  latest.current = { value, disabled, onChange }
  useEffect(() => {
    if (!host.current) return
    const theme = new CmThemeCompartment()
    const editor = new EditorView({ parent: host.current, state: EditorState.create({
      doc: latest.current.value,
      extensions: [css(), history(), lineNumbers(), drawSelection(), keymap.of([...defaultKeymap, ...historyKeymap]),
        cmSurfaceTheme, theme.of(isDarkScheme()), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ id: 'bs-settings-css', 'aria-labelledby': 'bs-settings-css-label', spellcheck: 'false' }),
        editable.current.of(EditorState.readOnly.of(latest.current.disabled)),
        EditorView.updateListener.of(update => {
          // 外部撤销/刷新不记为用户输入；编辑器自身撤销仍更新草稿。
          if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(Transaction.remote))) latest.current.onChange(update.state.doc.toString())
        }),
      ],
    }) })
    view.current = editor
    const unsubscribe = subscribeColorScheme(() => editor.dispatch({ effects: theme.reconfigure(isDarkScheme()) }))
    // 折叠区展开或拖动编辑器高度后重新测量，保留光标与滚动位置。
    const resize = new ResizeObserver(() => editor.requestMeasure())
    resize.observe(host.current)
    return () => { resize.disconnect(); unsubscribe(); editor.destroy(); view.current = null }
  }, [])
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    })
  }, [value])
  useEffect(() => { view.current?.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(disabled)) }) }, [disabled])
  return <div ref={host} className="bs-settings-code-editor" />
}
