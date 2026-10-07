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
    <svg className={styles['catalogArtwork']} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6M7 7h8M7 11h5M7 15h3" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M16 14v-2m3 2v-2m-3 9v2m3-2v2m-5-7h-2m2 3h-2m9-3h2m-2 3h2" />
    </svg>
    <h3 className={styles['modelCatalogTitle']}>{t('models')}</h3>
    {overridden !== undefined && <FieldHelp title={t('models')} text={t(overridden ? 'modelsCustomized' : 'modelsInherited')} t={t} />}
    <span className={styles['catalogDivider']} aria-hidden="true" />
  </div>
}
