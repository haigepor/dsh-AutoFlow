/** Shared dialog frame for catalog models and provider model drafts. */
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsDirectory.module.css'

/**
 * Keep both model-entry flows on the same dialog size, chrome and scroll area.
 * @param props - Visibility, dismissal, localized copy, model form and its actions.
 * @returns The project's model editing dialog.
 */
export function ModelEditorDialog({ open, onClose, t, children, footer }: {
  open: boolean
  onClose: () => void
  t: (key: ModelsKey) => string
  children: ReactNode
  footer?: ReactNode
}): ReactNode {
  return <Modal open={open} onClose={onClose} title={t('editModel')} closeLabel={t('close')}
    closeOnBackdropClick={false} className={`${styles['editorDialog']} ${styles['modelDialog']}`}
    contentClassName={styles['editorContent'] as string} footer={footer}>
    {children}
  </Modal>
}
