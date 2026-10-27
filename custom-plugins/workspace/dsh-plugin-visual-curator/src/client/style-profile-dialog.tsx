/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Model-adopted rule selection and pixel evidence share one bounded dialog. */
import type { StyleView, CuratorSnapshot, ModelProfileView } from './contract.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { resultId } from './workbench-actions.ts'
import { safeResourcePath } from './store.ts'

interface Props {
  open: boolean; onSearch?: (() => void) | undefined; onClose(): void; onAnalyze(): void; canAnalyze: boolean
  style: StyleView; snapshot: CuratorSnapshot; actions: WorkbenchProps['actions']; t: WorkbenchText; busy: boolean
}

/** @param React Shell runtime. @param ui Existing shared primitives. @returns Stable profile dialog component. */
export function createStyleProfileDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Modal, Button, Checkbox, Tag, StateDot, TextArea, SegmentedTabs, DisclosureRow } = ui
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  type Option = ModelProfileView['options'][number]

  return function StyleProfileDialog({ open, onSearch, onClose, onAnalyze, canAnalyze, style, snapshot, actions, t, busy }: Props) {
    const [selectedId, setSelectedId] = React.useState(''), [mobileView, setMobileView] = React.useState<'rules' | 'evidence'>('rules')
    const [saving, setSaving] = React.useState(false), [launching, setLaunching] = React.useState(false), [exportRun, setExportRun] = React.useState('')
    const [pending, setPending] = React.useState<{ profileId: string; ruleId: string; enabled: boolean; statement?: string } | null>(null)
    const [error, setError] = React.useState(''), [editing, setEditing] = React.useState<{ profileId: string; ruleId: string; value: string } | null>(null)
    const [sections, setSections] = React.useState<string[]>([])
    const alive = React.useRef(true)
    const evidencePane = React.useRef<HTMLElement>(null), rulesPane = React.useRef<HTMLElement>(null), focusEvidence = React.useRef(false)
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    React.useEffect(() => { setSelectedId(''); setMobileView('rules'); setEditing(null); setError(''); setSections([]); setExportRun('') }, [style.styleId, style.analysis?.runId])
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
    const profile = style.modelProfile, analysis = style.analysis
    const summary = profile?.summary ?? analysis?.summary
    const options = (profile?.options ?? []).map(option => pending?.profileId === profile?.id && pending?.ruleId === option.rule.ruleId ? { ...option, enabled: pending.enabled, rule: { ...option.rule, statement: pending.statement ?? option.rule.statement } } : option), active = options.filter(option => option.enabled)
    const selected = options.find(option => option.rule.ruleId === selectedId) ?? active.find(option => option.groupId === null) ?? active[0] ?? options[0]
    const selectedGroup = profile?.groups.find(group => group.groupId === selected?.groupId)
    const samples = profile?.samples ?? analysis?.samples ?? []
    const evidence = selected ? samples.filter(sample => selected.rule.supportRefs.includes(sample.referenceId) || selected.rule.counterRefs.includes(sample.referenceId)) : []
    const exportState = snapshot.runs.find(run => run.runId === exportRun)
    const preparing = launching || !!exportState && !['completed', 'failed', 'cancelled'].includes(exportState.status)
    const latestExport = snapshot.exports.filter(item => item.modelProfileId === profile?.id).at(-1)
    const disabled = busy || saving || preparing || !!profile?.stale
    const ready = !!profile && !profile.stale && active.length > 0
    const uid = React.useId()
    const panelIds = { rules: `${uid}-rules`, evidence: `${uid}-evidence` }
    const tabs = [{ value: 'rules' as const, label: t('organizedRules'), id: `${uid}-rules-tab`, panelId: panelIds.rules }, { value: 'evidence' as const, label: t('ruleEvidence'), id: `${uid}-evidence-tab`, panelId: panelIds.evidence }] as const
    const toggleSection = (name: string) => setSections(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name])
    const reason = (option: Option) => t(({ consistent: 'profileConsistent', conditional: 'profileConditional', 'reference-only': 'profileReference', 'counter-evidence': 'profileCounter', 'no-evidence': 'profileNoEvidence', 'subject-only': 'profileSubject', 'user-choice': 'profileUserChoice', 'evidence-changed': 'profileEvidenceChanged' } as const)[option.reason])
    const closeDialog = () => { if (!saving && !launching) { setEditing(null); onClose() } }
    const save = async (option: Option, enabled: boolean, statement?: string) => {
      if (!profile || disabled || statement !== undefined && !statement.trim()) return
      if (statement !== undefined && editing?.profileId !== profile.id) { setError(t('profileChanged')); return }
      setSaving(true); setError('')
      setPending({ profileId: profile.id, ruleId: option.rule.ruleId, enabled, ...(statement === undefined ? {} : { statement: statement.trim() }) })
      try {
        await actions.execute('profile-save', { operationId: crypto.randomUUID(), styleId: style.styleId, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: option.rule.ruleId, enabled, ...(statement === undefined ? {} : { statement: statement.trim() }) }] })
        if (alive.current) setEditing(null)
      } catch (failure) { if (alive.current) setError(t(failure && typeof failure === 'object' && 'code' in failure && failure.code === 'revision-conflict' ? 'profileChanged' : 'profileSaveError')) }
      finally { if (alive.current) { setSaving(false); setPending(null) } }
    }
    const generate = async () => {
      if (!profile || !ready || disabled || editing) return
      setLaunching(true); setError('')
      try {
        const runId = resultId(await actions.execute('export-start', { operationId: crypto.randomUUID(), kind: 'style', purpose: 'reference', releaseId: profile.id, mode: 'references-only' }), 'runId')
        if (alive.current) { setExportRun(runId); actions.selectRun(runId) }
      } catch (failure) { if (alive.current) setError(t('profileExportError')) }
      finally { if (alive.current) setLaunching(false) }
    }
    const pick = (option: Option) => { focusEvidence.current = true; setSelectedId(option.rule.ruleId); setMobileView('evidence'); setEditing(null) }
    const renderRule = (option: Option) => <article className="vc-profile-rule" key={option.rule.ruleId} data-selected={selected?.rule.ruleId === option.rule.ruleId} data-enabled={option.enabled}>
      <Checkbox className="vc-profile-check" checked={option.enabled} disabled={disabled || !!editing || !option.rule.confirmed && !option.rule.supportRefs.length} label={`${t('enableRule')}: ${t(option.rule.dimension)} · ${option.rule.statement}`} onChange={enabled => { void save(option, enabled) }} />
      <Button variant="ghost" className="vc-profile-rule-button" aria-pressed={selected?.rule.ruleId === option.rule.ruleId} onClick={() => pick(option)}><span className="vc-profile-rule-meta"><strong>{t(option.rule.dimension)}</strong><span>{t(option.rule.strength)}</span>{!option.enabled && <Tag>{t('referenceRules')}</Tag>}{option.selectionSource === 'user' && <Tag>{t('userAdjusted')}</Tag>}</span><span className="vc-profile-rule-statement">{option.rule.statement}</span><small>{t('positiveEvidence')} {option.rule.supportRefs.length}</small></Button>
    </article>
    const renderActive = () => [{ groupId: null, name: t('sharedRules') }, ...(profile?.groups ?? []).map((group, index) => ({ groupId: group.groupId, name: group.name || `${t('styleGroup')} ${index + 1}` }))].map(group => {
      const rows = options.filter(option => option.groupId === group.groupId)
      return rows.length ? <section className="vc-profile-rule-group" key={group.groupId ?? 'shared'}><h3>{group.name}<small>{rows.length}</small></h3>{rows.map(renderRule)}</section> : null
    })
    return <Modal open={open} onClose={closeDialog} title={t('styleProfile')} description={t('autoProfileHint')} closeLabel={t('close')} className="vc-dataset-modal vc-profile-dialog" contentClassName="vc-dataset-frame"
      footer={<div className="vc-profile-footer"><div className="vc-profile-save-state" role="status">{saving || preparing ? <StateDot state="ongoing" /> : profile ? <StateDot state={profile.stale || editing ? 'warning' : 'done'} /> : null}<span>{t(saving ? 'profileSaving' : preparing ? 'datasetPreparing' : editing ? 'profileUnsaved' : profile?.stale ? 'needsAnalysis' : profile ? 'autoSaved' : 'profilePending')}</span>{profile && <small>{t('enabledRules')} {active.length} / {options.length}</small>}{latestExport?.downloadPath && <a href={resource(latestExport.downloadPath)} download>{t('downloadDataset')}</a>}</div><div className="vc-dataset-actions">{onSearch && <Button variant="primary" disabled={!ready || disabled || !!editing} onClick={onSearch}>{t('newTask')}</Button>}<Button variant="outline" disabled={saving || launching} onClick={closeDialog}>{t('close')}</Button><Button variant="primary" disabled={!ready || disabled || !!editing} onClick={() => { void generate() }}>{t(preparing ? 'datasetPreparing' : 'createDataset')}</Button></div></div>}>
      <div className="vc-profile-workspace" data-mobile-view={mobileView}>
        <SegmentedTabs className="vc-profile-mobile-tabs" label={t('styleProfile')} items={tabs} value={mobileView} onChange={value => { setMobileView(value); setEditing(null) }} />
        {(error || exportState?.error) && <p className="vc-notice" role="alert">{error || t('profileExportError')}</p>}
        {profile && analysis?.status === 'failed' && analysis.runId !== profile.analysisRunId && <p className="vc-notice" role="alert">{t('profilePreviousShown')}</p>}
        {profile?.stale && <p className="vc-notice" role="alert">{t('analysisStale')}</p>}
        <div className="vc-profile-columns">
          <section ref={rulesPane} tabIndex={-1} className="vc-profile-rules" id={panelIds.rules} aria-label={t('organizedRules')}>
            <div className="vc-profile-pane-heading"><h3>{t('organizedRules')}</h3><Tag>{t('autoSelected')}</Tag></div>
            {options.length ? renderActive() : <p className="vc-profile-placeholder">{t('profilePending')}</p>}
          </section>
          <section ref={evidencePane} tabIndex={-1} className="vc-profile-evidence" id={panelIds.evidence} aria-label={t('ruleEvidence')}>
            <div className="vc-profile-pane-heading"><h3>{t('ruleEvidence')}</h3><Button variant="ghost" size="sm" disabled={!canAnalyze || disabled} onClick={onAnalyze}><ui.IconRefreshOutlineRegular size={14} />{t('reanalyze')}</Button></div>
            {selected ? <div className="vc-profile-evidence-content" key={selected.rule.ruleId}>
              <div className="vc-row"><Tag tone="info">{t(selected.rule.dimension)}</Tag>{selectedGroup && <Tag>{selectedGroup.name || t('styleGroup')}</Tag>}<Tag>{t(selected.selectionSource === 'user' ? 'userAdjusted' : selected.selectionSource === 'human-rule' ? 'humanRule' : 'modelSelected')}</Tag></div>
              {editing?.ruleId === selected.rule.ruleId ? <div className="vc-stack"><TextArea aria-label={t('statement')} value={editing.value} disabled={saving} onChange={event => setEditing({ ...editing, value: event.target.value })} /><div className="vc-dataset-actions"><Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>{t('cancel')}</Button><Button size="sm" variant="outline" disabled={disabled || !editing.value.trim()} onClick={() => { void save(selected, selected.enabled, editing.value) }}>{t('saveAdjustment')}</Button></div></div>
                : <><h4>{selected.rule.statement}</h4><div className="vc-profile-reason"><p>{reason(selected)}</p><Button variant="ghost" size="sm" disabled={disabled || !profile} onClick={() => { if (profile) setEditing({ profileId: profile.id, ruleId: selected.rule.ruleId, value: selected.rule.statement }) }}>{t('adjustRule')}</Button></div></>}
              {!!selected.rule.condition && <p className="vc-profile-condition">{selected.rule.condition}</p>}
              <div className="vc-profile-evidence-grid">{evidence.map(sample => {
                const image = sample.image ?? snapshot.images.find(image => image.referenceId === sample.referenceId)
                const relevant = sample.observations.filter(row => row.dimension.toLowerCase().includes(selected.rule.dimension) || row.dimension.includes(t(selected.rule.dimension)))
                return <article className="vc-profile-evidence-item" key={sample.referenceId}>
                  {image && <a href={resource(image.previewPath)} target="_blank" rel="noreferrer"><img src={resource(image.previewPath)} alt={image.name} loading="lazy" decoding="async" /></a>}
                  <div className="vc-profile-evidence-caption"><strong>{image?.name ?? sample.referenceId}</strong><Tag tone={selected.rule.counterRefs.includes(sample.referenceId) ? 'warning' : 'neutral'}>{t(selected.rule.counterRefs.includes(sample.referenceId) ? 'counterEvidence' : 'supportEvidence')}</Tag></div>
                  {(relevant.length ? relevant : sample.observations.slice(0, 2)).map((row, index) => <p key={index}>{row.uncertain && <Tag tone="warning">{t('uncertain')}</Tag>}{row.description}</p>)}
                </article>
              })}</div>
              {!evidence.length && <p>{t('profileNoEvidence')}</p>}
            </div> : <p className="vc-profile-placeholder">{t('selectRuleEvidence')}</p>}
            {summary && <div className="vc-profile-secondary">
              <DisclosureRow icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('profileOverview')} open={sections.includes('overview')} expandable expandOnRowClick onToggle={() => toggleSection('overview')}><div className="vc-stack"><h4>{summary.name}</h4><p>{summary.summary}</p>{summary.conflicts.map((conflict, index) => <p className="vc-profile-condition" key={index}>{conflict.description}</p>)}</div></DisclosureRow>
              <DisclosureRow icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('matchingPrompt')} open={sections.includes('prompt')} expandable expandOnRowClick onToggle={() => toggleSection('prompt')}><div className="vc-stack"><p className="vc-matching-prompt">{summary.matchingPrompt}</p><div className="vc-row">{summary.searchHints.map(hint => <Tag key={hint}>{hint}</Tag>)}</div></div></DisclosureRow>
            </div>}
          </section>
        </div>
      </div>
    </Modal>
  }
}
