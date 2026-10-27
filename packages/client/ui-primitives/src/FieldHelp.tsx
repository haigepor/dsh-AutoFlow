/** Click-open field guidance using the application's shared menu material. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { IconCloseOutlineRegular } from './icons/index.tsx'
import { MenuSurface } from './MenuSurface.tsx'
import { isBehindModal } from './useModalLayer.ts'
import { useAnchoredPosition } from './useAnchoredPosition.ts'
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer.ts'
import styles from './FieldHelp.module.css'

/** Localized content and control labels for a click-open help panel. */
export interface FieldHelpProps {
  title: string
  text: string
  label: string
  closeLabel: string
}

/**
 * Keep optional guidance behind an accessible information button.
 * @param props - Visible subject, explanatory text, and localized control labels.
 * @returns A trigger and its viewport-constrained explanation panel.
 */
export function FieldHelp({ title, text, label, closeLabel }: FieldHelpProps): ReactNode {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 6, margin: 12 })
  useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef)
  useEffect(() => { if (open) panelRef.current?.focus({ preventScroll: true }) }, [open])
  useEffect(() => {
    if (!open) return
    // The portaled help handles Escape before an underlying dialog, including while its trigger has focus.
    const dismiss = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || isBehindModal(anchorRef.current)
        || event.ctrlKey || event.altKey || event.metaKey || (event.key === 'Escape' && event.shiftKey)) return
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
      if (event.repeat) return
      setOpen(false)
      anchorRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', dismiss, true)
    return () => { document.removeEventListener('keydown', dismiss, true) }
  }, [open])
  const close = () => { setOpen(false); anchorRef.current?.focus({ preventScroll: true }) }
  return <>
    <button ref={anchorRef} type="button" className={styles['helpButton']}
      aria-label={label} aria-expanded={open} aria-haspopup="dialog"
      aria-controls={open ? id : undefined} onClick={() => { setOpen(value => !value) }}>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M5.25 3.5h9.5a2 2 0 0 1 2 2V12a2 2 0 0 1-2 2H9l-4.25 3v-3a2 2 0 0 1-1.5-1.94V5.5a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        <path d="M6.75 7h6.5M6.75 10.5H11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    </button>
    {open && createPortal(
      <MenuSurface ref={panelRef} id={id} role="dialog" aria-label={title} aria-describedby={`${id}-text`}
        tabIndex={-1} className={styles['helpPanel']} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== anchorRef.current) setOpen(false)
        }}>
        <div className={styles['helpHeading']}>
          <span>{title}</span>
          <button type="button" className={styles['helpButton']} aria-label={closeLabel} onClick={close}>
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>
        <p id={`${id}-text`}>{text}</p>
      </MenuSurface>, document.body,
    )}
  </>
}
