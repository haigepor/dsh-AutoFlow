/** Height transitions that retain provider and model drafts while folded. */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/**
 * Keep folded content mounted while removing it from keyboard navigation.
 * @param props - controlled expansion, optional panel id, and drafted content.
 * @returns an interruptible grid-height transition.
 */
export function AnimatedDisclosure({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (panel.current !== null) panel.current.inert = !open }, [open])
  return <div ref={panel} id={id} className={styles['disclosure']} data-open={open} aria-hidden={!open}>
    <div className={styles['disclosureClip']}>{children}</div>
  </div>
}
