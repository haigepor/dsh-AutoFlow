/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Collection datasets use tabular rows and lazily read frozen package details. */
import type { WorkbenchProps } from './workbench.tsx'
import type { ModelProfileView } from './contract.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { datasetActive } from './dataset-store.ts'
import { safeResourcePath } from './store.ts'
import { createSelectField } from './select-field.tsx'
import { createDatasetSampleList, type DatasetSampleLayout } from './dataset-sample-list.tsx'
import { createGalleryMedia } from './gallery-media.tsx'
import type { DatasetEntry } from '../shared/datasets.ts'

/** @param React Host runtime. @param ui Existing DSH primitives. @returns Dataset table, frozen details and confirmed package removal. */
export function createDatasetWorkspace(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Input, Modal, Tag, SegmentedTabs, StateDot, CodeBlock, FileTypeIcon } = ui
  const SelectField = createSelectField(React, ui), DatasetSampleList = createDatasetSampleList(React, ui)
  const { GalleryLoadMore } = createGalleryMedia(React, ui)
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`

  const packageLabel = (scope: DatasetEntry['sampleScope']) => scope === 'all' ? 'datasetStylePackage' : scope === 'observations' ? 'datasetObservationPackage' : scope === 'positive' ? 'datasetPositivePackage' : 'datasetNegativePackage'

  function VersionChanges({ entry, t }: { entry: DatasetEntry; t: WorkbenchText }) {
    const changes = entry.changes
    if (!changes) return null
    return <div className="vc-dataset-version-change"><span>{t('datasetComparedWith')} v{changes.previousRevision}</span>{changes.notesOnly ? <span>{t('datasetNotesOnly')}</span> : <>
      {changes.positiveAdded > 0 && <span className="vc-dataset-change-chip">{t('datasetPositiveLabel')} +{changes.positiveAdded}</span>}
      {changes.negativeAdded > 0 && <span className="vc-dataset-change-chip">{t('datasetNegativeLabel')} +{changes.negativeAdded}</span>}
      {changes.removed > 0 && <span className="vc-dataset-change-chip">{t('datasetRemoved')} {changes.removed}</span>}
      {(changes.rulesAdded > 0 || changes.rulesRemoved > 0) && <span className="vc-dataset-change-chip">{t('datasetRulesLabel')} +{changes.rulesAdded} / −{changes.rulesRemoved}</span>}
      {!changes.positiveAdded && !changes.negativeAdded && !changes.removed && !changes.rulesAdded && !changes.rulesRemoved && <span>{t('datasetReorganized')}</span>}
    </>}</div>
  }

  function Detail({ useDatasets, actions, t, onDelete, deleting, onClose = actions.datasets.closeDetail, onBack }: Pick<WorkbenchProps, 'useDatasets' | 'actions' | 't'> & { onDelete(entry: DatasetEntry): void; deleting: boolean; onClose?: () => void; onBack?: () => void }) {
    const state = useDatasets(value => value), detail = state.detail
    const entry = state.entries.find(row => row.id === state.detailId) ?? detail?.entry
    const [tab, setTab] = React.useState<'overview' | 'rules' | 'samples' | 'files'>('overview'), [allRules, setAllRules] = React.useState(false), [selectedFile, setSelectedFile] = React.useState('')
    const scrollRef = React.useRef<HTMLDivElement>(null), offsets = React.useRef(new Map<string, number>())
    const sampleLayouts = React.useRef(new Map<string, DatasetSampleLayout>())
    const scrollKey = JSON.stringify([state.detailId, tab, tab === 'samples' ? state.sampleRole : null])
    React.useLayoutEffect(() => { setTab('overview'); setAllRules(false); setSelectedFile(''); offsets.current.clear(); sampleLayouts.current.clear() }, [state.detailId])
    React.useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = offsets.current.get(scrollKey) ?? 0 }, [scrollKey, !!detail])
    const file = detail?.files.find(item => item.name === selectedFile) ?? detail?.files[0]
    const uid = React.useId()
    const item = <T extends string>(value: T, label: string) => ({ value, label, id: `${uid}-${value}-tab`, panelId: `${uid}-${value}` })
    const items = [item('overview', t('datasetOverview')), item('rules', t('rules')), item('samples', t('sampleObservations')), item('files', t('datasetFiles'))] as const

    return <Modal open={!!state.detailId} onClose={onClose} title={t('datasetDetails')} description={entry ? `${entry.name} · v${entry.profileRevision}` : t('datasetReferencePackage')} closeLabel={t('close')} className="vc-dataset-detail" contentClassName="vc-dataset-detail-content"
      footer={<div className="vc-dataset-detail-footer">{onBack && <Button variant="ghost" onClick={onBack}><ui.IconChevronLeftOutlineRegular size={16} />{t('datasetBackToList')}</Button>}<div className="vc-dataset-actions">{entry?.downloadPath && <a className="vc-dataset-download" href={resource(entry.downloadPath)} download><ui.IconDownloadOutlineRegular size={16} />{t('downloadDataset')}</a>}{entry && <Button variant="ghost" className="vc-dataset-delete" disabled={deleting || datasetActive(entry.status)} onClick={() => { actions.datasets.closeDetail(); onDelete(entry) }}><ui.IconTrashOutlineRegular size={16} />{t('deleteDataset')}</Button>}<Button variant="outline" onClick={onClose}>{t('close')}</Button></div></div>}>
      <SegmentedTabs variant="underline" label={t('datasetDetails')} items={items} value={tab} onChange={setTab} />
      {tab === 'samples' && entry && <div className="vc-dataset-role-filter" role="group" aria-label={t('filterRole')}>{(['all', 'positive', 'negative', 'undecided'] as const).filter(role => role !== 'undecided' || entry.counts.undecided > 0).map(role => <Button key={role} size="sm" variant={state.sampleRole === role ? 'outline' : 'ghost'} aria-pressed={state.sampleRole === role} onClick={() => { void actions.datasets.filterSamples(role) }}>{t(role === 'all' ? 'allReferenceTypes' : role)} · {role === 'all' ? entry.counts.references : entry.counts[role]}</Button>)}</div>}
      {state.detailError && <div className="vc-notice" role="alert">{t('datasetReadError')}<Button size="sm" onClick={() => { if (tab === 'samples' && detail?.nextSamplePageToken) void actions.datasets.moreSamples(); else void actions.datasets.open(state.detailId) }}>{t('retry')}</Button></div>}
      {!detail && state.detailLoading ? <div className="vc-dataset-read-skeleton" aria-label={t('galleryLoading')} aria-busy="true">{[0, 1, 2, 3].map(value => <span key={value} className="vc-skeleton-fill" />)}</div> : detail && <div ref={scrollRef} onScroll={event => { offsets.current.set(scrollKey, event.currentTarget.scrollTop) }} className="vc-dataset-detail-scroll" aria-busy={state.detailLoading || undefined} data-files={tab === 'files' || undefined} id={`${uid}-${tab}`} role="tabpanel" aria-labelledby={`${uid}-${tab}-tab`}>
        {tab === 'overview' && <div className="vc-stack"><div className="vc-row"><Tag tone="info">{t(entry?.sampleScope === 'all' ? 'datasetFormatHint' : 'datasetObservationPackage')}</Tag><Tag tone={entry?.status === 'completed' ? 'success' : 'neutral'}>{entry && t(entry.status)}</Tag></div>
          {entry && <div className="vc-row"><Tag>{t('positive')} {entry.counts.positive}</Tag><Tag tone="warning">{t('negative')} {entry.counts.negative}</Tag>{entry.counts.undecided > 0 && <Tag>{t('undecided')} {entry.counts.undecided}</Tag>}</div>}
          {entry?.sampleScope !== 'all' && <p className="vc-dataset-note">{t('datasetObservationsHint')}</p>}
          {entry && <dl className="vc-dataset-facts"><div><dt>{t('datasetSamples')}</dt><dd>{entry.counts.references}</dd></div><div><dt>{t('datasetRules')}</dt><dd>{entry.counts.rules} / {entry.counts.candidates}</dd></div><div><dt>{t('datasetReferenceNotes')}</dt><dd>{entry.counts.referenceNotes ?? 0}</dd></div><div><dt>{t('datasetRequiredReview')}</dt><dd>{entry.counts.unconfirmedRequired ?? 0}</dd></div><div><dt>{t('datasetGroups')}</dt><dd>{entry.counts.enabledGroups} / {entry.counts.groups}</dd></div><div><dt>{t('datasetFiles')}</dt><dd>{entry.counts.files}</dd></div><div><dt>{t('datasetVersion')}</dt><dd>v{entry.profileRevision}</dd></div><div><dt>{t('datasetAnalysisModel')}</dt><dd>{entry.model}</dd></div></dl>}
          {!!entry?.duplicateExports?.length && <details className="vc-dataset-prompt"><summary>{t('datasetSameContent')} · {entry.duplicateExports.length}</summary>{entry.duplicateExports.map(copy => <p key={copy.id}><code>{copy.exportId}</code> · <time dateTime={copy.createdAt}>{new Date(copy.createdAt).toLocaleString()}</time></p>)}</details>}
          {detail.summary && <section><h3>{t('profileOverview')}</h3><p>{detail.summary}</p></section>}
          <p>{t('datasetFileHint')}</p><p className="vc-dataset-note">{t('datasetValidationHint')}</p>
          <dl className="vc-dataset-facts"><div><dt>{t('datasetRemoteReferences')}</dt><dd>{detail.resources.remote} / {detail.resources.total}</dd></div><div><dt>{t('datasetPixelDigests')}</dt><dd>{detail.resources.pixelDigests}</dd></div><div><dt>{t('datasetHumanAccepts')}</dt><dd>{detail.resources.humanAccepts}</dd></div></dl>
          {detail.matchingPrompt && <details className="vc-dataset-prompt"><summary>{t('matchingPrompt')}</summary><p className="vc-dataset-note">{t('datasetPromptHint')}</p><p>{detail.matchingPrompt}</p></details>}
        </div>}
        {tab === 'rules' && <div className="vc-stack"><div className="vc-dataset-rule-filter" role="group" aria-label={t('rules')}><Button size="sm" variant="ghost" aria-pressed={!allRules} onClick={() => setAllRules(false)}>{t('datasetSelectedRules')} · {detail.rules.filter(rule => rule.enabled && rule.strength !== 'reference-only').length}</Button><Button size="sm" variant="ghost" aria-pressed={allRules} onClick={() => setAllRules(true)}>{t('datasetAllRules')} · {detail.rules.length}</Button></div>
          {[{ id: null, name: t('sharedRules'), imageCount: detail.sampleTotal }, ...detail.groups].map(group => {
            const rules = detail.rules.filter(rule => rule.groupId === group.id && (allRules || rule.enabled && rule.strength !== 'reference-only'))
            return !!rules.length && <section className="vc-dataset-rule-section" key={group.id ?? 'shared'}><h3>{group.name}<small>{group.imageCount} · {t('datasetSamples')}{group.id && group.imageCount === 1 ? ` · ${t('datasetSingleExample')}` : ''}</small></h3>{rules.map(rule => <article className="vc-dataset-saved-rule" key={rule.id} data-enabled={rule.enabled}><div className="vc-row"><strong>{t(rule.dimension)}</strong><Tag tone={rule.enabled && rule.strength !== 'reference-only' ? 'info' : 'neutral'}>{t(rule.strength === 'reference-only' ? 'datasetReferenceNotes' : rule.enabled ? 'enabledRules' : 'referenceRules')}</Tag><Tag>{t(rule.confirmed ? 'datasetConfirmed' : 'datasetSuggested')}</Tag></div><p>{rule.statement}</p>{rule.condition && <p className="vc-dataset-note">{t('datasetCondition')} · {rule.condition}</p>}<small>{t('datasetEvidenceCount')} {rule.supportCount} · {t('datasetCounterCount')} {rule.counterCount ?? 0} · {t('datasetNotApplicable')} {rule.notApplicableCount ?? 0}</small></article>)}</section>
          })}
        </div>}
        {tab === 'samples' && <div className="vc-stack">{!detail.samples.length && <p className="vc-dataset-note">{t('datasetNoRoleObservations')}</p>}<DatasetSampleList key={scrollKey} detail={detail} scrollRef={scrollRef} restoreOffset={() => offsets.current.get(scrollKey) ?? 0} layout={sampleLayouts.current.get(scrollKey)} onLayout={value => { sampleLayouts.current.set(scrollKey, value) }} t={t} /><GalleryLoadMore hasMore={!!detail.nextSamplePageToken} loading={state.detailLoading} disabled={state.detailError} version={detail.nextSamplePageToken ?? detail.entry.id} onLoad={() => { void actions.datasets.moreSamples() }} label={t('galleryLoading')} kind="photos" showSkeleton={false} />{detail.nextSamplePageToken && <Button variant="outline" disabled={state.detailLoading} onClick={() => { void actions.datasets.moreSamples() }}>{state.detailLoading ? <StateDot state="ongoing" /> : null}{t('more')} · {detail.samples.length} / {detail.sampleTotal}</Button>}</div>}
        {tab === 'files' && <div className="vc-dataset-files">
          <nav className="vc-dataset-file-list" aria-label={t('datasetFiles')}>
            <div className="vc-dataset-file-list-heading"><span>{t('datasetFiles')}</span><small>{detail.files.length}</small></div>
            {detail.files.map(item => <Button key={item.name} variant="ghost" className="vc-dataset-file-item" aria-pressed={file?.name === item.name} aria-controls={`${uid}-file-preview`} onClick={() => setSelectedFile(item.name)}>
              <FileTypeIcon path={item.name} size={18} /><span className="vc-dataset-file-label"><span>{item.name}</span><small>{size(item.bytes)}</small></span><StateDot state={item.verified ? 'done' : 'warning'} />
            </Button>)}
          </nav>
          {file ? <section className="vc-dataset-file-reader" id={`${uid}-file-preview`} aria-label={file.name}>
            <header className="vc-dataset-file-heading"><div className="vc-dataset-file-title"><FileTypeIcon path={file.name} size={20} /><strong>{file.name}</strong></div><div className="vc-dataset-file-meta"><span>{size(file.bytes)}</span><Tag tone={file.verified ? 'success' : 'warning'}>{t(file.verified ? 'datasetFileVerified' : 'datasetFileUnchecked')}</Tag></div></header>
            <div className="vc-dataset-file-switcher"><SelectField label={t('datasetFiles')} value={file.name} options={detail.files.map(item => ({ value: item.name, label: `${item.name} · ${size(item.bytes)}` }))} onChange={setSelectedFile} /></div>
            <div className="vc-dataset-file-info"><p className="vc-dataset-note">{t('datasetValidationHint')}</p><details className="vc-dataset-file-checksum"><summary>{t('datasetFileChecksum')}</summary><code>{file.checksum}</code></details></div>
            {file.truncated && <p className="vc-dataset-file-truncated" role="note"><StateDot state="warning" />{t('datasetPreviewTruncated')}</p>}
            <CodeBlock key={file.name} className="vc-dataset-file-code" code={file.preview} lang={ui.languageForPath(file.name)} lineNumbers copyLabel={t('datasetCopyPreview')} copiedLabel={t('datasetPreviewCopied')} toolbarLabels={{ codeLabel: t('datasetCode'), wrapLabel: t('datasetCodeWrap'), unwrapLabel: t('datasetCodeUnwrap') }} />
          </section> : <div className="vc-empty">{t('datasetFilesEmpty')}</div>}
        </div>}
      </div>}
    </Modal>
  }

  return function DatasetWorkspace({ useDatasets, actions, t, onGenerate, canGenerate, currentProfile, onOrganize, canOrganize, dialog }: Pick<WorkbenchProps, 'useDatasets' | 'actions' | 't'> & { onGenerate(): void; canGenerate: boolean; currentProfile?: ModelProfileView | undefined; onOrganize?: (() => void) | undefined; canOrganize?: boolean | undefined; dialog?: { onClose(): void } }) {
    const state = useDatasets(value => value)
    const [showHistory, setShowHistory] = React.useState(false)
    const [deleteTarget, setDeleteTarget] = React.useState<DatasetEntry | null>(null), [deleting, setDeleting] = React.useState(false), [deleteError, setDeleteError] = React.useState(false)
    const listScroll = React.useRef<HTMLDivElement>(null), listOffset = React.useRef({ top: 0, left: 0 })
    const deletionVersion = React.useRef(0)
    React.useEffect(() => {
      ++deletionVersion.current; setDeleteTarget(null); setDeleting(false); setDeleteError(false)
      return () => { ++deletionVersion.current }
    }, [state.styleId])
    const requestDelete = (entry: DatasetEntry) => { setDeleteTarget(entry); setDeleteError(false) }
    const closeDelete = () => { if (!deleting) setDeleteTarget(null) }
    const confirmDelete = async () => {
      if (!deleteTarget || deleting) return
      const version = ++deletionVersion.current
      setDeleting(true); setDeleteError(false)
      try {
        await actions.datasets.remove(deleteTarget.id)
        if (version === deletionVersion.current) setDeleteTarget(null)
      } catch (error) {
        // 失败或回执丢失时保留确认对象，重试由 store 复用同一删除操作 ID。
        if (version === deletionVersion.current) setDeleteError(true)
      } finally { if (version === deletionVersion.current) setDeleting(false) }
    }
    React.useEffect(() => setShowHistory(false), [state.styleId])
    const loaded = state.pageIds.flatMap(id => { const row = state.entries.find(entry => entry.id === id); return row ? [row] : [] })
    const versions = new Map<string, typeof loaded>()
    for (const entry of loaded) { const saved = versions.get(entry.modelProfileId) ?? []; saved.push(entry); versions.set(entry.modelProfileId, saved) }
    const primaryId = currentProfile && versions.has(currentProfile.id) ? currentProfile.id : loaded.find(entry => entry.isFinal)?.modelProfileId ?? loaded[0]?.modelProfileId
    const rows = [...versions.values()].map(entries => entries.find(entry => entry.sampleScope === 'all') ?? entries[0]!).filter(entry => showHistory || state.query || state.status !== 'all' || entry.modelProfileId === primaryId || entry.status !== 'completed')
    const pending = state.submissions.filter(item => item.styleId === state.styleId)
    const listKey = JSON.stringify([state.styleId, state.query, state.status, showHistory]), previousListKey = React.useRef(listKey)
    React.useLayoutEffect(() => {
      if (previousListKey.current !== listKey) { previousListKey.current = listKey; listOffset.current = { top: 0, left: 0 } }
      if (listScroll.current) { listScroll.current.scrollTop = listOffset.current.top; listScroll.current.scrollLeft = listOffset.current.left }
    }, [listKey, state.detailId, !!deleteTarget, rows.length])
    const closeDialog = () => { actions.datasets.closeDetail(); dialog?.onClose() }
    const list = <section className="vc-datasets-workspace" aria-label={t('datasets')}>
      <header className="vc-datasets-heading"><div>{dialog ? <div className="vc-datasets-context">{currentProfile ? <><span>{t('datasetCurrentVersion')}</span><Tag>v{currentProfile.revision}</Tag></> : <span>{t('datasetReferencePackage')}</span>}</div> : <h2>{t('datasets')} <span className="vc-count" aria-label={t('datasetVersions')}>{state.versionTotal ?? versions.size}</span></h2>}<p>{t('datasetAutoHint')}</p></div><div className="vc-dataset-actions"><Button variant="outline" disabled={!canGenerate} onClick={onGenerate}>{t('openProfile')}</Button>{onOrganize && <Button variant="primary" disabled={!canOrganize} onClick={onOrganize}><ui.IconSparkleRegular size={16} />{t('datasetOrganize')}</Button>}</div></header>
      {(state.versionTotal ?? versions.size) > 1 && <div className="vc-row"><Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}>{t(showHistory ? 'datasetHideHistory' : 'datasetShowHistory')} · {state.versionTotal ?? versions.size}</Button></div>}
      {currentProfile && !currentProfile.stale && rows.length > 0 && rows.every(row => row.modelProfileId !== currentProfile.id || row.sampleScope !== 'all' || row.status !== 'completed') && !state.query && state.status === 'all' && !state.nextPageToken && <div className="vc-dataset-version-notice" role="status"><span><strong>{t('datasetCurrentVersion')} v{currentProfile.revision}</strong><span>{t('datasetNewerProfile')}</span></span><Button size="sm" variant="outline" onClick={onGenerate}>{t('createDataset')}</Button></div>}
      <div className="vc-datasets-surface">
      <div className="vc-datasets-toolbar">
        <Input className="vc-datasets-search" icon={<ui.IconSearchOutlineRegular size={16} />} aria-label={t('datasetSearch')} placeholder={t('datasetSearch')} value={state.query} maxLength={200} onChange={event => actions.datasets.filter(event.target.value, state.status)} />
        <SelectField label={t('fileStatus')} value={state.status} options={[{ value: 'all', label: t('datasetAllStatuses') }, { value: 'active', label: t('datasetActiveFilter') }, { value: 'completed', label: t('completed') }, { value: 'failed', label: t('datasetFailedFilter') }]} onChange={value => { if (value === 'all' || value === 'active' || value === 'completed' || value === 'failed') actions.datasets.filter(state.query, value) }} />
        <Button className="vc-datasets-refresh" variant="ghost" aria-label={t('refresh')} disabled={state.loading} onClick={() => { void actions.datasets.refresh() }}>{state.loading ? <StateDot state="ongoing" /> : <ui.IconRefreshOutlineRegular size={16} />}<span>{t('refresh')}</span></Button>
      </div>
      {state.error && <p className="vc-notice" role="alert">{t('datasetLoadError')}</p>}
      {!rows.length && state.loading ? <div className="vc-dataset-read-skeleton" aria-label={t('galleryLoading')} aria-busy="true">{[0, 1, 2].map(value => <span key={value} className="vc-skeleton-fill" />)}</div> : rows.length || pending.length ? <div ref={listScroll} className="vc-datasets-table-scroll" tabIndex={0} role="region" aria-label={t('datasets')} onScroll={event => { listOffset.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft } }}><table className="vc-datasets-table">
        <caption className="vc-sr-only">{t('datasets')}</caption>
        <colgroup><col className="vc-datasets-column-package" /><col className="vc-datasets-column-content" /><col className="vc-datasets-column-time" /><col className="vc-datasets-column-status" /><col className="vc-datasets-column-actions" /></colgroup>
        <thead><tr>{(['datasetReferencePackage', 'datasetCoverage', 'datasetCreatedAt', 'fileStatus', 'datasetActions'] as const).map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead>
        <tbody>
          {pending.map(item => <tr key={item.operationId} data-dataset-pending>
            <th scope="row"><span className="vc-dataset-pending-name">{t('datasetPreparing')}</span><small className="vc-dataset-package-kind">{t(item.sampleScope === 'all' ? 'datasetScopeAll' : item.sampleScope === 'observations' ? 'datasetObservationPackage' : item.sampleScope === 'positive' ? 'datasetScopePositive' : 'datasetScopeNegative')}</small></th>
            <td>—</td><td>—</td>
            <td><span className="vc-dataset-row-state"><StateDot state={item.status === 'unknown' ? 'warning' : 'ongoing'} />{t(item.status === 'unknown' ? 'datasetAckUnknown' : 'datasetSubmitting')}</span></td>
            <td><div className="vc-dataset-table-actions"><Button size="sm" variant="outline" onClick={() => { if (item.status === 'unknown') void actions.datasets.start({ id: item.profileId, styleId: item.styleId, sampleScope: item.sampleScope }); else onGenerate() }}>{t(item.status === 'unknown' ? 'datasetRetryAck' : 'openProfile')}</Button></div></td>
          </tr>)}
          {rows.map(entry => <tr key={entry.id} data-dataset-row={entry.id}>
            <th scope="row"><div className="vc-dataset-title"><Button className="vc-dataset-name" variant="ghost" onClick={() => { void actions.datasets.open(entry.id) }}>{entry.name}</Button><Tag>v{entry.profileRevision}</Tag>{entry.isFinal && <Tag tone={entry.stale ? 'info' : 'success'}>{t(entry.stale ? 'datasetPreviousFinal' : 'datasetFinal')}</Tag>}</div>
              <VersionChanges entry={entry} t={t} />
              {!!entry.duplicateExports?.length && <small className="vc-dataset-copy-count">{t('datasetSameContent')} · {entry.duplicateExports.length}</small>}
            </th>
            <td><div className="vc-dataset-coverage">
              <div className="vc-dataset-coverage-heading"><span className="vc-dataset-image-count" aria-label={t('datasetSamples')}><strong>{entry.counts.references}</strong><span>{t('datasetImagesUnit')}</span></span><span className="vc-dataset-package-kind">{t(packageLabel(entry.sampleScope))}</span>{entry.byteLength !== undefined && <small className="vc-dataset-file-size">{size(entry.byteLength)}</small>}</div>
              <div className="vc-dataset-role-counts">{(['positive', 'negative', 'undecided'] as const).filter(role => role !== 'undecided' || entry.counts.undecided > 0).map(role => <span key={role} data-role={role} data-empty={!entry.counts[role] || undefined}><span>{t(role === 'positive' ? 'datasetPositiveLabel' : role === 'negative' ? 'datasetNegativeLabel' : 'undecided')}</span><b>{entry.counts[role]}</b></span>)}</div>
              {entry.sampleScope === 'all' ? <div className="vc-dataset-rule-counts"><span>{t('datasetMatchingRules')} <b>{entry.counts.rules}</b><small>/ {entry.counts.candidates}</small></span>{entry.counts.groups > 0 && <span>{t('datasetStyleGroups')} <b>{entry.counts.enabledGroups}</b><small>/ {entry.counts.groups}</small></span>}{!!entry.counts.referenceNotes && <span>{t('datasetReferenceNotes')} <b>{entry.counts.referenceNotes}</b></span>}{!!entry.counts.unconfirmedRequired && <span>{t('datasetRequiredReview')} <b>{entry.counts.unconfirmedRequired}</b></span>}</div> : <p className="vc-dataset-observation-hint">{t('datasetObservationHint')}</p>}
            </div></td>
            <td><time className="vc-dataset-created" dateTime={entry.createdAt}><span>{new Date(entry.createdAt).toLocaleDateString()}</span><small>{new Date(entry.createdAt).toLocaleTimeString()}</small></time></td>
            <td><Tag tone={entry.status === 'completed' ? 'success' : datasetActive(entry.status) ? 'info' : 'warning'}><span className="vc-dataset-row-state"><StateDot state={entry.status === 'completed' ? 'done' : datasetActive(entry.status) ? 'ongoing' : 'warning'} />{t(entry.status)}</span></Tag>{datasetActive(entry.status) && entry.progress && entry.progress.total > 0 && <small className="vc-dataset-row-progress">{entry.progress.completed} / {entry.progress.total}</small>}</td>
            <td><div className="vc-dataset-table-actions" role="group" aria-label={t('datasetActions')}>
              <Button size="sm" variant="outline" onClick={() => { void actions.datasets.open(entry.id) }}>{t('fileDetails')}</Button>
              {entry.downloadPath && <a className="vc-dataset-download vc-dataset-row-download" href={resource(entry.downloadPath)} download aria-label={`${t('downloadDataset')} · ${entry.name} v${entry.profileRevision}`}><ui.IconDownloadOutlineRegular size={16} />{t('downloadDataset')}</a>}
              <ui.Tooltip portal label={t(datasetActive(entry.status) ? 'datasetDeleteActive' : 'deleteDataset')}><Button size="sm" variant="ghost" className="vc-dataset-delete vc-dataset-delete-icon" disabled={deleting || datasetActive(entry.status)} aria-label={`${t('deleteDataset')} · ${entry.name} v${entry.profileRevision}`} onClick={() => requestDelete(entry)}><ui.IconTrashOutlineRegular size={16} /></Button></ui.Tooltip>
              {(versions.get(entry.modelProfileId)?.length ?? 0) > 1 && <details className="vc-dataset-export-options"><summary>{t('datasetExportScope')}</summary>{versions.get(entry.modelProfileId)!.filter(other => other.id !== entry.id).map(other => <Button key={other.id} size="sm" variant="ghost" onClick={() => { void actions.datasets.open(other.id) }}>{t(packageLabel(other.sampleScope))} · {other.counts.references}</Button>)}</details>}
            </div></td>
          </tr>)}
        </tbody>
      </table></div> : <div className="vc-empty vc-datasets-empty"><ui.IconFolderOpenOutlineRegular size={30} /><h3>{t(state.allTotal ? 'datasetNoMatches' : 'datasetEmptyTitle')}</h3><p>{t(state.allTotal ? 'datasetListHint' : 'datasetEmptyHint')}</p>{state.allTotal ? <Button variant="outline" onClick={() => actions.datasets.filter('', 'all')}>{t('resetFilters')}</Button> : <Button variant="outline" disabled={!canGenerate} onClick={onGenerate}>{t('openProfile')}</Button>}</div>}
      {!dialog && state.nextPageToken && <Button className="vc-datasets-more" variant="outline" disabled={state.loading} onClick={() => { void actions.datasets.loadMore() }}>{state.loading && <StateDot state="ongoing" />}{t('more')} · {rows.length} / {state.total}</Button>}
      </div>
    </section>
    return <>
      {dialog ? <Modal open={!state.detailId && !deleteTarget} onClose={closeDialog} title={`${t('datasets')} · ${state.versionTotal ?? versions.size}`} closeLabel={t('close')} className="vc-canvas-data-modal" contentClassName="vc-canvas-data-content" footer={<div className="vc-datasets-dialog-footer"><div><small>{t('datasetShownCount').replace('{visible}', String(rows.length)).replace('{total}', String(state.total))}</small><small className="vc-datasets-scroll-hint">{t('datasetTableScrollHint')}</small></div><div className="vc-dataset-actions">{state.nextPageToken && <Button variant="outline" disabled={state.loading} onClick={() => { void actions.datasets.loadMore() }}>{state.loading && <StateDot state="ongoing" />}{t('more')}</Button>}<Button variant="outline" onClick={closeDialog}>{t('close')}</Button></div></div>}>{list}</Modal> : list}
      <Detail useDatasets={useDatasets} actions={actions} t={t} onDelete={requestDelete} deleting={deleting} {...(dialog ? { onClose: closeDialog, onBack: actions.datasets.closeDetail } : {})} />
      <Modal open={!!deleteTarget} onClose={closeDelete} title={t('datasetDeleteConfirm')} closeLabel={t('close')} className="vc-delete-modal vc-dataset-delete-modal"
        footer={<div className="vc-dataset-actions"><Button variant="outline" disabled={deleting} onClick={closeDelete}>{t('cancel')}</Button><Button variant="outline" className="vc-dataset-delete-confirm" disabled={deleting || !deleteTarget} onClick={() => { void confirmDelete() }}>{deleting ? <StateDot state="ongoing" /> : <ui.IconTrashOutlineRegular size={16} />}{t(deleting ? 'datasetDeleting' : 'deleteDataset')}</Button></div>}>
        {deleteTarget && <div className="vc-dataset-delete-target"><ui.IconFolderOpenOutlineRegular size={24} /><div><strong>{deleteTarget.name} · v{deleteTarget.profileRevision}</strong><span>{t(packageLabel(deleteTarget.sampleScope))} · {deleteTarget.counts.references} {t('datasetImagesUnit')}</span></div></div>}
        <p>{t('datasetDeleteHint')}</p><p className="vc-dataset-delete-note">{t('datasetDeletePreserve')}</p>
        {!!deleteTarget?.duplicateExports?.length && <p className="vc-dataset-delete-note">{t('datasetDeleteCopies')} · {deleteTarget.duplicateExports.length}</p>}
        {deleteError && <p className="vc-notice" role="alert">{t('datasetDeleteFailed')}</p>}
      </Modal>
    </>
  }
}
