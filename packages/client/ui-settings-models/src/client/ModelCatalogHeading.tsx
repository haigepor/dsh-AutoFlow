/** Catalog section heading shared by both provider editors. */
import { FieldHelp } from './FieldHelp.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the catalog's line artwork, heading, and optional inheritance guidance.
 * @param props - Localized heading and optional catalog override state.
 * @returns A compact heading with a decorative divider.
 */
export function ModelCatalogHeading({ t, overridden }: { t: (key: ModelsKey) => string; overridden?: boolean | undefined }) {
  return <div className={styles['modelCatalogHeading']}>
    <IconDatabaseOutlineRegular className={styles['catalogArtwork']} size={18} />
    <h3 className={styles['modelCatalogTitle']}>{t('models')}</h3>
    {overridden !== undefined && <FieldHelp title={t('models')} text={t(overridden ? 'modelsCustomized' : 'modelsInherited')} t={t} />}
    <span className={styles['catalogDivider']} aria-hidden="true" />
  </div>
}
