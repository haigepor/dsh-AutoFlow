/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Model-adopted rule selection and pixel evidence share one bounded dialog. */
import type { StyleView, CuratorSnapshot, ModelProfileView } from './contract.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'
import { createDatasetProgress, datasetNotice } from './dataset-progress.tsx'
import { datasetActive } from './dataset-store.ts'
import { createProfileSaveQueue, type ProfileSaveState } from './profile-save-queue.ts'
import { datasetRoleCounts, type DatasetScope } from '../shared/datasets.ts'
import { isMatchingRule } from '../shared/reference-semantics.ts'
import { createGalleryMedia } from './gallery-media.tsx'

interface Props {
  open: boolean; onSearch?: (() => void) | undefined; onClose(): void; onAnalyze(): void; canAnalyze: boolean
  style: StyleView; snapshot: CuratorSnapshot; actions: WorkbenchProps['actions']; t: WorkbenchText; busy: boolean
  useDatasets: WorkbenchProps['useDatasets']
}

/** @param React Shell runtime. @param ui Existing shared primitives. @returns Stable profile dialog component. */
export function createStyleProfileDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Modal, Button, Checkbox, Tag, StateDot, TextArea, SegmentedTabs, DisclosureRow } = ui
  const DatasetProgress = createDatasetProgress(React, ui)
  const { GalleryLoadMore } = createGalleryMedia(React, ui)
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  type Option = ModelProfileView['options'][number]

  return function StyleProfileDialog({ open, onSearch, onClose, onAnalyze, canAnalyze, style, snapshot, actions, t, busy, useDatasets }: Props) {
    const datasets = useDatasets(value => value)
    const profile = style.modelProfile, analysis = style.analysis
    const [selectedId, setSelectedId] = React.useState(''), [mobileView, setMobileView] = React.useState<'rules' | 'evidence'>('rules')
    const [sampleScope, setSampleScope] = React.useState<Exclude<DatasetScope, 'observations'>>('all')
    const [rolePage, setRolePage] = React.useState({ key: '', limit: 0 })
    const [saveState, setSaveState] = React.useState<ProfileSaveState>({ profileId: '', changes: [], saving: false, failed: false, error: undefined })
    const [intent, setIntent] = React.useState<'close' | 'search' | 'generate' | null>(null), [reconciling, setReconciling] = React.useState(false), [readError, setReadError] = React.useState(false), [retryAfterRead, setRetryAfterRead] = React.useState(false)
    const [error, setError] = React.useState(''), [editing, setEditing] = React.useState<{ analysisRunId: string; ruleId: string; value: string } | null>(null)
    const [sections, setSections] = React.useState<string[]>([])
    const alive = React.useRef(true)
    const queue = React.useRef<ReturnType<typeof createProfileSaveQueue> | null>(null), latestActions = React.useRef(actions), actionPending = React.useRef(false), readVersion = React.useRef(0)
    latestActions.current = actions
    const saveContext = React.useRef({ styleId: style.styleId, analysisRunId: profile?.analysisRunId ?? '', profileId: profile?.id ?? '' })
    saveContext.current = { styleId: style.styleId, analysisRunId: profile?.analysisRunId ?? '', profileId: profile?.id ?? '' }
    const evidencePane = React.useRef<HTMLElement>(null), rulesPane = React.useRef<HTMLElement>(null), focusEvidence = React.useRef(false)
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    React.useEffect(() => {
      const owned = createProfileSaveQueue({ changed: setSaveState, save: async input => {
        const value = await latestActions.current.execute('profile-save', { ...input, changes: input.changes.map(change => ({ ...change })) })
        if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('invalid-profile-save-response')
        return { id: value.id }
      } })
      queue.current = owned; owned.sync(saveContext.current)
      return () => { if (queue.current === owned) queue.current = null; owned.dispose() }
    }, [])
    React.useEffect(() => { queue.current?.sync(saveContext.current) }, [style.styleId, profile?.analysisRunId, profile?.id, saveState.failed])
    const reconcile = async () => {
      const version = ++readVersion.current, styleId = style.styleId
      setReconciling(true); setReadError(false)
      const current = () => alive.current && version === readVersion.current && saveContext.current.styleId === styleId
      try { await actions.reconcileProfile(styleId) }
      catch (failure) { if (current()) setReadError(true) }
      finally { if (current()) setReconciling(false) }
    }
    React.useEffect(() => { if (open) void reconcile(); return () => { ++readVersion.current } }, [open, style.styleId, profile?.analysisRunId, analysis?.runId, analysis?.status])
    React.useEffect(() => {
      if (!open || !retryAfterRead || reconciling || readError) return
      setRetryAfterRead(false); queue.current?.sync(saveContext.current); void queue.current?.flush()
    }, [open, retryAfterRead, reconciling, readError, profile?.id])
    React.useEffect(() => { setSelectedId(''); setMobileView('rules'); setEditing(null); setError(''); setSections([]) }, [style.styleId, style.analysis?.runId])
    React.useEffect(() => {
      if (focusEvidence.current && mobileView === 'evidence' && window.matchMedia('(max-width: 760px)').matches) evidencePane.current?.focus()
      focusEvidence.current = false
    }, [selectedId, mobileView])
    React.useEffect(() => {
      const media = window.matchMedia('(max-width: 760px)')
      const retainFocus = () => {
        if (media.matches && rulesPane.current?.contains(document.activeElement)) setMobileView('rules')
        else if (media.matches && evidencePane.current?.contains(document.activeElement)) setMobileView('evidence')
        else if (!media.matches && document.activeElement?.closest('.vc-profile-mobile-tabs')) (mobileView === 'evidence' ? evidencePane : rulesPane).current?.focus()
      }
      media.addEventListener('change', retainFocus)
      return () => { media.removeEventListener('change', retainFocus) }
    }, [mobileView])
    const uid = React.useId()
    if (!open) return null
    const summary = profile?.summary ?? analysis?.summary
    const pending = new Map(saveState.changes.map(change => [change.ruleId, change]))
    const options = (profile?.options ?? []).map(option => { const change = pending.get(option.rule.ruleId); return change ? { ...option, enabled: change.enabled, rule: { ...option.rule, statement: change.statement ?? option.rule.statement } } : option }), active = options.filter(option => option.enabled && isMatchingRule(option.rule))
    const selected = options.find(option => option.rule.ruleId === selectedId) ?? active.find(option => option.groupId === null) ?? active[0] ?? options[0]
    const selectedGroup = profile?.groups.find(group => group.groupId === selected?.groupId)
    const samples = profile?.samples ?? analysis?.samples ?? []
    const evidence = selected ? samples.filter(sample => selected.rule.supportRefs.includes(sample.referenceId) || selected.rule.counterRefs.includes(sample.referenceId) || selected.rule.notApplicableRefs?.includes(sample.referenceId)) : []
    const roleKey = JSON.stringify([style.styleId, profile?.analysisRunId ?? analysis?.runId, sampleScope]), rolePageSize = snapshot.configuration.limits.pageSize
    const roleSamples = sampleScope === 'all' ? [] : samples.filter(sample => sample.role === sampleScope)
    const roleLimit = rolePage.key === roleKey ? rolePage.limit : rolePageSize, visibleRoleSamples = roleSamples.slice(0, roleLimit)
    const moreRoleSamples = () => setRolePage({ key: roleKey, limit: roleLimit + rolePageSize })
    const roleCounts = datasetRoleCounts(samples), exportCount = sampleScope === 'all' ? samples.length : roleCounts[sampleScope]
    const notice = datasetNotice(datasets, style.styleId, profile?.id, sampleScope)
    const preparing = notice.submission ? notice.submission.status !== 'unknown' : !!notice.entry && datasetActive(notice.entry.status)
    const latestExport = datasets.entries.filter(item => item.modelProfileId === profile?.id && item.sampleScope === sampleScope && item.downloadPath).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? snapshot.exports.filter(item => item.modelProfileId === profile?.id && (item.sampleScope ?? 'all') === sampleScope).at(-1)
    const saving = saveState.saving || saveState.changes.length > 0 && !saveState.failed
    const reading = reconciling || style.evidenceLoaded === false
    const disabled = busy || preparing || reading || readError || !!intent || !!profile?.stale
    const saveError = saveState.failed ? t(saveState.error && typeof saveState.error === 'object' && 'code' in saveState.error && saveState.error.code === 'revision-conflict' ? 'profileChanged' : 'profileSaveError') : ''
    const searchReady = !!profile && !profile.stale && active.length > 0
    const ready = !!profile && !profile.stale && exportCount > 0 && (sampleScope !== 'all' || active.length > 0)
    const panelIds = { rules: `${uid}-rules`, evidence: `${uid}-evidence` }
    const tabs = [{ value: 'rules' as const, label: t('organizedRules'), id: `${uid}-rules-tab`, panelId: panelIds.rules }, { value: 'evidence' as const, label: t('ruleEvidence'), id: `${uid}-evidence-tab`, panelId: panelIds.evidence }] as const
    const toggleSection = (name: string) => setSections(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name])
    const reason = (option: Option) => pending.has(option.rule.ruleId) ? t('profileUnsaved') : t(({ consistent: 'profileConsistent', conditional: 'profileConditional', 'reference-only': 'profileReference', 'counter-evidence': 'profileCounter', 'no-evidence': 'profileNoEvidence', 'subject-only': 'profileSubject', 'user-choice': 'profileUserChoice', 'evidence-changed': 'profileEvidenceChanged' } as const)[option.reason])
    const finish = async (next: 'close' | 'search' | 'generate', apply: (profileId: string) => void | Promise<void>) => {
      if (actionPending.current || readError && next !== 'close') return
      actionPending.current = true; setIntent(next); setError('')
      let profileId: string | undefined
      try { if (await queue.current?.flush() && alive.current && queue.current) profileId = queue.current.getSnapshot().profileId }
      finally { actionPending.current = false; if (alive.current) setIntent(null) }
      if (profileId !== undefined) await apply(profileId)
    }
    const temporarilyClose = () => { setRetryAfterRead(false); setEditing(null); onClose() }
    const closeDialog = () => { if (saveState.failed || readError) temporarilyClose(); else void finish('close', temporarilyClose) }
    const retry = () => {
      if (readError || saveState.error && typeof saveState.error === 'object' && 'code' in saveState.error && saveState.error.code === 'revision-conflict') {
        setRetryAfterRead(saveState.failed); void reconcile()
      } else void queue.current?.flush()
    }
    const save = (option: Option, enabled: boolean, statement?: string) => {
      if (!profile || disabled || statement !== undefined && !statement.trim()) return
      if (statement !== undefined && editing?.analysisRunId !== profile.analysisRunId) { setError(t('profileChanged')); return }
      setError(''); queue.current?.change({ ruleId: option.rule.ruleId, enabled, ...(statement === undefined ? {} : { statement: statement.trim() }) })
      if (statement !== undefined) setEditing(null)
    }
    const generate = async () => {
      if (!profile || !ready || disabled || editing) return
      setError('')
      await finish('generate', id => actions.datasets.start({ id, styleId: style.styleId, sampleScope }))
    }
    const pick = (option: Option) => { focusEvidence.current = true; setSelectedId(option.rule.ruleId); setMobileView('evidence'); setEditing(null) }
    const selectScope = (scope: Exclude<DatasetScope, 'observations'>) => {
      if (scope === sampleScope) return
      setSampleScope(scope); setMobileView('evidence')
      evidencePane.current?.scrollTo({ top: 0 })
    }
    const renderSample = (sample: ModelProfileView['samples'][number], rule?: Option) => {
      const image = sample.image ?? snapshot.images.find(image => image.referenceId === sample.referenceId)
      const relevant = rule ? sample.observations.filter(row => row.dimension.toLowerCase().includes(rule.rule.dimension) || row.dimension.includes(t(rule.rule.dimension))) : sample.observations
      const counter = rule?.rule.counterRefs.includes(sample.referenceId)
      const notApplicable = rule?.rule.notApplicableRefs?.includes(sample.referenceId)
      return <article className="vc-profile-evidence-item" key={sample.referenceId}>
        {image && <a href={resource(image.previewPath)} target="_blank" rel="noreferrer"><img src={resource(image.previewPath)} alt={image.name} loading="lazy" decoding="async" /></a>}
        <div className="vc-profile-evidence-caption"><strong>{image?.name ?? sample.referenceId}</strong><Tag tone={rule ? counter ? 'warning' : 'neutral' : sample.role === 'negative' ? 'warning' : 'info'}>{t(rule ? notApplicable ? 'datasetNotApplicable' : counter ? 'counterEvidence' : 'supportEvidence' : sample.role)}</Tag></div>
        {(relevant.length ? relevant : sample.observations.slice(0, 2)).map((row, index) => <p key={index}>{row.uncertain && <Tag tone="warning">{t('uncertain')}</Tag>}{row.description}</p>)}
      </article>
    }
    const renderRule = (option: Option) => <article className="vc-profile-rule" key={option.rule.ruleId} data-selected={selected?.rule.ruleId === option.rule.ruleId} data-enabled={option.enabled}>
      <Checkbox className="vc-profile-check" checked={option.enabled} disabled={disabled || !!editing || !option.rule.confirmed && !option.rule.supportRefs.length && !option.rule.counterRefs.length} label={`${t('enableRule')}: ${t(option.rule.dimension)} · ${option.rule.statement}`} onChange={enabled => save(option, enabled)} />
      <Button variant="ghost" className="vc-profile-rule-button" aria-pressed={selected?.rule.ruleId === option.rule.ruleId} onClick={() => pick(option)}><span className="vc-profile-rule-meta"><strong>{t(option.rule.dimension)}</strong><span>{t(option.rule.strength)}</span>{!option.enabled && <Tag>{t('referenceRules')}</Tag>}{option.selectionSource === 'user' && <Tag>{t('userAdjusted')}</Tag>}</span><span className="vc-profile-rule-statement">{option.rule.statement}</span><small>{t('positiveEvidence')} {option.rule.supportRefs.length}</small></Button>
    </article>
    const renderActive = () => [{ groupId: null, name: t('sharedRules') }, ...(profile?.groups ?? []).map((group, index) => ({ groupId: group.groupId, name: group.name || `${t('styleGroup')} ${index + 1}` }))].map(group => {
      const rows = options.filter(option => option.groupId === group.groupId)
      return rows.length ? <section className="vc-profile-rule-group" key={group.groupId ?? 'shared'}><h3>{group.name}<small>{rows.length}</small></h3>{rows.map(renderRule)}</section> : null
    })
    return <Modal open={open} onClose={closeDialog} title={t('styleProfile')} description={t('autoProfileHint')} closeLabel={t('close')} className="vc-dataset-modal vc-profile-dialog" contentClassName="vc-dataset-frame"
      footer={<div className="vc-profile-footer"><div className="vc-profile-save-state" role="status">{saving || preparing || reading ? <StateDot state="ongoing" /> : profile ? <StateDot state={profile.stale || editing || saveState.failed || readError ? 'warning' : 'done'} /> : null}<span>{t(reading ? 'datasetProfileReading' : saving ? 'profileSaving' : preparing ? 'datasetPreparing' : saveState.failed || editing ? 'profileUnsaved' : profile?.stale ? 'needsAnalysis' : profile ? 'autoSaved' : 'profilePending')}</span>{profile && <small>{t('enabledRules')} {active.length} / {options.filter(option => isMatchingRule(option.rule)).length}</small>}{latestExport?.downloadPath && <a href={resource(latestExport.downloadPath)} download>{t('downloadDataset')}</a>}</div><div className="vc-dataset-actions">{onSearch && <Button variant="primary" disabled={!searchReady || disabled || !!editing} onClick={() => { void finish('search', () => onSearch()) }}>{t('newTask')}</Button>}<Button variant="outline" disabled={!!intent} onClick={closeDialog}>{t('close')}</Button><Button variant="primary" disabled={!ready || disabled || !!editing} onClick={() => { void generate() }}>{t(preparing ? 'datasetPreparing' : notice.submission?.status === 'unknown' ? 'datasetRetryAck' : 'createDataset')}</Button></div></div>}>
      <div className="vc-profile-export-frame" aria-busy={preparing || undefined}>
      <div className="vc-profile-workspace" data-mobile-view={mobileView} ref={node => { if (node) node.inert = preparing }} aria-hidden={preparing || undefined}>
        <SegmentedTabs className="vc-profile-mobile-tabs" label={t('styleProfile')} items={tabs} value={mobileView} onChange={value => { setMobileView(value); setEditing(null) }} />
        <section className="vc-profile-export-options" aria-label={t('datasetExportScope')}>
          <div className="vc-row"><strong>{t('datasetExportScope')}</strong><Tag>{t(sampleScope === 'all' ? 'datasetStylePackage' : 'datasetObservationPackage')}</Tag></div>
          <div className="vc-dataset-role-filter" role="group" aria-label={t('datasetExportScope')}>{(['all', 'positive', 'negative'] as const).map(scope => <Button key={scope} size="sm" variant={sampleScope === scope ? 'outline' : 'ghost'} aria-pressed={sampleScope === scope} disabled={disabled || !!editing} onClick={() => selectScope(scope)}>{t(scope === 'all' ? 'datasetScopeAll' : scope === 'positive' ? 'datasetScopePositive' : 'datasetScopeNegative')} · {scope === 'all' ? samples.length : roleCounts[scope]}</Button>)}</div>
          <p role={reading ? 'status' : undefined}>{t(reading ? 'datasetProfileReadingHint' : !exportCount ? 'datasetNoRoleSamples' : sampleScope !== 'all' ? 'datasetObservationsHint' : !active.length ? 'datasetNeedsRules' : 'datasetCompleteHint')}</p>
        </section>
        {(error || saveError || readError) && <div className="vc-notice" role="alert"><p>{readError ? t('profileReadError') : error || saveError}</p>{(saveState.failed || readError) && <div className="vc-dataset-actions"><Button size="sm" variant="outline" disabled={!!intent || reconciling} onClick={retry}>{t('retry')}</Button><Button size="sm" variant="ghost" onClick={temporarilyClose}>{t('profileDiscardClose')}</Button></div>}{saveState.failed && <p>{t('profileCloseUnconfirmedHint')}</p>}</div>}
        {notice.submission?.status === 'unknown' && <DatasetProgress {...notice} t={t} onRetry={() => { void generate() }} />}
        {notice.entry?.error && !preparing && <p className="vc-notice" role="alert">{t('profileExportError')} · {notice.entry.error.code}</p>}
        {profile && analysis?.status === 'failed' && analysis.runId !== profile.analysisRunId && <p className="vc-notice" role="alert">{t('profilePreviousShown')}</p>}
        {profile?.stale && <p className="vc-notice" role="alert">{t('analysisStale')}</p>}
        <div className="vc-profile-columns">
          <section ref={rulesPane} tabIndex={-1} className="vc-profile-rules" id={panelIds.rules} aria-label={t('organizedRules')}>
            <div className="vc-profile-pane-heading"><h3>{t('organizedRules')}</h3><Tag>{t('autoSelected')}</Tag></div>
            {options.length ? renderActive() : <p className="vc-profile-placeholder">{t('profilePending')}</p>}
          </section>
          <section ref={evidencePane} tabIndex={-1} className="vc-profile-evidence" id={panelIds.evidence} aria-label={t('ruleEvidence')}>
            <div className="vc-profile-pane-heading"><h3>{t('ruleEvidence')}</h3><Button variant="ghost" size="sm" disabled={!canAnalyze || disabled} onClick={onAnalyze}><ui.IconRefreshOutlineRegular size={14} />{t('reanalyze')}</Button></div>
            {sampleScope !== 'all' ? <div className="vc-profile-evidence-content">
              <div className="vc-row"><Tag tone={sampleScope === 'negative' ? 'warning' : 'info'}>{t(sampleScope)}</Tag><strong>{t('sampleObservations')}</strong><small>{t('visibleImages')} {visibleRoleSamples.length} / {roleSamples.length}</small></div>
              <div className="vc-profile-evidence-grid">{visibleRoleSamples.map(sample => renderSample(sample))}</div>
              {!roleSamples.length && <p>{t('datasetNoRoleSamples')}</p>}
              <GalleryLoadMore hasMore={visibleRoleSamples.length < roleSamples.length} loading={false} disabled={!open || preparing} version={`${roleKey}:${visibleRoleSamples.length}`} onLoad={moreRoleSamples} label={t('galleryLoading')} kind="photos" showSkeleton={false} />
              {visibleRoleSamples.length < roleSamples.length && <Button variant="outline" onClick={moreRoleSamples}>{t('more')} · {visibleRoleSamples.length} / {roleSamples.length}</Button>}
            </div> : selected ? <div className="vc-profile-evidence-content" key={selected.rule.ruleId}>
              <div className="vc-row"><Tag tone="info">{t(selected.rule.dimension)}</Tag>{selectedGroup && <Tag>{selectedGroup.name || t('styleGroup')}</Tag>}<Tag>{t(selected.selectionSource === 'user' ? 'userAdjusted' : selected.selectionSource === 'human-rule' ? 'humanRule' : 'modelSelected')}</Tag></div>
              {editing?.ruleId === selected.rule.ruleId ? <div className="vc-stack"><TextArea aria-label={t('statement')} value={editing.value} disabled={disabled} onChange={event => setEditing({ ...editing, value: event.target.value })} /><div className="vc-dataset-actions"><Button size="sm" variant="ghost" disabled={!!intent} onClick={() => setEditing(null)}>{t('cancel')}</Button><Button size="sm" variant="outline" disabled={disabled || !editing.value.trim()} onClick={() => save(selected, selected.enabled, editing.value)}>{t('saveAdjustment')}</Button></div></div>
                : <><h4>{selected.rule.statement}</h4><div className="vc-profile-reason"><p>{reason(selected)}</p><Button variant="ghost" size="sm" disabled={disabled || !profile} onClick={() => { if (profile) setEditing({ analysisRunId: profile.analysisRunId, ruleId: selected.rule.ruleId, value: selected.rule.statement }) }}>{t('adjustRule')}</Button></div></>}
              {!!selected.rule.condition && <p className="vc-profile-condition">{selected.rule.condition}</p>}
              <div className="vc-profile-evidence-grid">{evidence.map(sample => renderSample(sample, selected))}</div>
              {!evidence.length && <p>{t('profileNoEvidence')}</p>}
            </div> : <p className="vc-profile-placeholder">{t('selectRuleEvidence')}</p>}
            {sampleScope === 'all' && summary && <div className="vc-profile-secondary">
              <DisclosureRow icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('profileOverview')} open={sections.includes('overview')} expandable expandOnRowClick onToggle={() => toggleSection('overview')}><div className="vc-stack"><h4>{summary.name}</h4><p>{summary.summary}</p>{summary.conflicts.map((conflict, index) => <p className="vc-profile-condition" key={index}>{conflict.description}</p>)}</div></DisclosureRow>
              <DisclosureRow icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('matchingPrompt')} open={sections.includes('prompt')} expandable expandOnRowClick onToggle={() => toggleSection('prompt')}><div className="vc-stack"><p className="vc-matching-prompt">{summary.matchingPrompt}</p><div className="vc-row">{summary.searchHints.map(hint => <Tag key={hint}>{hint}</Tag>)}</div></div></DisclosureRow>
            </div>}
          </section>
        </div>
      </div>
      {preparing && <div className="vc-dataset-generating-overlay"><DatasetProgress {...notice} t={t} readError={datasets.error} overlay /></div>}
      </div>
    </Modal>
  }
}
