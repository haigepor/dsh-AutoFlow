/** Model-summary table shared by the two provider setup forms. */
import type { ReactNode } from 'react'
import type { ModelsKey } from './locales.ts'
import styles from './ProviderConnect.module.css'

/**
 * Keep model columns aligned and horizontal overflow inside the catalog.
 * @param props - Localized headings and model or empty-state rows.
 * @returns A native table with one row group for keyboard reordering.
 */
export function ProviderModelTable({ t, children }: {
  t: (key: ModelsKey) => string
  children: ReactNode
}): ReactNode {
  return <div className={styles['tableScroll']} data-provider-model-table>
    <table className={styles['table']} aria-label={t('models')}>
      <thead><tr>
        <th scope="col">{t('directoryModel')}</th>
        <th scope="col">{t('directoryCapabilities')}</th>
        <th scope="col">{t('contextWindow')}</th>
        <th scope="col">{t('modelActions')}</th>
      </tr></thead>
      <tbody data-model-list>{children}</tbody>
    </table>
  </div>
}
