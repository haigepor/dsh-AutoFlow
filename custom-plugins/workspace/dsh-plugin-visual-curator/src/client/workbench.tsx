/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Image preparation workspace composed with the Host's React and DSH primitives. */
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CuratorSnapshot, ConfigurationView, StyleView } from './contract.ts'
import type { ClientState, CuratorStore } from './store.ts'
import { safeResourcePath } from './store.ts'
import { importPickedReferences, type ImportRow } from './local-import.ts'
import { archiveCollections, dimensions, filterReferences, resultId } from './workbench-actions.ts'
import { createStyleProfileDialog } from './style-profile-dialog.tsx'
import { createGallerySettings } from './gallery-settings.tsx'
import { createGalleryReferenceDialog } from './gallery-reference-dialog.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { galleryTaskActive, type GalleryTaskView } from '../shared/gallery-task.ts'
import { createGalleryTaskStatus } from './gallery-task-status.tsx'
import { createGalleryMedia } from './gallery-media.tsx'
import { analysisActive } from '../shared/analysis-process.ts'
import { createAnalysisDialog } from './analysis-dialog.tsx'
import { createTaskHistory } from './task-history.tsx'

/** Narrow callbacks and an injected read hook keep Cordis outside the component tree. */
export interface WorkbenchProps extends PropsRenderFactories {
  useWorkbench<T>(select: (state: ClientState) => T): T
  t: WorkbenchText
  welcomeImage: string
  logoImage: string
  actions: Pick<CuratorStore, 'execute' | 'reload' | 'getSnapshot' | 'selectStyle' | 'selectRun' | 'loadMoreImages' | 'loadRun' | 'loadReferences' | 'startGalleryReferences' | 'stopGalleryReferences' | 'startAnalysis' | 'stopAnalysis' | 'openAnalysis' | 'closeAnalysis' | 'refreshAnalysisDetail' | 'loadAnalysisInput' | 'saveConfiguration'> & {
    publish(style: StyleView): Promise<string>
    saveCredential(ref: string, value: string): Promise<void>
    pickLocalReferences(kind: 'file' | 'folder' | 'references', signal: AbortSignal): Promise<unknown>
    listLocalReferences(path: string, kind: 'file' | 'folder', signal: AbortSignal): Promise<unknown>
    galleryRead(operation: string, args: import('./contract.ts').ActionArgs, signal: AbortSignal, options?: { refresh?: boolean }): Promise<unknown>
  }
}

/** Create stable components once per module factory, sharing the shell's React instance.
 * @param React Shell React runtime. @param ui Existing DSH primitive library. @returns Slot-ready workspace component.
 */
export function createWorkbench(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Input, TextArea, Tag, StateDot, Modal, Menu, SegmentedTabs, DisclosureRow, Checkbox } = ui
  const id = () => crypto.randomUUID()
  const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean)
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  const GallerySettings = createGallerySettings(React, ui)
  const GalleryTaskStatus = createGalleryTaskStatus(React, ui)
  const { GalleryLoadMore, GallerySkeleton } = createGalleryMedia(React, ui)
  const AnalysisDialog = createAnalysisDialog(React, ui)
  const TaskHistory = createTaskHistory(React, ui)

  function SelectField({ label, value, options, disabled = false, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; disabled?: boolean; onChange(value: string): void }) {
    const [open, setOpen] = React.useState(false)
    return <Menu className="vc-select" open={open} onClose={() => setOpen(false)} portal compact autoFocus selectedId={value}
      items={options.map(option => ({ id: option.value, label: option.label, disabled }))}
      onSelect={next => { setOpen(false); onChange(next) }}
      anchor={<Button className="vc-select-trigger" variant="outline" disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(current => !current)} onKeyDown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}>
        <span>{options.find(option => option.value === value)?.label ?? label}</span><ui.IconChevronDownOutlineRegular size={12} />
      </Button>} />
  }

  function CreateCollection({ name, onName, onSubmit, busy, error, t }: { name: string; onName(value: string): void; onSubmit(): void; busy: boolean; error: string; t: WorkbenchText }) {
    return <form className="vc-create-form" onSubmit={event => { event.preventDefault(); onSubmit() }}>
      <label>{t('name')}<Input required data-modal-autofocus placeholder={t('nameHint')} value={name} disabled={busy} onChange={event => onName(event.target.value)} /></label>
      <p>{t('collectionHint')}</p>
      {error && <p role="alert">{error}</p>}
      <Button variant="primary" className="vc-primary-action" type="submit" disabled={!name.trim() || busy}><ui.IconPlusOutlineRegular size={16} />{t(busy ? 'busy' : 'createCollectionAction')}</Button>
    </form>
  }

  function Configuration({ config, actions, t, report, styles, selectedStyleId, openWorkbench, initialPanel, saving, saveError }: { config: ConfigurationView; actions: WorkbenchProps['actions']; t: WorkbenchText; report(work: () => Promise<unknown>): void; styles: StyleView[]; selectedStyleId: string; openWorkbench(styleId: string): void; initialPanel: 'vision' | 'source'; saving: boolean; saveError: ClientState['configError'] }) {
    const [vision, setVision] = React.useState(config.vision)
    const [source, setSource] = React.useState(config.source)
    const [requestTimeoutMs, setRequestTimeoutMs] = React.useState(config.limits.requestTimeoutMs)
    const [maxRetryAttempts, setMaxRetryAttempts] = React.useState(config.limits.maxRetryAttempts)
    const [maxVisionOutputTokens, setMaxVisionOutputTokens] = React.useState(config.limits.maxVisionOutputTokens)
    const [reasoningEffort, setReasoningEffort] = React.useState(config.vision.reasoningEffort ?? '')
    const [visionKey, setVisionKey] = React.useState(''), [sourceKey, setSourceKey] = React.useState('')
    const [panel, setPanel] = React.useState<'vision' | 'source'>(initialPanel)
    const [connectionOpen, setConnectionOpen] = React.useState(false), [advancedOpen, setAdvancedOpen] = React.useState(false)
    const settingsId = React.useId()
    React.useEffect(() => { setSource(config.source) }, [config.revision])
    const save = async (kind: 'vision' | 'source' = 'vision') => {
      try {
        await actions.saveConfiguration({ revision: config.revision, vision: kind === 'vision' ? { ...vision, supportsStreaming: vision.supportsStreaming !== false, reasoningEffort: reasoningEffort || null } : {}, source: kind === 'source' ? { ...source } : {}, limits: kind === 'vision' ? { requestTimeoutMs, maxRetryAttempts, maxVisionOutputTokens } : {} }, async () => {
          if (kind === 'vision' && visionKey) { await actions.saveCredential(vision.credentialRef, visionKey); setVisionKey('') }
          if (kind === 'source' && sourceKey) { await actions.saveCredential(source.credentialRef, sourceKey); setSourceKey('') }
        })
        const saved = actions.getSnapshot().snapshot?.configuration; if (saved) { setVision(saved.vision); setSource(saved.source) }; if (kind === 'source') setAdvancedOpen(false)
      } catch (error) { /* 保存失败由共享配置状态显示，导航和其他任务继续可用。 */ }
    }
    return <><form className="vc-settings" onSubmit={event => { event.preventDefault(); save() }}>
      <SegmentedTabs className="vc-settings-tabs" label={t('settings')} value={panel} onChange={setPanel} items={[
        { value: 'vision', label: <span className="vc-settings-tab-label"><ui.IconSparkleRegular size={16} />{t('vision')}<StateDot state={config.visionConfigured ? 'done' : 'idle'} /></span>, id: `${settingsId}-vision-tab`, panelId: `${settingsId}-vision` },
        { value: 'source', label: <span className="vc-settings-tab-label"><ui.IconFolderOpenOutlineRegular size={16} />{t('gallery')}<StateDot state={config.sourceConfigured ? 'done' : 'idle'} /></span>, id: `${settingsId}-source-tab`, panelId: `${settingsId}-source` },
      ]} />
      {(['vision', 'source'] as const).map(value => <div key={value} id={`${settingsId}-${value}`} role="tabpanel" aria-labelledby={`${settingsId}-${value}-tab`} hidden={panel !== value}>{panel === value && <fieldset data-panel={value} className="vc-settings-panel vc-stack" disabled={saving}>
      {value === 'vision' ? <>
        <div className="vc-row"><h3>{t('vision')}</h3><Tag tone={config.visionConfigured ? 'success' : 'neutral'}>{t(config.visionConfigured ? 'configured' : 'unconfigured')}</Tag></div>
        <p>{t('visionHint')}</p>
        <label>{t('endpoint')}<Input type="url" placeholder="https://api.example.com/v1/chat/completions" value={vision.endpoint} onChange={event => setVision({ ...vision, endpoint: event.target.value })} /></label>
        <div className="vc-settings-fields">
          <label>{t('model')}<Input value={vision.model} onChange={event => setVision({ ...vision, model: event.target.value })} /></label>
          <label>{t('apiKey')}<Input type="password" autoComplete="new-password" value={visionKey} disabled={!vision.credentialRef} placeholder={t('keyHint')} onChange={event => setVisionKey(event.target.value)} /><small>{t(config.visionCredentialConfigured ? 'keySaved' : 'keyMissing')}</small></label>
        </div>
        <DisclosureRow className="vc-settings-advanced" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('connectionOptions')} open={connectionOpen} expandable expandOnRowClick onToggle={() => setConnectionOpen(value => !value)}><div className="vc-settings-fields">
          <label>{t('credentialRef')}<Input value={vision.credentialRef} pattern="[A-Za-z_][A-Za-z0-9_]*|" onChange={event => setVision({ ...vision, credentialRef: event.target.value })} /></label>
          <label>{t('localOrigin')}<Input type="url" value={vision.localOrigin} onChange={event => setVision({ ...vision, localOrigin: event.target.value })} /></label>
          <label>{t('requestTimeout')}<Input required type="number" min={1} step={1} value={requestTimeoutMs / 1000} onChange={event => setRequestTimeoutMs(Number(event.target.value) * 1000)} /></label>
          <label>{t('maxRetryAttempts')}<Input required type="number" min={0} max={5} step={1} value={maxRetryAttempts} onChange={event => setMaxRetryAttempts(Number(event.target.value))} /></label>
          <label>{t('maxVisionOutputTokens')}<Input required type="number" min={1} step={1} value={maxVisionOutputTokens} onChange={event => setMaxVisionOutputTokens(Number(event.target.value))} /></label>
          <label>{t('reasoningEffort')}<SelectField label={t('reasoningEffort')} value={reasoningEffort} options={[{ value: '', label: t('providerDefault') }, ...['none', 'low', 'medium', 'high', 'max'].map(value => ({ value, label: value }))]} onChange={setReasoningEffort} /><small>{t('reasoningHint')}</small></label>
          <div className="vc-stack"><Checkbox label={t('supportsStreaming')} checked={vision.supportsStreaming !== false} onChange={checked => setVision({ ...vision, supportsStreaming: checked })} /><small>{t('streamingHint')}</small></div>
          <p>{t('requestLimitsHint')}</p>
        </div></DisclosureRow>
      </> : <>
        <GallerySettings config={{ ...config, source }} actions={actions} t={t} styles={styles} selectedStyleId={selectedStyleId} openWorkbench={openWorkbench} openAdvanced={() => setAdvancedOpen(true)} saveSource={async next => {
          await actions.saveConfiguration({ revision: config.revision, source: { ...next }, vision: {}, limits: {} })
          setSource(actions.getSnapshot().snapshot?.configuration.source ?? next)
        }} />

      </>}
      </fieldset>}</div>)}
      {saveError && <p role="alert">{t('error')} · {saveError.safeMessage || saveError.code}</p>}
      {panel === 'vision' && <footer className="vc-settings-footer"><small>{t('configHint')}</small><Button variant="primary" className="vc-primary-action" type="submit" disabled={saving} aria-busy={saving}>{saving && <StateDot state="ongoing" />}{t(saving ? 'busy' : 'saveConfig')}</Button></footer>}
    </form>
    <Modal open={advancedOpen} onClose={() => { if (!saving) { setAdvancedOpen(false); setSource(config.source); setSourceKey('') } }} title={t('galleryCustomSource')} closeLabel={t('close')} className="vc-custom-source-modal" contentClassName="vc-custom-source-scroll" footer={<div className="vc-dataset-actions"><Button variant="outline" disabled={saving} onClick={() => { setAdvancedOpen(false); setSource(config.source); setSourceKey('') }}>{t('cancel')}</Button><Button variant="primary" type="submit" form={settingsId + '-source-form'} disabled={saving}>{t(saving ? 'busy' : 'saveConfig')}</Button></div>}>
      <form id={settingsId + '-source-form'} onSubmit={event => { event.preventDefault(); save('source') }}><fieldset className="vc-settings-modal-fields" disabled={saving}><div className="vc-stack">
          <p>{t('galleryHint')}</p>
          <label>{t('endpoint')}<Input type="url" value={source.endpoint} onChange={event => setSource({ ...source, endpoint: event.target.value, provider: 'generic' })} /></label>
          <div className="vc-settings-fields">
            <label>{t('gallerySourceId')}<Input value={source.id} onChange={event => setSource({ ...source, id: event.target.value })} /></label>
            <label>{t('credentialRef')}<Input value={source.credentialRef} pattern="[A-Za-z_][A-Za-z0-9_]*|" onChange={event => setSource({ ...source, credentialRef: event.target.value })} /></label>
            <label>{t('apiKey')}<Input type="password" autoComplete="new-password" value={sourceKey} disabled={!source.credentialRef} placeholder={t('keyHint')} onChange={event => setSourceKey(event.target.value)} /><small>{t(config.sourceCredentialConfigured ? 'keySaved' : 'keyMissing')}</small></label>
            <label>{t('method')}<SelectField label={t('method')} value={source.method} disabled={saving} options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} onChange={value => setSource({ ...source, method: value as 'GET' | 'POST' })} /></label>
            {(['queryField', 'cursorField', 'pageSizeField', 'itemsPointer', 'idPointer', 'previewPointer', 'originalPointer', 'widthPointer', 'heightPointer', 'nextCursorPointer'] as const).map(key => <label key={key}>{t(key)}<Input value={source[key]} onChange={event => setSource({ ...source, [key]: event.target.value })} /></label>)}
            <label>{t('allowedOrigins')}<TextArea value={source.allowedMediaOrigins.join('\n')} onChange={event => setSource({ ...source, allowedMediaOrigins: lines(event.target.value) })} /></label>
          </div>
          <Button variant="outline" disabled={source.provider === 'generic'} onClick={() => setSource({ ...source, provider: 'generic' })}>{t('galleryUseCustom')}</Button>
        </div></fieldset></form>
    </Modal></>
  }

  const DatasetDialog = createStyleProfileDialog(React, ui)
  const GalleryReferenceDialog = createGalleryReferenceDialog(React, ui)

  function StyleEditor({ style, snapshot, actions, t, report, busy, query, clearQuery, openGallerySettings, task, referencePage, pendingStart }: { pendingStart: boolean; style: StyleView; snapshot: CuratorSnapshot; actions: WorkbenchProps['actions']; t: WorkbenchText; report(work: () => Promise<unknown>): void; busy: boolean; query: string; clearQuery(): void; openGallerySettings(): void; task: GalleryTaskView | undefined; referencePage: ClientState['referencePages'][string] | undefined }) {
    const referencing = !!task && galleryTaskActive(task.status)
    const rules = style.modelProfile ? style.modelProfile.options.filter(option => option.enabled).map(option => option.rule) : style.rules
    const [role, setRole] = React.useState<'positive' | 'negative'>('positive')
    const [filter, setFilter] = React.useState<'all' | 'positive' | 'negative' | 'undecided'>('all')
    const [view, setView] = React.useState<'grid' | 'list'>('grid'), [dragging, setDragging] = React.useState(false)
    const [inspectorOpen, setInspectorOpen] = React.useState(false)
    const [datasetOpen, setDatasetOpen] = React.useState(false)
    const [galleryOpen, setGalleryOpen] = React.useState(false)
    const [analysisStarting, setAnalysisStarting] = React.useState(false)
    const [expandedGroups, setExpandedGroups] = React.useState<string[]>([])
    const inspectorId = React.useId()
    const inspectorToggle = React.useRef<HTMLButtonElement>(null)
    const processTrigger = React.useRef<HTMLButtonElement>(null)
    const importTrigger = React.useRef<HTMLButtonElement>(null)
    const [imports, setImports] = React.useState<ImportRow[]>([]), [importMenuOpen, setImportMenuOpen] = React.useState(false), [importPage, setImportPage] = React.useState(0)
    const [pickerError, setPickerError] = React.useState('')
    const [pathOpen, setPathOpen] = React.useState(false), [sourcePath, setSourcePath] = React.useState(''), [pathKind, setPathKind] = React.useState<'file' | 'folder'>('folder'), [pathError, setPathError] = React.useState('')
    const importLifetime = React.useRef(new AbortController())
    React.useEffect(() => () => { importLifetime.current.abort() }, [])
    const refs = filterReferences(snapshot.images, style, '', 'all')
    const roleCount = (value: typeof filter) => referencePage?.counts[value] ?? (value === 'all' ? refs.length : refs.filter(image => (image.role ?? 'undecided') === value).length)
    const visibleRefs = filterReferences(snapshot.images, style, query, filter)
    const importing = snapshot.configuration.limits
    const analysisDisabled = busy || referencing || !style.referenceIds.length || !snapshot.configuration.visionConfigured || snapshot.runs.some(run => run.kind === 'analyze' && run.styleId === style.styleId && analysisActive(run.status))
    const analysis = style.analysis
    const analyzing = !!analysis && ['created', 'running', 'pausing', 'cancelling'].includes(analysis.status)
    const analysisBusy = analysisStarting || pendingStart || analyzing
    const profileReady = !referencing && !analysisBusy && (!!style.modelProfile && !style.modelProfile.stale || !!analysis?.summary && analysis.status === 'completed' && !analysis.stale)
    const needsModel = !snapshot.configuration.visionConfigured && !profileReady
    const workflowSteps = [
      { label: 'stepImport', complete: style.referenceIds.length > 0 },
      { label: 'stepAnalyze', complete: profileReady },
      { label: 'stepReview', complete: !!style.modelProfile && !style.modelProfile.stale && rules.length > 0 },
      { label: 'stepExport', complete: !!analysis && snapshot.exports.some(item => item.modelProfileId === style.modelProfile?.id) },
    ] as const
    const currentStep = referencing ? workflowSteps[0] : workflowSteps.find(step => !step.complete) ?? workflowSteps[3]
    const analysisState = analysisBusy ? 'ongoing' : needsModel || analysis?.stale ? 'warning' : analysis?.status === 'failed' ? 'error' : analysis?.summary ? 'done' : 'idle'
    const analysisLabel = analysisBusy ? t(!analysisStarting && analysis && analysis.observed === analysis.total && analysis.total > 0 ? 'summarizingStyle' : 'analyzingImages') : needsModel ? t('modelNeeded') : analysis?.stale ? t('needsAnalysis')
      : analysis?.status === 'completed' && analysis.summary ? t('analysisFinished') : analysis ? t(analysis.outcome === 'budget-exhausted' ? 'budgetExhausted' : analysis.status) : refs.length ? t('analysisReady') : ''
    const startAnalysis = async () => {
      setAnalysisStarting(true)
      try {
        const result = await actions.startAnalysis({ operationId: id(), styleId: style.styleId, buildDataset: true })
        // 切换素材集后不回写旧界面，已启动的任务仍由 Host 管理。
        if (!importLifetime.current.signal.aborted) { processTrigger.current?.focus({ preventScroll: true }); actions.openAnalysis(resultId(result, 'runId')) }
      } finally { if (!importLifetime.current.signal.aborted) setAnalysisStarting(false) }
    }
    const analyze = () => { if (!analysisDisabled && !analysisBusy) void startAnalysis().catch(error => { /* 共享任务状态负责显示启动失败。 */ }) }
    const openPaths = () => report(async () => {
      setPickerError('')
      try { await importPickedReferences(actions, { styleId: style.styleId, role, limits: importing }, () => actions.pickLocalReferences('references', importLifetime.current.signal), rows => { setImports(rows); setImportPage(0) }, importLifetime.current.signal) }
      catch (error) { if (!importLifetime.current.signal.aborted) setPickerError(t('localPickerError')) }
    })
    const openGalleryFromMenu = () => {
      // 菜单项即将卸载；让弹窗保存稳定的返回焦点，关闭后回到“添加引用”。
      importTrigger.current?.focus({ preventScroll: true }); setGalleryOpen(true)
    }
    const addPath = (analyzeAfter: boolean) => report(async () => {
      const path = sourcePath.trim().replace(/^"|"$/g, '')
      if (!path) return
      setPathError(''); setPickerError('')
      let selectionRead = false
      try {
        const rows = await importPickedReferences(actions, { styleId: style.styleId, role, limits: importing }, () => actions.listLocalReferences(path, pathKind, importLifetime.current.signal), rows => { selectionRead = true; setImports(rows); setImportPage(0); setPathOpen(false) }, importLifetime.current.signal)
        if (analyzeAfter && !importLifetime.current.signal.aborted && rows.some(row => row.status === 'imported')) {
          await startAnalysis()
        }
      } catch (error) { if (!importLifetime.current.signal.aborted) { if (selectionRead) setPickerError(t('analysisStartError')); else setPathError(t('localPathError')) } }
    })
    const statusKeys = { queued: 'importQueued', processing: 'importProcessing', imported: 'imported', failed: 'failed', skipped: 'importSkipped', unconfirmed: 'importUnconfirmed' } as const
    const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`
    const importPages = Math.max(1, Math.ceil(imports.length / importing.pageSize)), currentImportPage = Math.min(importPage, importPages - 1)
    return <div className="vc-image-workspace" data-inspector-open={inspectorOpen}><div className="vc-library-pane">
      <div className="vc-library-heading"><h2>{t('references')} <span className="vc-count">{style.referenceIds.length}</span>{(query || filter !== 'all') && <small className="vc-filter-result">{t('visibleImages')} {visibleRefs.length}</small>}</h2>
        <div className="vc-import-actions"><label className="vc-inline-field vc-import-role">{t('role')}<SelectField label={t('role')} value={role} disabled={busy} options={(['positive', 'negative'] as const).map(value => ({ value, label: t(value) }))} onChange={value => setRole(value as typeof role)} /></label>
          <Menu className="vc-import-picker" open={importMenuOpen} onClose={() => setImportMenuOpen(false)} portal compact autoFocus items={[{ id: 'local', label: t('referenceLocal'), disabled: busy || referencing }, { id: 'gallery', label: t('galleryReference'), disabled: busy }, { id: 'path', label: t('referenceByPath'), disabled: busy || referencing }]} onSelect={value => { setImportMenuOpen(false); if (value === 'path') { setPathError(''); setPathOpen(true) } else if (value === 'gallery') openGalleryFromMenu(); else openPaths() }}
            anchor={<Button ref={importTrigger} variant="primary" className="vc-primary-action" disabled={busy} aria-haspopup="menu" aria-expanded={importMenuOpen} onClick={() => setImportMenuOpen(value => !value)}><ui.IconPlusOutlineRegular size={16} />{t('importMaterials')}<ui.IconChevronDownOutlineRegular size={12} /></Button>} />
          <div className="vc-analysis-actions"><Button variant="outline" className={`vc-analyze-action${profileReady ? ' vc-analysis-complete' : ''}`} disabled={analysisBusy || (profileReady ? busy : analysisDisabled)} aria-busy={analysisBusy || undefined} onClick={profileReady ? () => setDatasetOpen(true) : analyze}>{analysisBusy ? <StateDot state="ongoing" /> : profileReady ? <ui.IconListPenOutlineRegular size={16} /> : <ui.IconSparkleRegular size={16} />}{t(analysisBusy ? 'analysisBusy' : profileReady ? 'viewStyleProfile' : 'analyze')}</Button><Button ref={processTrigger} className="vc-process-action" variant="outline" disabled={!analysis} onClick={() => { if (analysis) actions.openAnalysis(analysis.runId) }}><ui.IconListPenOutlineRegular size={16} />{t('analysisProcess')}</Button></div></div></div>
      <div className="vc-process-summary" aria-label={t('workflow')}>
        <ol className="vc-sr-only">{workflowSteps.map(step => <li key={step.label} aria-current={step === currentStep ? 'step' : undefined}>{t(step.label)}</li>)}</ol>
        <div className="vc-process-current"><span className="vc-process-index" aria-hidden="true">{workflowSteps.indexOf(currentStep) + 1} / {workflowSteps.length}</span><strong>{t(currentStep.label)}</strong></div>
        {!referencing && analysisLabel && <div className="vc-process-state" role="status">{(analysis || analysisBusy || needsModel) && <StateDot state={analysisState} />}<span>{analysisLabel}</span>{analysis && !analysis.stale && !analysisStarting && !needsModel && <span className="vc-process-count" aria-label={`${t('analysisProgress')} ${analysis.observed} / ${analysis.total}`}>{analysis.observed} / {analysis.total}</span>}</div>}
      </div>
      {task && <GalleryTaskStatus task={task} t={t} onStop={() => report(() => actions.stopGalleryReferences(task.id))} />}
      <div className="vc-library-tools"><div className="vc-library-toolbar"><div className="vc-filter-tabs" role="group" aria-label={t('filterRole')}>{(['all', 'positive', 'negative', 'undecided'] as const).filter(value => value !== 'undecided' || roleCount(value) || filter === value).map(value => <Button key={value} variant="outline" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(value)}<span>{roleCount(value)}</span></Button>)}</div>
          <div className="vc-library-controls"><div className="vc-view-switch" role="group" aria-label={t('viewMode')}>{(['grid', 'list'] as const).map(value => <Button key={value} size="sm" variant="ghost" aria-pressed={view === value} onClick={() => setView(value)}>{t(value === 'grid' ? 'gridView' : 'listView')}</Button>)}</div><Button ref={inspectorToggle} className="vc-inspector-toggle" variant="outline" aria-expanded={inspectorOpen} aria-controls={inspectorId} onClick={() => setInspectorOpen(value => !value)}><ui.IconListPenOutlineRegular size={16} />{t('rules')}<Tag>{rules.length}</Tag></Button></div></div></div>
      <section className="vc-library vc-stack" data-dragging={dragging && !busy}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; setDragging(true) } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={event => {
          event.preventDefault(); setDragging(false)
          if (busy) return
          // 浏览器 File 不提供可靠的本机绝对路径，不能把文件名猜成路径或回退成复制上传。
          setImports([{ id: 0, name: t('droppedSelection'), size: 0, status: 'failed', reason: 'localPathRequired' }])
        }}>
        {dragging && !busy && <div className="vc-drop-indicator">{t('dropHint')}</div>}
        {visibleRefs.length ? <div className={`vc-image-grid vc-reference-grid${view === 'list' ? ' vc-image-list' : ''}`}>{visibleRefs.map(image => <figure key={image.referenceId}>
          <a className="vc-image-preview" href={resource(image.previewPath)} target="_blank" rel="noreferrer"><img src={resource(image.previewPath)} alt={image.name} loading="lazy" /></a>
          <figcaption><span className="vc-image-name" title={image.localPath ?? image.name}>{image.name.split(/[\\/]/).at(-1)}</span><small>{image.width} × {image.height}</small><Tag tone={image.role === 'positive' ? 'info' : image.role === 'negative' ? 'danger' : 'neutral'}>{t(image.role === 'positive' ? 'positive' : image.role === 'negative' ? 'negative' : 'undecided')}</Tag></figcaption>
        </figure>)}</div>
          : refs.length ? <div className="vc-empty vc-filter-empty"><ui.IconSearchOutlineRegular size={28} /><h3>{t('noMatches')}</h3><Button variant="outline" onClick={() => { clearQuery(); setFilter('all') }}>{t('resetFilters')}</Button></div>
          : referencePage?.loading ? null : <div className="vc-empty vc-import-empty"><div className="vc-empty-symbol"><ui.IconFolderOpenOutlineRegular size={32} /></div><h3>{t('noImages')}</h3><p>{t('importHint')}</p><div className="vc-row"><Button variant="outline" disabled={busy || referencing} onClick={openPaths}><ui.IconPlusOutlineRegular size={16} />{t('referenceLocal')}</Button><Button variant="outline" disabled={busy} onClick={() => setGalleryOpen(true)}><ui.IconFolderOpenOutlineRegular size={16} />{t('galleryReference')}</Button></div><small>{t('acceptedFormats')}</small></div>}
        {referencePage?.loading && !refs.length && <GallerySkeleton kind="photos" count={snapshot.configuration.limits.pageSize} label={t('galleryLoading')} />}
        {snapshot.collectionPaging ? <>
          <div className="vc-reference-loaded" role="status">{t('referenceLoaded')} {refs.length} / {referencePage?.total ?? style.referenceIds.length}</div>
          {referencePage?.error && <div className="vc-notice" role="alert">{t('referenceLoadError')}<Button size="sm" onClick={() => { void actions.loadReferences(style.styleId, !!referencePage.nextPageToken) }}>{t('retry')}</Button></div>}
          <GalleryLoadMore hasMore={!!referencePage?.nextPageToken} loading={!!referencePage?.loading && refs.length > 0} disabled={!!referencePage?.error} version={`${style.styleId}:${refs.length}:${referencePage?.nextPageToken ?? ''}`} kind="photos" label={t('galleryLoading')} onLoad={() => { void actions.loadMoreImages() }} />
        </> : snapshot.nextPageToken && <Button onClick={() => report(actions.loadMoreImages)}>{t('more')}</Button>}
        {pickerError && <p className="vc-notice" role="alert">{pickerError}</p>}
        {!!imports.length && <section className="vc-import-report" aria-label={t('importResults')}><div className="vc-row"><h3>{t('importResults')}</h3><span role="status" aria-live="polite">{t('imported')} {imports.filter(row => row.status === 'imported').length} / {imports.length}</span></div>
          {imports.some(row => row.status === 'failed' || row.status === 'unconfirmed') && <p role="alert">{t('partialImport')}</p>}
          <div className="vc-import-table-scroll" role="region" aria-label={t('importResults')} tabIndex={0}><table className="vc-import-table"><caption className="vc-sr-only">{t('importResults')}</caption><thead><tr><th scope="col">{t('fileName')}</th><th scope="col">{t('fileSize')}</th><th scope="col">{t('fileStatus')}</th><th scope="col">{t('fileDetails')}</th></tr></thead><tbody>{imports.slice(currentImportPage * importing.pageSize, (currentImportPage + 1) * importing.pageSize).map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{fileSize(row.size)}</td><td><Tag tone={row.status === 'imported' ? 'success' : row.status === 'failed' ? 'danger' : row.status === 'unconfirmed' ? 'warning' : 'neutral'}>{t(statusKeys[row.status])}</Tag></td><td>{row.reason ? <span>{t(row.reason)}{row.error && <code>{row.error.code}</code>}</span> : row.status === 'imported' ? t('importSaved') : t('importWaiting')}</td></tr>)}</tbody></table></div>
          {importPages > 1 && <div className="vc-import-pagination"><Button size="sm" variant="outline" disabled={!currentImportPage} onClick={() => setImportPage(value => value - 1)}>{t('previousPage')}</Button><span>{currentImportPage + 1} / {importPages}</span><Button size="sm" variant="outline" disabled={currentImportPage + 1 >= importPages} onClick={() => setImportPage(value => value + 1)}>{t('nextPage')}</Button></div>}
        </section>}
      </section>
      </div>
      <div className="vc-inspector-clip" aria-hidden={!inspectorOpen} {...inspectorOpen ? {} : { inert: '' }}>
      <aside id={inspectorId} className="vc-inspector vc-stack" aria-label={t('rules')} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setInspectorOpen(false); inspectorToggle.current?.focus() } }}>
        <div className="vc-row"><ui.IconListPenOutlineRegular size={18} /><h2>{t('rules')}</h2><Tag>{t(style.modelProfile ? 'autoSelected' : 'saved')}</Tag><Button size="sm" variant="ghost" onClick={() => { setInspectorOpen(false); inspectorToggle.current?.focus() }}>{t('collapse')}</Button></div>
        <p>{t('readonlyRulesHint')}</p>
        <div className="vc-readonly-rule-summary"><strong>{t('enabledRules')} {rules.length}</strong>{style.modelProfile && <small>v{style.modelProfile.revision}</small>}</div>
        {style.modelProfile?.stale && <p className="vc-notice">{t('analysisStale')}</p>}
        {!rules.length && <p className="vc-rule-empty">{t('noRules')}</p>}
        <div className="vc-readonly-rules">{dimensions.map(dimension => {
          const rows = rules.filter(rule => rule.dimension === dimension)
          return rows.length ? <DisclosureRow key={dimension} icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t(dimension)} headerAccessory={<Tag>{rows.length}</Tag>} open={expandedGroups.includes(dimension)} expandable expandOnRowClick onToggle={() => setExpandedGroups(current => current.includes(dimension) ? current.filter(value => value !== dimension) : [...current, dimension])}><div className="vc-readonly-rule-items">{rows.map(rule => <article key={rule.ruleId}><p>{rule.statement}</p>{rule.condition && <small>{rule.condition}</small>}</article>)}</div></DisclosureRow> : null
        })}</div>
        <Button variant="outline" disabled={!style.modelProfile && !style.analysis?.summary} onClick={() => setDatasetOpen(true)}>{t('openProfile')}<ui.IconChevronRightOutlineRegular size={14} /></Button>
      </aside>
      </div>
      <DatasetDialog open={datasetOpen} onClose={() => setDatasetOpen(false)} onAnalyze={() => { setDatasetOpen(false); analyze() }} canAnalyze={!analysisDisabled && !analysisBusy} style={style} snapshot={snapshot} actions={actions} t={t} busy={busy} />
      {galleryOpen && <GalleryReferenceDialog task={task} config={snapshot.configuration} style={style} role={role} actions={actions} t={t} onClose={() => setGalleryOpen(false)} onManageAccounts={() => { setGalleryOpen(false); openGallerySettings() }} />}
      <Modal open={pathOpen} onClose={() => { if (!busy) setPathOpen(false) }} title={t('referenceByPath')} closeLabel={t('close')} className="vc-create-modal vc-path-modal">
        <form className="vc-create-form" onSubmit={event => { event.preventDefault(); addPath(false) }}>
          <label>{t('pathKind')}<SelectField label={t('pathKind')} value={pathKind} disabled={busy} options={[{ value: 'folder', label: t('folderPath') }, { value: 'file', label: t('imagePath') }]} onChange={value => setPathKind(value as 'file' | 'folder')} /></label>
          <label>{t('originalPath')}<Input data-modal-autofocus value={sourcePath} placeholder={t('pathHint')} disabled={busy} onChange={event => setSourcePath(event.target.value)} /></label>
          <p>{t('localReferenceHint')}</p>{pathError && <p role="alert">{pathError}</p>}
          <div className="vc-row"><Button type="submit" variant="outline" disabled={busy || !sourcePath.trim()}>{t('addLocalReference')}</Button><Button type="button" variant="primary" disabled={busy || !sourcePath.trim() || !snapshot.configuration.visionConfigured} onClick={() => addPath(true)}>{t(busy ? 'busy' : 'referenceAndAnalyze')}</Button></div>
        </form>
      </Modal>
    </div>
  }

  function Workbench({ useWorkbench, actions, t, welcomeImage, logoImage, renderFactorySlot }: WorkbenchProps) {
    const state = useWorkbench(value => value), snapshot = state.snapshot
    const [tab, setTab] = React.useState<'workbench' | 'settings'>('workbench')
    const [settingsPanel, setSettingsPanel] = React.useState<'vision' | 'source'>('vision')
    const [name, setName] = React.useState(''), [error, setError] = React.useState(''), [working, setWorking] = React.useState(false)
    const [createOpen, setCreateOpen] = React.useState(false)
    const [deleteTarget, setDeleteTarget] = React.useState<{ kind: 'single' | 'all'; targets: Pick<StyleView, 'styleId' | 'name' | 'revision'>[]; operationId: string } | null>(null)
    const [deleteError, setDeleteError] = React.useState('')
    const [deleteProgress, setDeleteProgress] = React.useState(0)
    const [collectionOpen, setCollectionOpen] = React.useState(false)
    const [tasksOpen, setTasksOpen] = React.useState(false)
    const [taskSelection, setTaskSelection] = React.useState({ styleId: state.styleId, runId: '' })
    const [imageSearch, setImageSearch] = React.useState({ styleId: state.styleId, value: '' })
    // 顶部搜索归属当前素材集，切换时先屏蔽旧条件，再清空本地输入。
    const query = imageSearch.styleId === state.styleId ? imageSearch.value : ''
    React.useEffect(() => { setImageSearch({ styleId: state.styleId, value: '' }) }, [state.styleId])
    const viewId = React.useId()
    const report = (work: () => Promise<unknown>) => {
      if (working) return
      setWorking(true); setError('')
      void work().catch((failure: unknown) => {
        if (failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string') setError(`${t('error')} (${failure.code})`)
        else setError(failure instanceof Error && failure.message === 'import-limit' ? t('importLimit') : t('error'))
      }).finally(() => setWorking(false))
    }
    const style = snapshot?.styles.find(item => item.styleId === state.styleId && !item.archived)
    const styles = snapshot?.styles.filter(item => !item.archived) ?? []
    const referenceTask = state.galleryTasks.find(task => task.styleId === state.styleId)
    const referencing = !!referenceTask && galleryTaskActive(referenceTask.status)
    const currentAnalysisRun = snapshot?.runs.find(run => run.runId === style?.analysis?.runId)
    // 任务面板默认跟随当前素材集，手动选择仅在该素材集内保留。
    const selectedRun = snapshot?.runs.find(run => run.runId === (taskSelection.styleId === state.styleId ? taskSelection.runId : '')) ?? currentAnalysisRun ?? snapshot?.runs.find(run => run.runId === state.runId && (run.kind !== 'analyze' || run.styleId === state.styleId))
    const historyRuns = snapshot?.runs.filter(run => run.kind !== 'analyze' || run.styleId === state.styleId || run.runId === style?.analysis?.runId).slice().reverse() ?? []
    const orderedRuns = currentAnalysisRun ? [currentAnalysisRun, ...historyRuns.filter(run => run.runId !== currentAnalysisRun.runId)] : historyRuns
    const loadedReferences = style && snapshot ? filterReferences(snapshot.images, style, '', 'all').length : 0
    const activeTasks = snapshot?.runs.filter(run => ['created', 'running', 'pausing', 'cancelling'].includes(run.status)).length ?? 0
    const createCollection = () => report(async () => {
      const result = await actions.execute('style-create', { operationId: id(), name: name.trim() })
      actions.selectStyle(resultId(result)); setName(''); setTab('workbench'); setCreateOpen(false)
    })
    const deleteCollection = () => {
      if (!deleteTarget) return
      const target = deleteTarget
      report(async () => {
        setDeleteError(''); setDeleteProgress(0)
        const result = await archiveCollections(actions, target.targets, target.operationId, setDeleteProgress)
        if (result.status === 'completed') {
          setDeleteTarget(null); setDeleteError('')
        } else setDeleteError(`${result.failedName} · ${t(result.conflict ? 'deleteCollectionChanged' : 'deleteCollectionFailed')}`)
      })
    }
    return <div className="vc-page-frame"><section className="vc-workbench" data-welcome={!!snapshot && !style && tab !== 'settings'} aria-label={t('title')} aria-busy={working || state.loading}>
      <div className="vc-commandbar"><Menu className="vc-collection-picker" open={collectionOpen} onClose={() => setCollectionOpen(false)} portal compact autoFocus
        selectedId={style ? `style:${style.styleId}` : undefined}
        items={styles.map(item => { const task = state.galleryTasks.find(task => task.styleId === item.styleId && galleryTaskActive(task.status)); const analysis = state.analysisTasks.find(task => task.styleId === item.styleId && analysisActive(task.status)); return { id: `style:${item.styleId}`, label: <span className="vc-collection-task-label"><span>{item.name}</span>{(task || analysis) && <><StateDot state="ongoing" /><small>{task ? `${task.completed} / ${task.total}` : `${analysis!.observed} / ${analysis!.total}`}</small></>}</span> } })}
        footer={[{ id: 'create-collection', label: t('create'), icon: <ui.IconPlusOutlineRegular size={14} />, disabled: working || !snapshot },
          ...(style ? [{ id: 'delete-collection', label: t('deleteCurrentCollection'), icon: <ui.IconTrashOutlineRegular size={14} />, danger: true, disabled: working || referencing || !!style.analysis && analysisActive(style.analysis.status) }] : []),
          { id: 'delete-all-collections', label: t('deleteAllCollections'), icon: <ui.IconTrashOutlineRegular size={14} />, danger: true, disabled: working || !styles.length || state.galleryTasks.some(task => galleryTaskActive(task.status)) || state.analysisTasks.some(task => analysisActive(task.status)) }]}
        onSelect={value => {
          setCollectionOpen(false)
          if (value === 'create-collection') { setError(''); setCreateOpen(true) }
          else if (value === 'delete-collection' && style) { setDeleteError(''); setDeleteProgress(0); setDeleteTarget({ kind: 'single', targets: [{ styleId: style.styleId, name: style.name, revision: style.revision }], operationId: id() }) }
          else if (value === 'delete-all-collections') { setDeleteError(''); setDeleteProgress(0); setDeleteTarget({ kind: 'all', targets: styles.map(item => ({ styleId: item.styleId, name: item.name, revision: item.revision })), operationId: id() }) }
          else { actions.selectStyle(value.slice('style:'.length)); setTab('workbench') }
        }}
        anchor={<Button className="vc-collection-trigger" variant="ghost" disabled={!snapshot} aria-label={t('chooseCollection')} aria-haspopup="menu" aria-expanded={collectionOpen}
          onClick={() => setCollectionOpen(value => !value)} onKeyDown={event => { if (!collectionOpen && event.key === 'ArrowDown') { event.preventDefault(); setCollectionOpen(true) } }}>
          <img className="vc-collection-logo" src={logoImage} alt="" width={20} height={20} draggable={false} />{(referencing || !!style?.analysis && analysisActive(style.analysis.status)) && <StateDot state="ongoing" />}<span className="vc-collection-name">{style?.name ?? t('styles')}</span><ui.IconChevronDownOutlineRegular size={12} />
        </Button>} />
        {style && tab === 'workbench' && <div className="vc-page-search"><Input icon={<ui.IconSearchOutlineRegular size={16} />} className="vc-image-search" aria-label={t('filterImages')} placeholder={t('filterImages')} value={query} onChange={event => setImageSearch({ styleId: state.styleId, value: event.target.value })} /></div>}
        <div className="vc-command-actions"><span className="vc-model-state"><StateDot state={snapshot?.configuration.visionConfigured ? 'done' : 'idle'} />{t('vision')} · {t(snapshot?.configuration.visionConfigured ? 'configured' : 'unconfigured')}</span><Button variant="ghost" disabled={working} onClick={() => report(actions.reload)}><ui.IconRefreshOutlineRegular size={16} />{t('refresh')}</Button></div></div>
      {snapshot && <div className="vc-pagebar"><SegmentedTabs variant="underline" className="vc-workspace-tabs" label={t('title')} value={tab} onChange={setTab}
        items={[{ value: 'workbench', label: t('workbench'), id: `${viewId}-workbench-tab`, panelId: `${viewId}-workbench` }, { value: 'settings', label: t('modelSettings'), id: `${viewId}-settings-tab`, panelId: `${viewId}-settings` }]} />{style?.releases.length ? <div className="vc-context-meta"><Tag>{style.releases.at(-1)?.label}</Tag></div> : null}</div>}
      <main className={`vc-main${style && tab === 'workbench' ? ' vc-main-workspace' : ''}`}>
        {(error || state.error) && <div className="vc-notice" role="alert">{error || `${t('error')} (${state.error?.code})`}<Button size="sm" onClick={() => report(actions.reload)}>{t('retry')}</Button></div>}
        {state.galleryTaskError && <div className="vc-notice" role="alert">{t('galleryConnectionError')}</div>}
        {!snapshot && <div className="vc-empty">{state.loading ? <StateDot state="ongoing" /> : <Button onClick={() => report(actions.reload)}>{t('retry')}</Button>}</div>}
        {/* 页面内导航只隐藏工作区，保留规则草稿、筛选和焦点所属控件的实例。 */}
        {snapshot && <>
          <div className={style ? 'vc-workbench-panel' : undefined} id={`${viewId}-workbench`} role="tabpanel" aria-labelledby={`${viewId}-workbench-tab`} hidden={tab !== 'workbench'}>{style ? <StyleEditor pendingStart={state.pending.includes(`analysis:${style.styleId}`)} key={style.styleId} task={referenceTask} referencePage={state.referencePages[style.styleId]} style={style} snapshot={snapshot} actions={actions} t={t} report={report} busy={working} query={query} clearQuery={() => setImageSearch({ styleId: state.styleId, value: '' })} openGallerySettings={() => { setSettingsPanel('source'); setTab('settings') }} />
            : <section className="vc-welcome"><img className="vc-welcome-art" src={welcomeImage} alt="" width={558} height={242} decoding="async" /><h2>{t('welcomeTitle')}</h2><p>{t('welcomeHint')}</p><Button variant="primary" className="vc-primary-action vc-welcome-create" disabled={working} onClick={() => { setError(''); setCreateOpen(true) }}><ui.IconPlusOutlineRegular size={18} />{t('createCollectionAction')}</Button><small>{t('welcomeFormats')}</small></section>}</div>
          <div id={`${viewId}-settings`} role="tabpanel" aria-labelledby={`${viewId}-settings-tab`} hidden={tab !== 'settings'}>{tab === 'settings' && <Configuration saving={state.configSaving} saveError={state.configError} config={snapshot.configuration} actions={actions} t={t} report={report} styles={styles} selectedStyleId={state.styleId} initialPanel={settingsPanel} openWorkbench={styleId => { actions.selectStyle(styleId); setTab('workbench') }} />}</div>
        </>}
        {tab === 'workbench' && snapshot && (snapshot.runs.length > 0 || !!style?.referenceIds.length) && <DisclosureRow className="vc-task-section" rowClassName="vc-task-toggle" leadingClassName="vc-task-chevron" previewChevron={false} icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('taskHistory')} open={tasksOpen} expandable expandOnRowClick onToggle={() => setTasksOpen(value => !value)} headerAccessory={<span className="vc-task-meta"><span className="vc-task-count">{orderedRuns.length}</span>{activeTasks > 0 && <small><StateDot state="ongoing" />{t('running')} · {activeTasks}</small>}</span>}><div className="vc-task-panel"><TaskHistory runs={orderedRuns} selected={selectedRun} snapshot={snapshot} t={t} loading={state.runLoading} errorCode={state.runError?.code} actions={actions} onSelect={runId => { setTaskSelection({ styleId: state.styleId, runId }); actions.selectRun(runId) }} report={report} />{style && <div className="vc-task-notes" role="note"><div className="vc-library-caption"><span>{t('loadedImages')} {loadedReferences} / {style.referenceIds.length}</span><span>{t('previewHint')}</span></div><p className="vc-task-analysis-note"><ui.IconSparkleRegular size={14} />{t('modelNotes')}</p></div>}</div></DisclosureRow>}
      </main>
      <AnalysisDialog state={state} t={t} renderFactorySlot={renderFactorySlot} onReadInput={requestId => void actions.loadAnalysisInput(requestId)} onClose={actions.closeAnalysis} onStop={runId => void actions.stopAnalysis(runId)} onRetry={() => void actions.refreshAnalysisDetail()} />
      <Modal open={createOpen} onClose={() => { if (!working) setCreateOpen(false) }} title={t('create')} closeLabel={t('close')} className="vc-create-modal"><CreateCollection name={name} onName={setName} onSubmit={createCollection} busy={working} error={error} t={t} /></Modal>
      <Modal open={!!deleteTarget} onClose={() => { if (!working) setDeleteTarget(null) }} title={t(deleteTarget?.kind === 'all' ? 'deleteAllCollections' : 'deleteCollection')} closeLabel={t('close')} className="vc-delete-modal"
        footer={<div className="vc-dataset-actions"><Button variant="outline" disabled={working} onClick={() => setDeleteTarget(null)}>{t('cancel')}</Button><Button variant="primary" disabled={working || !deleteTarget?.targets.length} onClick={deleteCollection}>{working && <StateDot state="ongoing" />}{t(working ? 'busy' : deleteTarget?.kind === 'all' ? 'deleteAllCollections' : 'deleteCollection')}</Button></div>}>
        {deleteTarget?.kind === 'all' ? <><p>{t('deleteAllCollectionsHint')} <Tag>{deleteTarget.targets.length}</Tag></p><ul className="vc-delete-list">{deleteTarget.targets.map(item => <li key={item.styleId}>{item.name}</li>)}</ul></> : <p className="vc-delete-name">{deleteTarget?.targets[0]?.name}</p>}
        <p>{t('deleteCollectionHint')}</p>{!!deleteTarget && (working || deleteProgress > 0) && <p className="vc-delete-progress" role="status">{t('deleteCollectionsProgress')} {deleteProgress} / {deleteTarget.targets.length}</p>}{deleteError && <p className="vc-notice" role="alert">{deleteError}</p>}
      </Modal>
    </section></div>
  }
  return Workbench
}
