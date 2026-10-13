/** Local dialog chrome uses shared controls, material and focus management. */
import type { ReactNode } from 'react'
import { Button, Modal, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './settings-dialog.module.css'

/** Render local chrome with the shared Escape, focus trap and return-focus behavior.
 * @param props Dialog copy, feature content and optional save feedback.
 * @returns A body-portaled modal while its caller keeps it mounted.
 */
export function SettingsDialog({ title, description, icon, catalog, children, onClose, closeLabel, doneLabel, feedback, error }: {
  title: string; description: string; icon?: ReactNode; catalog?: boolean; children: ReactNode
  onClose: () => void; closeLabel: string; doneLabel: string; feedback?: string; error?: boolean
}) {
  return <Modal open headless title={title} onClose={onClose} className={`${css.modal}${catalog ? ` ${css.catalog}` : ''}`}>
    <header className={css.header}>
      {icon && <span className={css.icon} aria-hidden="true">{icon}</span>}
      <div className={css.heading}><h2>{title}</h2><p>{description}</p></div>
      <Button variant="ghost" size="sm" className={css.close} aria-label={closeLabel} onClick={onClose}><IconCloseOutlineRegular size={16} /></Button>
    </header>
    <div className={css.body}>{children}</div>
    <footer className={css.footer}>
      {feedback && <span role={error ? 'alert' : 'status'}>{feedback}</span>}
      <Button className={css.done} variant="primary" onClick={onClose}>{doneLabel}</Button>
    </footer>
  </Modal>
}
