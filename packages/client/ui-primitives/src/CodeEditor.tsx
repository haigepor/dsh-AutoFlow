/** Native editing with the same Shiki tokens as the project's code views. */
import { Fragment, useMemo, useRef } from 'react'
import { useCodeHighlighter } from './code-highlighting.ts'
import css from './CodeEditor.module.css'

/** Controlled source text and complete localized accessibility labels. */
export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  label: string
  language: string
  disabled?: boolean
}

/**
 * Keep native selection, undo, composition, and focus while rendering shared syntax colors behind the input.
 * @param props - source, language, editable state, localized label, and draft callback.
 * @returns a synchronized source editor without persistence or save shortcuts.
 */
export function CodeEditor({ value, onChange, label, language, disabled = false }: CodeEditorProps) {
  const highlight = useCodeHighlighter(language)
  const tokens = useMemo(() => highlight(value), [highlight, value])
  const backdrop = useRef<HTMLPreElement>(null)
  return <div className={css.editor} data-code-editor>
    <pre ref={backdrop} className={css.highlight} aria-hidden="true"><code>{tokens === undefined ? value : tokens.map((line, index) =>
      <Fragment key={index}>{index > 0 ? '\n' : ''}{line.map((span, part) => <span key={part} style={span.style}>{span.text}</span>)}</Fragment>)}{'\n'}</code></pre>
    <textarea className={css.input} aria-label={label} value={value} disabled={disabled} spellCheck={false}
      autoCapitalize="off" autoCorrect="off" wrap="off" onChange={(event) => { onChange(event.target.value) }}
      onScroll={(event) => {
        if (backdrop.current === null) return
        backdrop.current.scrollTop = event.currentTarget.scrollTop
        backdrop.current.scrollLeft = event.currentTarget.scrollLeft
      }} />
  </div>
}
