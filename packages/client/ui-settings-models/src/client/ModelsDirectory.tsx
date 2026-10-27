/** Model-first catalog and provider navigation built from the shared settings snapshot. */
import { useId, useRef, useState, type ReactNode } from 'react'
import { focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button, Input, Menu, SegmentedTabs, Tag, Tooltip, IconChevronDownOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { modelDirectory, type ModelDirectoryGroup } from './model-directory.ts'
import type { ModelsSettingsState, ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelsKey } from './locales.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { providerCopy } from './ModelsSection.tsx'
import { modelReasoningLevels } from './model-reasoning.ts'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import styles from './ModelsDirectory.module.css'
import catalogArtwork from './assets/catalog-whale-maid-v1.webp'
import providerArtwork from './assets/provider-directory-whale-maid-v1.webp'
import connectionArtwork from './assets/provider-connection-blocks-v1.webp'

/** Compact notation keeps large capacities scannable; the exact token count stays visible. */
const compactCapacity = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const exactCapacity = new Intl.NumberFormat('en-US')

/** A single-model draft keeps the entire array to preserve sibling records on save. */
export interface ModelEditTarget {
  models: readonly DeepSeekModelDraft[]
  index: number
}

/** Views sharing one live model/provider snapshot. */
export type ModelsDirectoryTab = 'models' | 'providers' | 'subscription'

interface ModelsDirectoryProps extends Partial<PropsRenderSlots<'settings.models.subscription'>> {
  state: ModelsSettingsState
  schema: SettingsSchemaOperations
  t: (key: ModelsKey) => string
  onEdit: (row: ProviderRow, model?: ModelEditTarget) => void
  onRemove: (row: ProviderRow) => void
  removable: (row: ProviderRow) => boolean
  onRetry: () => void
  tab?: ModelsDirectoryTab
  onTabChange?: (tab: ModelsDirectoryTab) => void
}

/**
 * Render searchable effective models and a separate provider management panel.
 * @param props - settings snapshot and existing editor actions.
 * @returns catalog tabs, filters, model table, and provider cards.
 */
export function ModelsDirectory({
  state, schema, t, onEdit, onRemove, removable, onRetry, tab: controlledTab, onTabChange, renderSlot,
}: ModelsDirectoryProps): ReactNode {
  const id = useId()
  const [localTab, setTab] = useState<ModelsDirectoryTab>('models')
  const tab = controlledTab ?? localTab
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const groups = modelDirectory(state.rows, state.namespaces, schema)
  const selected = groups.find(group => group.row.entry.provider === provider)
  const selectedId = selected?.row.entry.provider ?? ''
  const needle = query.trim().toLocaleLowerCase()
  const entries = groups.flatMap(group => group.models.map((model, index) => ({ group, model, index })))
  const visible = entries.filter(({ group, model }) => (selectedId === '' || group.row.entry.provider === selectedId)
    && [model['id'], model['name']].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(needle)))
  const editable = groups.filter(group => group.editable)
  const addModel = (group: ModelDirectoryGroup): void => {
    setAddOpen(false)
    // 菜单项会卸载，先将焦点还给持久入口，供弹窗记录并在取消后恢复。
    if (addTrigger.current !== null) focusWithoutRing(addTrigger.current)
    onEdit(group.row, { models: [...group.models, { id: '' }], index: group.models.length })
  }
  return <div className={styles['directory']}>
    <SegmentedTabs className={styles['tabs']} value={tab} onChange={onTabChange ?? setTab} label={t('directoryNavigation')} variant="underline"
      items={[
        { value: 'models', label: t('modelDirectory'), id: `${id}-models`, panelId: `${id}-models-panel` },
        { value: 'providers', label: t('providers'), id: `${id}-providers`, panelId: `${id}-providers-panel` },
        { value: 'subscription', label: t('subscriptionTab'), id: `${id}-subscription`, panelId: `${id}-subscription-panel` },
      ]} />
    <section role="tabpanel" id={`${id}-models-panel`} aria-labelledby={`${id}-models`} hidden={tab !== 'models'}>
      <div className={`${styles['heading']} ${styles['catalogHeading']}`}>
        <div className={styles['catalogIntro']}>
          <img className={styles['catalogArtwork']} src={catalogArtwork} width={104} height={104}
            alt="" aria-hidden="true" draggable={false} decoding="async" />
          <div><h2>{t('modelDirectory')} <span className={styles['count']}>{entries.length}</span></h2>
            <p>{t('directoryDescription')}</p></div>
        </div>
        <Menu open={addOpen} portal autoFocus onClose={() => { setAddOpen(false) }}
          items={editable.map(group => ({ id: group.row.entry.provider, label: group.row.entry.displayName }))}
          onSelect={(value) => {
            const group = editable.find(item => item.row.entry.provider === value)
            if (group !== undefined) addModel(group)
          }}
          anchor={<Button ref={addTrigger} variant="outline" icon={<IconPlusOutlineRegular size={16} />}
            disabled={!state.writable || editable.length === 0 || state.status === 'loading'}
            aria-haspopup="menu" aria-expanded={addOpen} onClick={() => { if (selected?.editable === true) addModel(selected); else setAddOpen(value => !value) }}>
            {t('addModel')}</Button>} />
      </div>
      <div className={styles['catalogSurface']}>
        <div className={styles['filters']}>
          <Input className={styles['search'] as string} icon={<IconSearchOutlineRegular size={16} />}
            type="search" value={query} aria-label={t('searchModels')} placeholder={t('searchModels')}
            onChange={(event) => { setQuery(event.target.value) }} />
          <div className={styles['filter']}><span>{t('provider')}</span>
            <Menu open={filterOpen} portal autoFocus selectedId={selectedId} onClose={() => { setFilterOpen(false) }}
              items={[{ id: '', label: t('allProviders') }, ...groups.map(group => ({ id: group.row.entry.provider, label: group.row.entry.displayName }))]}
              onSelect={(value) => { setProvider(value); setFilterOpen(false) }}
              anchor={<Button variant="outline" aria-label={t('filterProvider')} aria-haspopup="menu" aria-expanded={filterOpen}
                onClick={() => { setFilterOpen(value => !value) }}>{selected?.row.entry.displayName ?? t('allProviders')} <IconChevronDownOutlineRegular size={16} /></Button>} />
          </div>
        </div>
        {groups.filter(group => group.row.catalogError !== undefined).map(group => <div role="alert" className={styles['hint']} key={group.row.entry.provider}>
          {group.row.entry.displayName}: {group.row.catalogError}
          <Button variant="ghost" size="sm" disabled={state.status === 'loading'} onClick={onRetry}>{t('retry')}</Button></div>)}
        <div className={styles['tableScroll']}>
          <table className={styles['table']} aria-label={t('modelDirectory')}>
            <thead><tr><th scope="col">{t('directoryModel')}</th><th scope="col">{t('provider')}</th><th scope="col">{t('directoryCapabilities')}</th><th scope="col">{t('contextWindow')}</th><th scope="col">{t('modelActions')}</th></tr></thead>
            <tbody>{visible.map(({ group, model, index }, position) => {
              const modelId = typeof model['id'] === 'string' ? model['id'] : ''
              const metadata = group.metadata.get(modelId)
              const input = model['inputModalities'] ?? model['input'] ?? metadata?.inputModalities ?? schema.getPath(group.profile, ['defaultInput'])
              const modalities = Array.isArray(input) ? input : []
              const reasoning = modelReasoningLevels(model, group.reasoning, metadata?.reasoning,
                group.row.entry.settingsNs === 'llm-deepseek').some(level => level !== 'off' && level !== 'none')
              const context = model['contextWindow'] ?? metadata?.contextWindow ?? schema.getPath(group.profile, ['defaultContextWindow'])
              return <tr key={`${group.row.entry.provider}:${modelId}:${String(index)}`}>
                <td><div className={styles['modelIdentity']}>
                  <span className={styles['modelMark']} aria-hidden="true">{(position + 1).toString().padStart(2, '0')}</span>
                  <div className={styles['modelText']}><span className={styles['modelName']}>{typeof model['name'] === 'string' ? model['name'] : modelId}</span>
                    <code>{modelId}</code></div>
                </div></td>
                <td><Tag tone="info" className={styles['providerTag']}>{group.row.entry.displayName}</Tag></td>
                <td><div className={styles['capabilities']}>
                  {modalities.includes('image') && <Tag tone="info">{t('modelInputImage')}</Tag>}
                  {modalities.includes('text') && <Tag tone="success">{t('modelInputText')}</Tag>}
                  {reasoning && <Tag tone="neutral" className={styles['reasoningTag']}>{t('directoryReasoning')}</Tag>}
                  {modalities.length === 0 && !reasoning && <span className={styles['hint']}>{t('directoryInherited')}</span>}
                </div></td>
                <td>{typeof context === 'number' ? <div className={styles['capacity']}>
                  <span>{compactCapacity.format(context)}</span><small>{exactCapacity.format(context)} {t('directoryTokens')}</small>
                </div> : <span className={styles['hint']}>{t('directoryInherited')}</span>}</td>
                <td>{group.editable ? <Button className={styles['editAction']} variant="ghost" size="sm" icon={<IconEditOutlineRegular size={14} />}
                  disabled={!state.writable || state.status === 'loading'}
                  aria-label={`${t('edit')} ${modelId}`} onClick={() => { onEdit(group.row, { models: group.models, index }) }}>{t('edit')}</Button>
                  : <span className={styles['hint']}>{t('directoryManaged')}</span>}</td>
              </tr>
            })}</tbody>
          </table>
        </div>
        {visible.length === 0 && <div className={styles['empty']}><h3>{t(entries.length === 0 ? 'directoryEmpty' : 'directoryNoResults')}</h3>
          <p>{t(entries.length === 0 ? 'directoryEmptyHint' : 'directoryNoResultsHint')}</p>
          {entries.length > 0 && <Button variant="outline" onClick={() => { setQuery(''); setProvider('') }}>{t('clearFilters')}</Button>}</div>}
        <p className={styles['summary']} role="status">{t('directoryCount').replace('{shown}', String(visible.length)).replace('{total}', String(entries.length))}</p>
      </div>
    </section>
    <section role="tabpanel" id={`${id}-providers-panel`} aria-labelledby={`${id}-providers`} hidden={tab !== 'providers'}>
      <div className={`${styles['heading']} ${styles['catalogHeading']}`}>
        <div className={styles['catalogIntro']}>
          <img className={styles['catalogArtwork']} src={providerArtwork} width={104} height={104}
            alt="" aria-hidden="true" draggable={false} decoding="async" />
          <div><h2>{t('providers')} <span className={styles['count']}>{groups.length}</span></h2>
            <p>{t('providerDirectoryHint')}</p></div>
        </div>
      </div>
      <div className={styles['providerGrid']}>{groups.map((group) => {
        const { row } = group
        const status = row.entry.provider === 'autoflow-codex' ? row.accountAvailable === true ? 'accountSignedIn' : 'subscriptionNeedsLogin'
          : row.entry.provider === 'deepseek-account' ? 'accountSignedIn' : row.credential?.configured === true ? 'credentialConfigured'
            : row.credential?.configured === false && row.apiKeyEnv !== undefined ? 'credentialMissing'
              : row.apiKeyEnv !== undefined ? 'keyFallbackUnchecked' : 'directoryAuthManaged'
        return <article className={styles['providerCard']} key={row.entry.provider} aria-labelledby={`${id}-${row.entry.provider}-name`}>
          <div className={styles['providerHeading']}>
            <span className={styles['providerBrand']} aria-hidden="true"><ProviderBrandIcon provider={row.entry.provider} size={24} /></span>
            <div className={styles['providerIdentity']}>
              <h3 id={`${id}-${row.entry.provider}-name`}>{row.entry.displayName}</h3>
              {row.entry.provider !== row.entry.displayName && <code>{row.entry.provider}</code>}
            </div>
            {row.entry.declared === true && <Tag tone="neutral">{t('customTag')}</Tag>}
          </div>
          <div className={styles['providerFacts']}>
            <div>
              <p className={styles['providerModels']}>{t('providerModelCount').replace('{count}', String(group.models.length))}</p>
              <p className={styles['providerStatus']} data-state={status === 'credentialConfigured' || status === 'accountSignedIn' ? 'configured' : status === 'credentialMissing' ? 'missing' : 'managed'}>
                <span aria-hidden="true" />{t(status)}</p>
            </div>
            <img src={connectionArtwork} width={72} height={72} alt="" aria-hidden="true" draggable={false} decoding="async" />
          </div>
          {row.entry.error !== undefined && <p role="alert">{row.entry.error}</p>}
          <div className={styles['providerActions']}>
            <Button variant="outline" size="sm" icon={<IconEditOutlineRegular size={14} />} data-provider-row disabled={state.status === 'loading'} aria-label={providerCopy(t('editProvider'), row.entry)} onClick={() => { onEdit(row) }}>{t('providerDetails')}</Button>
            {removable(row) && <Tooltip label={providerCopy(t(row.entry.provider === 'deepseek-official' ? 'resetProvider' : 'removeProvider'), row.entry)} portal>
              <Button className={styles['providerRemove']} variant="ghost" size="sm" disabled={!state.writable || state.status === 'loading'} icon={<IconTrashOutlineRegular size={16} />}
                aria-label={providerCopy(t(row.entry.provider === 'deepseek-official' ? 'resetProvider' : 'removeProvider'), row.entry)} onClick={() => { onRemove(row) }} />
            </Tooltip>}
          </div>
        </article>
      })}</div>
    </section>
    <section role="tabpanel" id={`${id}-subscription-panel`} aria-labelledby={`${id}-subscription`} hidden={tab !== 'subscription'}>
      {tab === 'subscription' && (renderSlot === undefined ? <p className={styles['hint']}>{t('subscriptionMissing')}</p> : renderSlot('settings.models.subscription', {}))}
    </section>
  </div>
}
