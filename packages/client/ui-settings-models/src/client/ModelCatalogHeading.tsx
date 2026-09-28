/** Catalog section heading shared by both provider editors. */
import { FieldHelp } from './FieldHelp.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Render the catalog's line artwork, heading, and optional inheritance guidance.
 * @param props - Localized heading and optional catalog override state.
 * @returns A compact heading with a decorative divider.
 */
export function ModelCatalogHeading({ t, overridden }: { t: (key: ModelsKey) => string; overridden?: boolean | undefined }) {
  return <div className={styles['modelCatalogHeading']}>
    <svg className={styles['catalogArtwork']} width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 11v3a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 14v-3M4 18v1a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7 6h3M7 13h3M7 18h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
    <h3 className={styles['modelCatalogTitle']}>{t('models')}</h3>
    {overridden !== undefined && <FieldHelp title={t('models')} text={t(overridden ? 'modelsCustomized' : 'modelsInherited')} t={t} />}
    <span className={styles['catalogDivider']} aria-hidden="true" />
  </div>
}
