/** Manual text/image choices share one account pool and keep native capabilities authoritative. */
import { useId, useState } from 'react'
import { Button, Input, Menu, Modal, SegmentedTabs, StateDot, Switch, Tag, Tooltip, IconChevronDownOutlineRegular, IconCodeOutlineRegular, IconDatabaseOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubscriptionCatalogEntry } from './subscription-api.ts'
import type { SubscriptionState, SubscriptionController } from './subscription-controller.ts'
import type { ModelsKey } from './locales.ts'
import { EditorIntroduction } from './EditorIntroduction.tsx'
import { ProviderBrandIcon } from './ProviderBrandIcon.tsx'
import { ProviderFieldIcon } from './ProviderFieldIcon.tsx'
import { ModelCapabilities } from './ModelCapabilities.tsx'
import directoryCss from './ModelsDirectory.module.css'
import css from './SubscriptionPage.module.css'

type Props = Pick<SubscriptionState, 'catalog' | 'catalogStatus' | 'catalogError'> & {
  busy: boolean
  onClose(): void
  loadCatalog: SubscriptionController['loadCatalog']
  saveCatalog: SubscriptionController['saveCatalog']
  t(key: ModelsKey): string
}

/** Stage text/image choices locally and save the batch through one catalog update.
 * @param props Safe configuration, owner callbacks and localized copy.
 * @returns One shared model-management dialog.
 */
export function SubscriptionModels({ catalog, catalogStatus, catalogError, busy, onClose, loadCatalog, saveCatalog, t }: Props) {
  const id = useId()
  const [kind, setKind] = useState<'text' | 'image'>('text'), [modelId, setModelId] = useState(''), [name, setName] = useState('')
  const [modelOpen, setModelOpen] = useState(false), [makeDefault, setMakeDefault] = useState(false)
  const [editing, setEditing] = useState<SubscriptionCatalogEntry | null>(null)
  const [nativeWebSearch, setNativeWebSearch] = useState<boolean | undefined>()
  const [pending, setPending] = useState<readonly SubscriptionCatalogEntry[]>([])
  const [pendingDefault, setPendingDefault] = useState<string | undefined>()
  const [imageDirty, setImageDirty] = useState(false)
  const keyOf = (entry: Pick<SubscriptionCatalogEntry, 'kind' | 'id'>): string => `${entry.kind}:${entry.id}`
  const validId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(value)
  const candidate = catalog?.candidates.find(model => model.id === modelId)
  const formEntry: SubscriptionCatalogEntry = { kind, id: modelId.trim(), name: name.trim(),
    ...kind !== 'text' || nativeWebSearch === undefined ? {} : { nativeWebSearch } }
  const duplicate = catalog?.entries.some(entry => keyOf(entry) === keyOf(formEntry) && (editing === null || keyOf(entry) !== keyOf(editing))) === true
    || pending.some(entry => keyOf(entry) === keyOf(formEntry))
  const valid = catalog !== null && catalogStatus === 'ready' && validId(formEntry.id) && formEntry.name !== '' && !duplicate
    && (kind === 'image' || candidate !== undefined || editing?.kind === 'text' && editing.id === modelId)
  const selectedText = pending.filter(entry => entry.kind === 'text')
  // 切到生图页签的预填值不加入已有批次，只有用户编辑后的表单才随批次保存。
  const includeForm = editing !== null || kind === 'image' && (imageDirty || pending.length === 0) && (formEntry.id !== '' || formEntry.name !== '')
  const pendingInvalid = pending.some(entry => !validId(entry.id) || entry.name.trim() === '')
  const pendingConflict = pending.some(entry => catalog?.entries.some(current => keyOf(current) === keyOf(entry)))
  const ready = catalog !== null && catalogStatus === 'ready'
  const canSave = ready && !pendingInvalid && !pendingConflict && (pending.length > 0 || includeForm) && (!includeForm || valid)
  const saveCount = pending.length + (includeForm ? 1 : 0)
  const availableText = catalog?.candidates.filter(model => validId(model.id) && !catalog.entries.some(entry => entry.kind === 'text' && entry.id === model.id)) ?? []
  const edit = (entry: SubscriptionCatalogEntry): void => {
    setNativeWebSearch(entry.nativeWebSearch)
    setEditing(entry); setKind(entry.kind); setModelId(entry.id); setName(entry.name); setMakeDefault(false); setImageDirty(false); setModelOpen(false)
  }
  const chooseKind = (value: 'text' | 'image'): void => {
    setNativeWebSearch(undefined)
    setKind(value); setEditing(null); setModelOpen(false); setMakeDefault(false); setImageDirty(false)
    setModelId(value === 'image' ? catalog?.defaultImageModel ?? '' : '')
    setName(value === 'image' ? catalog?.defaultImageModel ?? '' : '')
  }
  const selectModel = (value: string): void => {
    if (value === '$done') { setModelOpen(false); return }
    if (value === '$clear') { setPending(current => current.filter(entry => entry.kind !== 'text')); return }
    if (value === '$all') {
      setPending(current => [...current, ...availableText.filter(model => !current.some(entry => entry.kind === 'text' && entry.id === model.id))
        .map(model => ({ kind: 'text' as const, id: model.id, name: model.name }))])
      return
    }
    const model = catalog?.candidates.find(item => item.id === value)
    if (model === undefined) return
    if (editing !== null) { setModelId(model.id); setName(model.name); setModelOpen(false); return }
    setPending(current => current.some(entry => entry.kind === 'text' && entry.id === model.id)
      ? current.filter(entry => entry.kind !== 'text' || entry.id !== model.id)
      : [...current, { kind: 'text', id: model.id, name: model.name }])
  }
  const stageImage = (): void => {
    if (!valid || busy || kind !== 'image' || editing !== null) return
    setPending(current => current.some(entry => keyOf(entry) === keyOf(formEntry)) ? current : [...current, formEntry])
    if (makeDefault) setPendingDefault(formEntry.id)
    setModelId(''); setName(''); setMakeDefault(false); setImageDirty(false)
  }
  const removePending = (entry: SubscriptionCatalogEntry): void => {
    setPending(current => current.filter(item => keyOf(item) !== keyOf(entry)))
    if (entry.kind === 'image' && pendingDefault === entry.id) setPendingDefault(undefined)
  }
  const saveAll = async (): Promise<void> => {
    if (!canSave || busy || catalog === null) return
    // 选择与队列只写本地草稿；最终合并最新目录，一次提交，失败保留整批内容。
    const entries = catalog.entries.filter(entry => editing === null || keyOf(entry) !== keyOf(editing))
    entries.push(...pending.map(entry => ({ ...entry, name: entry.name.trim() })))
    if (includeForm) entries.push(formEntry)
    const defaultModel = includeForm && kind === 'image' && makeDefault ? formEntry.id : pendingDefault
    if (await saveCatalog(entries, defaultModel)) onClose()
  }
  const renderModels = (entries: readonly SubscriptionCatalogEntry[], queued: boolean) => <div className={css['modelTableScroll']}>
    <table className={css['modelTable']} aria-label={t(queued ? 'subscriptionPendingModels' : 'subscriptionConfiguredModels')}>
      <thead><tr><th scope="col">{t('directoryModel')}</th><th scope="col">{t('subscriptionModelKind')}</th><th scope="col">{t('modelActions')}</th></tr></thead>
      <tbody>{entries.length === 0 ? <tr><td colSpan={3} className={css['modelTableEmpty']}><span><IconDatabaseOutlineRegular size={20} />{t('subscriptionNoConfiguredModels')}</span></td></tr>
        : entries.map(entry => <tr key={keyOf(entry)} className={css['modelTableRow']}><td><div className={css['modelTableIdentity']}>
          {queued ? <Input className={css['modelPendingInput'] as string} aria-label={`${t('subscriptionModelName')} · ${entry.id}`} value={entry.name} maxLength={200} disabled={busy}
            aria-invalid={entry.name.trim() === ''} onChange={event => { const value = event.target.value; setPending(current => current.map(item => keyOf(item) === keyOf(entry) ? { ...item, name: value } : item)) }} />
            : <strong>{entry.name}</strong>}<code>{entry.id}</code></div></td>
          <td><div className={css['modelTableTags']}><Tag tone={entry.kind === 'text' ? 'success' : 'info'}>{t(entry.kind === 'text' ? 'subscriptionTextModel' : 'subscriptionImageModel')}</Tag>
            {entry.kind === 'image' && entry.id === (queued ? pendingDefault : catalog?.defaultImageModel) && <Tag tone="info">{t('subscriptionDefaultImageTag')}</Tag>}
            {!queued && entry.kind === 'text' && !catalog?.candidates.some(model => model.id === entry.id) && <Tag tone="warning">{t('subscriptionModelUnavailable')}</Tag>}</div></td>
          <td><div className={css['modelTools']}>{!queued && <Tooltip label={t('subscriptionEditModel')}><Button variant="ghost" size="sm" aria-label={`${t('subscriptionEditModel')} · ${entry.name}`} disabled={busy}
            icon={<IconEditOutlineRegular size={16} />} onClick={() => { edit(entry) }} /></Tooltip>}
            <Tooltip label={t('subscriptionRemoveModel')}><Button variant="ghost" size="sm" aria-label={`${t('subscriptionRemoveModel')} · ${entry.name}`} disabled={busy || !queued && !ready}
              icon={<IconTrashOutlineRegular size={16} />} onClick={() => { if (queued) removePending(entry); else if (catalog !== null) void saveCatalog(catalog.entries.filter(model => keyOf(model) !== keyOf(entry))) }} /></Tooltip></div></td>
        </tr>)}</tbody>
    </table>
  </div>
  return <Modal open onClose={() => { if (!busy) onClose() }} title={t('subscriptionManageModels')} closeLabel={t('close')}
    closeOnBackdropClick={false} className={`${directoryCss['editorDialog']} ${directoryCss['modelDialog']} ${css['modelDialog']}`} contentClassName={css['modelDialogContent'] as string}
    footer={<div className={css['modelDialogFooter']}><span className={css['modelBatchCount']} role="status">{t('subscriptionPendingCount').replace('{count}', String(saveCount))}</span>
      <div className={css['modelFooterActions']}><Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || !canSave} onClick={() => { void saveAll() }}>{t('subscriptionSaveAllModels')}</Button></div></div>}>
    <div className={css['modelDialogBody']}>
    <div className={css['modelIntro']}><EditorIntroduction kind="model" title={t(editing === null ? 'subscriptionAddModel' : 'subscriptionEditModel')}
      description={t('subscriptionModelHint')} icon={<ProviderBrandIcon provider="openai" size={20} />} t={t} /></div>
    {catalogStatus === 'loading' && <div className={css['loading']} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={24} /></div>}
    {catalogStatus === 'error' && <div className={css['notice']} role="alert"><span>{t(catalogError === 'CATALOG_UPDATE_REQUIRED' ? 'subscriptionCatalogUpgrade' : 'subscriptionErrorUnavailable')}</span>
      <Button variant="ghost" size="sm" onClick={() => { void loadCatalog() }}>{t('retry')}</Button></div>}
    {catalog !== null && <>
      <form id={`${id}-form`} className={css['modelForm']} onSubmit={event => {
        event.preventDefault()
        if (kind === 'image' && editing === null) stageImage()
        else if (editing !== null) void saveAll()
      }}>
        <div className={css['modelKindRow']}><span className={css['modelLabel']}>{t('subscriptionModelKind')}</span>
          <SegmentedTabs variant="underline" className={css['modelKindTabs']} label={t('subscriptionModelKind')} value={kind} onChange={chooseKind} items={[
            { value: 'text', label: t('subscriptionTextModel'), id: `${id}-text`, panelId: `${id}-fields`, disabled: busy },
            { value: 'image', label: t('subscriptionImageModel'), id: `${id}-image`, panelId: `${id}-fields`, disabled: busy },
          ]} />
        </div>
        <div id={`${id}-fields`} role="tabpanel" aria-labelledby={`${id}-${kind}`} className={`${css['modelFields']} ${kind === 'text' && editing === null ? css['modelBatchFields'] : ''}`}>
          <div className={css['modelField']}><label htmlFor={`${id}-model`}>{t('subscriptionModelId')}</label>
            {kind === 'text' ? <Menu open={modelOpen} portal autoFocus minWidthFromAnchor listClassName={css['modelPickerMenu']} selectedId={editing === null ? undefined : modelId}
              selectedIds={editing === null ? selectedText.map(entry => entry.id) : undefined} onClose={() => { setModelOpen(false) }}
              items={catalog.candidates.map(model => ({ id: model.id, label: <span className={css['modelPickerLabel']}><strong>{model.name}</strong><code>{model.id}</code></span>,
                disabled: busy || !ready || !validId(model.id) || catalog.entries.some(entry => entry.kind === 'text' && entry.id === model.id && (editing === null || keyOf(entry) !== keyOf(editing)))
                  || editing !== null && pending.some(entry => entry.kind === 'text' && entry.id === model.id) }))}
              footer={editing === null ? [
                { id: '$all', label: t('subscriptionSelectAllModels'), disabled: busy || availableText.every(model => selectedText.some(entry => entry.id === model.id)) },
                { id: '$clear', label: t('subscriptionClearModels'), disabled: busy || selectedText.length === 0 },
                { id: '$done', label: t('subscriptionFinishSelection') },
              ] : []} onSelect={selectModel}
              anchor={<Button id={`${id}-model`} variant="outline" className={css['modelSelect']} disabled={busy || catalog.candidates.length === 0}
                aria-haspopup="menu" aria-expanded={modelOpen} onClick={() => { setModelOpen(value => !value) }}>
                <span className={css['modelSelection']}><IconCodeOutlineRegular size={16} /><span>{editing !== null ? candidate?.name ?? modelId
                  : selectedText.length > 0 ? t('subscriptionSelectedModels').replace('{count}', String(selectedText.length)) : t('subscriptionChooseModel')}</span></span>
                <IconChevronDownOutlineRegular size={16} /></Button>} />
              : <Input id={`${id}-model`} className={css['modelInput'] as string} icon={<IconCodeOutlineRegular size={16} />}
                value={modelId} maxLength={128} disabled={busy} spellCheck={false} onChange={event => { setModelId(event.target.value); setImageDirty(true) }} />}
            {kind === 'text' && editing !== null && candidate !== undefined && <code className={css['modelIdPreview']}>{candidate.id}</code>}
            {kind === 'text' && catalog.candidates.length === 0 && <p className={css['fieldHint']}>{t('subscriptionNoCandidates')}</p>}
          </div>
          {(kind === 'image' || editing !== null) && <div className={css['modelField']}><label htmlFor={`${id}-name`}>{t('subscriptionModelName')}</label>
            <Input id={`${id}-name`} className={css['modelInput'] as string} icon={<ProviderFieldIcon kind="name" />}
              value={name} maxLength={200} disabled={busy} onChange={event => { setName(event.target.value); setImageDirty(true) }} />
            {duplicate && <p className={css['fieldHint']} role="alert">{t('subscriptionModelDuplicate')}</p>}
          </div>}
          {kind === 'text' && editing !== null && <ModelCapabilities model={{ ...formEntry }} api="openai-codex-responses"
            reported={candidate?.nativeWebSearch} disabled={busy} t={t} onChange={model => {
              setNativeWebSearch(typeof model['nativeWebSearch'] === 'boolean' ? model['nativeWebSearch'] : undefined)
            }} />}
          {kind === 'image' && <div className={css['modelDefault']}><span>{t('subscriptionUseImageDefault')}</span>
            <Switch checked={makeDefault} label={t('subscriptionUseImageDefault')} disabled={busy} onChange={value => { setMakeDefault(value); setImageDirty(true) }} /></div>}
          {kind === 'image' && editing === null && <div className={css['modelQueueActions']}><Button type="submit" variant="outline" disabled={busy || !valid}
            icon={<IconPlusOutlineRegular size={16} />}>{t('subscriptionQueueModel')}</Button></div>}
        </div>
      </form>
      {pending.length > 0 && <section className={css['modelList']} aria-label={t('subscriptionPendingModels')}>
        <div className={css['modelListHeading']}><h3>{t('subscriptionPendingModels')} <span className={css['modelCount']}>{pending.length}</span></h3></div>
        {pendingConflict && <p className={css['fieldHint']} role="alert">{t('subscriptionModelDuplicate')}</p>}
        {renderModels(pending, true)}
      </section>}
      <section className={css['modelList']} aria-label={t('subscriptionConfiguredModels')}>
        <div className={css['modelListHeading']}><h3>{t('subscriptionConfiguredModels')} <span className={css['modelCount']}>{catalog.entries.length}</span></h3>
          <p className={css['fieldHint']}>{t('subscriptionDefaultImage').replace('{model}', catalog.defaultImageModel)}</p></div>
        {renderModels(catalog.entries, false)}
      </section>
    </>}
    </div>
  </Modal>
}
