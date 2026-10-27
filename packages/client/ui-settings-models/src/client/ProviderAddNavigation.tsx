/** Provider setup reuses the Models page heading and underline navigation. */
import type { ReactNode } from 'react'
import { SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import artwork from './assets/catalog-whale-maid-v1.webp'
import type { ModelsKey } from './locales.ts'
import { FieldHelp } from './FieldHelp.tsx'
import styles from './ProviderConnect.module.css'
import modelsStyles from './ModelsSection.module.css'
import directoryStyles from './ModelsDirectory.module.css'

type AddMode = 'catalog' | 'custom'

/**
 * Render the page heading, connection methods and illustrated section guide.
 * @param props - available methods, current selection and localized copy.
 * @returns the provider setup navigation and guide.
 */
export function ProviderAddNavigation({ id, mode, catalogOffered, customOffered, catalogEnabled, customEnabled,
  disabled, onChange, onActionsTarget, t }: {
  id: string
  mode: AddMode
  catalogOffered: boolean
  customOffered: boolean
  catalogEnabled: boolean
  customEnabled: boolean
  disabled: boolean
  onChange: (mode: AddMode) => void
  onActionsTarget: (target: HTMLDivElement | null) => void
  t: (key: ModelsKey) => string
}): ReactNode {
  const item = (value: AddMode, enabled: boolean): SegmentedTab<AddMode> => ({
    value, id: `${id}-${value}`, panelId: `${id}-${value}-panel`,
    label: t(value === 'catalog' ? 'providerBuiltinTab' : 'providerCustomTab'),
    ariaLabel: t(value === 'catalog' ? 'addCatalog' : 'addCustom'),
    disabled: disabled || !enabled,
    title: enabled ? undefined : t(value === 'catalog' ? 'addCatalogExhausted' : 'addCustomUnavailable'),
  })
  return <>
    <div className={directoryStyles['pageHeading']}>
      <header className={modelsStyles['pageHeader']} data-settings-page-header>
        <div><h1 className={modelsStyles['title']} tabIndex={-1} data-provider-heading>{t('add')}</h1>
          <p className={modelsStyles['intro']}>{t('providerSetupSubtitle')}</p></div>
      </header>
      <div ref={onActionsTarget} className={styles['actionsHost']} data-provider-actions />
    </div>
    <div className={styles['navigation']}>
      {catalogOffered && customOffered
        ? <SegmentedTabs items={[item('catalog', catalogEnabled), item('custom', customEnabled)]}
          value={mode} onChange={onChange} label={t('addMode')} variant="underline" className={directoryStyles['tabs']} />
        : <div className={styles['singleMethod']}>{t(mode === 'catalog' ? 'providerBuiltinTab' : 'providerCustomTab')}</div>}
      <div className={styles['introduction']}>
        <img className={directoryStyles['catalogArtwork']} src={artwork} width={104} height={104} alt="" aria-hidden="true" draggable={false} decoding="async" />
        <div>
          <div className={styles['introTitle']}><h3>{t(mode === 'catalog' ? 'providerCatalogTitle' : 'providerCustomTitle')}</h3>
            <FieldHelp key={mode} title={t(mode === 'catalog' ? 'addCatalog' : 'addCustom')}
              text={t(mode === 'catalog' ? 'addCatalogHint' : 'addCustomHint')} t={t} />
          </div>
          <p>{t(mode === 'catalog' ? 'providerCatalogLead' : 'providerCustomLead')}</p>
        </div>
      </div>
    </div>
  </>
}
