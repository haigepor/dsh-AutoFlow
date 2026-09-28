/** Click-open field guidance using the application's shared menu material. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutlineRegular, MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Keep optional guidance behind an accessible information button.
 * @param props - Visible subject, explanatory text, and localized control labels.
 * @returns A trigger and its viewport-constrained explanation panel.
 */
export function FieldHelp({ title, text, t }: { title: string; text: string; t: (key: ModelsKey) => string }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 6, margin: 12 })
  useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef)
  useEffect(() => { if (open) panelRef.current?.focus({ preventScroll: true }) }, [open])
  const close = () => { setOpen(false); anchorRef.current?.focus({ preventScroll: true }) }
  return <>
    <button ref={anchorRef} type="button" className={styles['helpButton']}
      aria-label={t('helpFor').replace('{field}', title)} aria-expanded={open} aria-haspopup="dialog"
      aria-controls={open ? id : undefined} onClick={() => { setOpen(value => !value) }}>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10 9v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="10" cy="6.3" r=".9" fill="currentColor" />
      </svg>
    </button>
    {open && createPortal(
      <MenuSurface ref={panelRef} id={id} role="dialog" aria-label={title} aria-describedby={`${id}-text`}
        tabIndex={-1} className={styles['helpPanel']} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== anchorRef.current) setOpen(false)
        }}>
        <div className={styles['helpHeading']}>
          <span>{title}</span>
          <button type="button" className={styles['helpButton']} aria-label={t('close')} onClick={close}>
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>
        <p id={`${id}-text`}>{text}</p>
      </MenuSurface>, document.body,
    )}
  </>
}
