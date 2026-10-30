/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Task-first workbench built from the application's existing primitives and theme tokens. */
import type { Workspace, WorkspaceState } from './workspace.ts'
import type { Text } from './locale.ts'
import { dimensionSchema, generationInputSchema, type Dimension, type RuleId, type Route } from '../shared/model.ts'
import importArtwork from '../../assets/reference-import-v1.webp'
import dimensionsArtwork from '../../assets/style-dimensions-v1.webp'
import { acceptedImageTypes, validateImageSelection, type ImportIssue } from './import.ts'

// 长标签置于末行，视觉顺序与键盘顺序保持一致。
const dimensionChoices: readonly Dimension[] = [...dimensionSchema.options.filter(dimension => dimension !== 'rendering'), 'rendering']

export interface WorkbenchProps {
  useWorkspace(): WorkspaceState
  actions: Workspace
  t: Text
  referenceUrl(analysisId: string, referenceId: string): string
}

/** @param React Application React runtime. @param ui Shared primitives. @returns Stable page and app-wide notice components. */
export function createWorkbench(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, TextArea, Checkbox, Pill, Tag, StateDot, Toast, Menu, SegmentedTabs, DisclosureRow, AnimatedCollapse } = ui
  function SelectField({ label, placeholder = label, value, options, disabled, onChange }: { label: string; placeholder?: string; value: string; options: { value: string; label: string }[]; disabled: boolean; onChange(value: string): void }) {
    const [open, setOpen] = React.useState(false)
    return <Menu className="sp-select" open={open} onClose={() => setOpen(false)} portal compact autoFocus selectedId={value}
      items={options.map(option => ({ id: option.value, label: option.label }))}
      onSelect={next => { setOpen(false); onChange(next) }}
      anchor={<Button className="sp-select-trigger" variant="outline" disabled={disabled || !options.length} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(current => !current)} onKeyDown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}>
        <span>{options.find(option => option.value === value)?.label ?? placeholder}</span><ui.IconChevronDownOutlineRegular size={12} />
      </Button>} />
  }
  function PromptBlock({ label, value, actions, t }: { label: string; value: { zh: string; en: string }; actions: Workspace; t: Text }) {
    return <section className="sp-prompt"><header><h3>{label}</h3><div className="sp-actions"><Button size="sm" onClick={() => void actions.copy(value.zh)}>{t('copyZh')}</Button><Button size="sm" onClick={() => void actions.copy(value.en)}>{t('copyEn')}</Button></div></header><p lang="zh-CN">{value.zh}</p><p lang="en">{value.en}</p></section>
  }
  function Workbench({ useWorkspace, actions, t, referenceUrl }: WorkbenchProps) {
    const state = useWorkspace(), analysis = state.analysis, result = analysis?.result, generation = state.generation
    const viewId = React.useId()
    const [tab, setTab] = React.useState<'references' | 'prompts'>('references')
    const [historyOpen, setHistoryOpen] = React.useState(false)
    const [openSections, setOpenSections] = React.useState<string[]>([])
    const [files, setFiles] = React.useState<File[]>([])
    const picker = React.useRef<HTMLInputElement>(null)
    const dragDepth = React.useRef(0), uploadHintId = React.useId()
    const [dragging, setDragging] = React.useState(false)
    const [importIssue, setImportIssue] = React.useState<ImportIssue | null>(null)
    const [previews, setPreviews] = React.useState<{ name: string; url: string }[]>([])
    const [routeKey, setRouteKey] = React.useState('')
    const [dimensions, setDimensions] = React.useState<Dimension[]>([...dimensionSchema.options])
    const [selected, setSelected] = React.useState<RuleId[]>([])
    const [briefZh, setBriefZh] = React.useState(''), [briefEn, setBriefEn] = React.useState('')
    const [changesZh, setChangesZh] = React.useState(t('defaultChanges')), [changesEn, setChangesEn] = React.useState('')
    const [platform, setPlatform] = React.useState<'generic' | 'flux2'>('generic')
    React.useEffect(() => {
      const next = files.map(file => ({ name: file.name, url: URL.createObjectURL(file) }))
      setPreviews(next)
      return () => { next.forEach(item => URL.revokeObjectURL(item.url)) }
    }, [files])
    React.useEffect(() => {
      if (!result) { setTab('references'); return }
      setTab('prompts')
      setSelected(result.rules.filter(rule => rule.status !== 'unknown' && rule.scope !== 'scene').map(rule => rule.id))
      if (analysis) setRouteKey(JSON.stringify(analysis.route))
    }, [analysis?.id, analysis?.status])
    React.useEffect(() => {
      if (!generation) return
      setTab('prompts')
      setSelected(generation.input.selectedRuleIds); setBriefZh(generation.input.brief.zh); setBriefEn(generation.input.brief.en)
      setChangesZh(generation.input.changes.zh); setChangesEn(generation.input.changes.en); setPlatform(generation.input.platform)
    }, [generation?.id])
    const model = state.models?.models.find(item => JSON.stringify({ provider: item.provider, model: item.id }) === routeKey)
    const route: Route | null = model ? { provider: model.provider, model: model.id } : null
    const active = analysis?.status === 'running' ? analysis : generation?.status === 'running' ? generation : null
    const pending = state.busy || Boolean(active)
    const uploadDisabled = pending || !state.history || !state.history.healthy
    React.useEffect(() => { if (uploadDisabled) { dragDepth.current = 0; setDragging(false) } }, [uploadDisabled])
    const importSelection = (incoming: File[]) => {
      if (uploadDisabled || !state.history) return
      const issue = validateImageSelection(incoming, state.history.limits)
      setImportIssue(issue)
      if (!issue) setFiles(incoming)
    }
    const uploadText = (text: string) => {
      const limits = state.history?.limits
      if (!limits) return ''
      const mib = (bytes: number) => (bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 3 })
      return text.replace('{count}', String(limits.maxImages)).replace('{size}', mib(limits.maxImageBytes)).replace('{total}', mib(limits.maxUploadBytes))
    }
    const input = analysis ? generationInputSchema.safeParse({ analysisId: analysis.id, selectedRuleIds: selected, brief: { zh: briefZh, en: briefEn }, changes: { zh: changesZh, en: changesEn }, platform, mode: 'model', ...(route ? { route } : {}) }) : null
    const canGenerate = result && input?.success && !pending
    const create = (mode: 'quick' | 'model') => {
      if (input?.success) void actions.generate({ ...input.data, mode })
    }
    const failure = state.error ?? generation?.failure?.code ?? analysis?.failure?.code ?? (!state.history?.healthy && state.history ? 'storage-error' : null)
    const visibleTab = result ? tab : 'references'
    const referenceCount = files.length || analysis?.references.length || 0
    const toggleSection = (key: string) => setOpenSections(value => value.includes(key) ? value.filter(item => item !== key) : [...value, key])
    return <div className="sp-page-frame"><main className="sp-workbench" aria-label={t('title')} aria-busy={pending || state.loading}>
      <header className="sp-heading"><div className="sp-heading-copy"><img src={importArtwork} width={24} height={24} alt="" /><h1>{t('title')}</h1></div><p className="sp-description">{t('subtitle')}</p><div className="sp-command-actions"><span className="sp-model-state"><StateDot state={route ? 'done' : 'idle'} />{t(route ? 'modelSelected' : 'chooseModel')}</span><Button variant="ghost" disabled={state.busy} onClick={() => void actions.refresh()}><ui.IconRefreshOutlineRegular size={16} />{t('retry')}</Button></div></header>
      <div className="sp-toolbar"><SegmentedTabs className="sp-workspace-tabs" variant="underline" label={t('workbench')} value={visibleTab} onChange={setTab} items={[{ value: 'references', label: t('referenceTab'), id: viewId + '-reference-tab', panelId: viewId + '-references' }, { value: 'prompts', label: t('promptTab'), id: viewId + '-prompt-tab', panelId: viewId + '-prompts', disabled: !result }]} /><Button className="sp-add-reference" variant="outline" disabled={uploadDisabled} onClick={() => picker.current?.click()}><ui.IconPlusOutlineRegular size={16} />{t('upload')}</Button></div>
      {failure && <div className="sp-error" role="alert"><p>{t(`error.${failure}`)}</p></div>}
      {state.loading && <div className="sp-loading" role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
      {active && <div className="sp-progress" role="status"><StateDot state="ongoing" /><span>{t(active.kind === 'analysis' ? 'analyzing' : 'generating')}</span><Button size="sm" disabled={state.busy} onClick={() => void actions.cancel(active.id)}>{t('cancel')}</Button></div>}
      <div className="sp-layout"><div className="sp-main-area">
        <section className="sp-reference-pane" id={viewId + '-references'} role="tabpanel" aria-labelledby={viewId + '-reference-tab'} hidden={visibleTab !== 'references'} data-has-references={referenceCount > 0}>
          <div className="sp-reference-toolbar"><h2>{t('reference')} <span className="sp-count">{referenceCount}</span></h2></div>
          <div className="sp-input-card"><section className="sp-section">
            <div className="sp-upload" role="group" aria-label={t('importArea')} aria-describedby={uploadHintId} aria-disabled={uploadDisabled} data-dragging={dragging && !uploadDisabled}
              onDragEnter={event => {
                if (!event.dataTransfer.types.includes('Files')) return
                event.preventDefault(); event.stopPropagation()
                if (!uploadDisabled) { dragDepth.current++; setDragging(true) }
              }}
              onDragOver={event => {
                event.preventDefault(); event.stopPropagation()
                event.dataTransfer.dropEffect = !uploadDisabled && event.dataTransfer.types.includes('Files') ? 'copy' : 'none'
              }}
              onDragLeave={event => {
                event.stopPropagation()
                // 子元素也会产生 enter/leave，计数归零后才移除整个导入区的高亮。
                dragDepth.current = Math.max(0, dragDepth.current - 1)
                if (!dragDepth.current) setDragging(false)
              }}
              onDrop={event => {
                event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false)
                importSelection(Array.from(event.dataTransfer.files))
              }}>
              <img className="sp-upload-art" src={importArtwork} alt="" width={600} height={450} draggable={false} />
              <span className="sp-upload-title" aria-live="polite">{t(dragging && !uploadDisabled ? 'dropReady' : 'uploadTitle')}</span>
              <span className="sp-hint">{t('uploadDescription')}</span>
              <Button variant="outline" disabled={uploadDisabled} onClick={() => picker.current?.click()}>{t('upload')}</Button>
              <span className="sp-upload-formats">{t('uploadFormats')}</span>
              <input ref={picker} className="sp-file-input" type="file" multiple accept={acceptedImageTypes} disabled={uploadDisabled} aria-label={t('upload')} onChange={event => {
                const incoming = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (incoming.length) importSelection(incoming)
              }} />
            </div>
            {importIssue && <p className="sp-import-error" role="alert">{uploadText(t(`importError.${importIssue}`))}</p>}
            <div id={uploadHintId} className="sp-upload-hint"><p className="sp-hint">{state.history ? uploadText(t('uploadLimits')) : t('loading')}</p><p className="sp-hint">{t('uploadHint')}</p></div>
            {previews.length > 0 ? <div className="sp-references">{previews.map((preview, index) => <figure key={preview.url}><img src={preview.url} alt={preview.name} /><figcaption title={preview.name}>{preview.name}</figcaption><small>{Math.ceil((files[index]?.size ?? 0) / 1024)} KB</small></figure>)}</div> : analysis && <div className="sp-references">{analysis.references.map(ref => <figure key={ref.id}><a href={referenceUrl(analysis.id, ref.id)} target="_blank" rel="noreferrer"><img src={referenceUrl(analysis.id, ref.id)} alt={ref.name} /></a><figcaption title={ref.name}>{ref.name}</figcaption></figure>)}</div>}
          </section>
</div>
        </section>
        <div className="sp-content sp-prompts-pane" id={viewId + '-prompts'} role="tabpanel" aria-labelledby={viewId + '-prompt-tab'} hidden={visibleTab !== 'prompts'}>
          {result && <>
            <section className="sp-section sp-result-card"><h2>{t('newScene')}</h2><label className="sp-field"><span>{t('briefZh')}</span><TextArea aria-label={t('briefZh')} value={briefZh} onChange={event => setBriefZh(event.target.value)} disabled={pending} placeholder={t('briefHint')} /></label><label className="sp-field"><span>{t('changesZh')}</span><TextArea aria-label={t('changesZh')} value={changesZh} onChange={event => setChangesZh(event.target.value)} disabled={pending} placeholder={t('changesHint')} /></label>
              <details className="sp-disclosure"><summary>{t('optionalEnglish')}</summary><div className="sp-field"><label>{t('briefEn')}<TextArea aria-label={t('briefEn')} value={briefEn} onChange={event => setBriefEn(event.target.value)} disabled={pending} /></label><label>{t('changesEn')}<TextArea aria-label={t('changesEn')} value={changesEn} onChange={event => setChangesEn(event.target.value)} disabled={pending} /></label></div></details>
              <p className="sp-hint">{t('englishHint')}</p><div className="sp-field"><span>{t('platform')}</span><SelectField label={t('platform')} value={platform} disabled={pending} onChange={value => setPlatform(value === 'flux2' ? 'flux2' : 'generic')} options={[{ value: 'generic', label: t('generic') }, { value: 'flux2', label: t('flux2') }]} /></div><p className="sp-hint">{t('generateHint')}</p><div className="sp-actions"><Button className="sp-primary-action" variant="primary" disabled={!canGenerate || !route} onClick={() => create('model')}>{t('generate')}</Button><Button variant="outline" disabled={!canGenerate || !briefEn.trim() || !changesEn.trim()} onClick={() => create('quick')}>{t('quick')}</Button></div>
            </section>
          </>}
          {generation?.status === 'succeeded' && generation.result && <section className="sp-section sp-result-card sp-results"><header><h2>{t('result')}</h2><p>{t('manualHint')}</p></header><PromptBlock label={t('styleOnly')} value={generation.result.stylePrompt} actions={actions} t={t} /><PromptBlock label={t('fullPrompt')} value={generation.result.fullPrompt} actions={actions} t={t} /><h3>{t('variants')}</h3>{generation.result.variants.map((variant, index) => <React.Fragment key={index}><PromptBlock label={`${variant.title.zh} / ${variant.title.en}`} value={variant.prompt} actions={actions} t={t} /><ul>{variant.changes.map((change, i) => <li key={i}>{change.zh} / {change.en}</li>)}</ul></React.Fragment>)}
            {generation.result.newCreativeChoices.length > 0 && <details className="sp-disclosure"><summary>{t('newChoices')}</summary><ul>{generation.result.newCreativeChoices.map((item, i) => <li key={i}>{item.zh} / {item.en}</li>)}</ul></details>}
            <div className="sp-actions"><Button className="sp-primary-action" variant="primary" disabled={state.busy} onClick={() => void actions.download(generation.id, 'json')}>{t('exportJson')}</Button><Button variant="outline" disabled={state.busy} onClick={() => void actions.download(generation.id, 'markdown')}>{t('exportMarkdown')}</Button></div>
          </section>}
          {(generation ?? analysis) && !pending && <div className="sp-record-actions"><Button disabled={state.busy} onClick={() => { const record = generation ?? analysis; if (record) void actions.remove(record.id) }}>{t('remove')}</Button></div>}
        </div>
      </div><aside className="sp-inputs sp-inspector" aria-label={t('analysisSettings')}><div className="sp-inspector-body"><header className="sp-inspector-heading"><h2>{t('analysisSettings')}</h2></header>
          <section className="sp-section"><div className="sp-field"><span>{t('model')}</span><SelectField label={t('model')} placeholder={t('chooseModel')} value={routeKey} disabled={pending} onChange={setRouteKey} options={state.models?.models.map(item => ({ value: JSON.stringify({ provider: item.provider, model: item.id }), label: `${item.providerName} · ${item.name}` })) ?? []} /></div><p className="sp-hint">{t('modelHint')}</p>
            {state.models?.unavailable.length ? <p className="sp-hint">{t('unavailable')}: {state.models.unavailable.join(', ')}</p> : null}
            {state.models && !state.models.models.length && <p role="status">{t('noModels')}</p>}
            <section className="sp-dimensions">
              <header className="sp-dimensions-heading"><div><h3 className="sp-dimensions-title" id={viewId + '-dimensions'}>{t('dimensions')}<span className="sp-count" aria-hidden="true">{dimensions.length} / {dimensionSchema.options.length}</span></h3><p id={viewId + '-dimensions-hint'}>{t('dimensionsHint')}</p></div><img className="sp-dimensions-art" src={dimensionsArtwork} width={64} height={56} alt="" draggable={false} /></header>
              <div className="sp-dimension-options" role="group" aria-labelledby={viewId + '-dimensions'} aria-describedby={viewId + '-dimensions-hint'}>{dimensionChoices.map(dimension => {
                const selected = dimensions.includes(dimension)
                return <Pill key={dimension} className={dimension === 'rendering' ? 'sp-dimension-option sp-dimension-wide' : 'sp-dimension-option'} active={selected} aria-pressed={selected} disabled={pending} onClick={() => setDimensions(value => value.includes(dimension) ? value.filter(item => item !== dimension) : [...value, dimension])}><ui.IconCheckOutlineRegular size={12} /><span>{t(dimension)}</span></Pill>
              })}</div>
            </section>
          </section>

          {result ? <>
            <section className="sp-section sp-result-card">
              <header className="sp-profile-summary"><div className="sp-profile-title"><h2>{result.name}</h2><span className="sp-count">{t('selectedRules')} {selected.length}</span></div><p>{result.summary}</p></header>
              <h3 className="sp-rules-heading">{t('rules')}</h3>
              {!result.rules.some(rule => rule.status !== 'unknown' && rule.scope !== 'scene') && <p className="sp-hint">{t('noRules')}</p>}
              <div className="sp-rules">{result.rules.map(rule => {
                const sectionKey = `${analysis?.id}:rule:${rule.id}`
                return <article key={rule.id} className={selected.includes(rule.id) ? 'sp-rule sp-selected' : 'sp-rule'}>
                  <div className="sp-rule-meta"><Tag tone="neutral">{t(rule.dimension)}</Tag><span>{t(rule.scope === 'scene' ? 'scene' : rule.status)}</span></div>
                  <Checkbox className="sp-rule-check" checked={selected.includes(rule.id)} disabled={pending || rule.scope === 'scene' || rule.status === 'unknown'} label={rule.description.zh} onChange={checked => setSelected(value => checked ? [...value, rule.id] : value.filter(id => id !== rule.id))} />
                  <DisclosureRow className="sp-rule-evidence" rowClassName="sp-evidence-toggle" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('evidence')} open={openSections.includes(sectionKey)} expandable expandOnRowClick previewChevron={false} onToggle={() => toggleSection(sectionKey)}><dl className="sp-rule-support"><dt>{t('englishDescription')}</dt><dd lang="en">{rule.description.en}</dd><dt>{t('evidence')}</dt><dd>{rule.evidence}</dd></dl></DisclosureRow>
                </article>
              })}</div>
              <div className="sp-analysis-context">
                {result.sourceContent.length > 0 && <DisclosureRow className="sp-disclosure" rowClassName="sp-context-toggle" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('sourceContent')} open={openSections.includes(`${analysis?.id}:source`)} expandable expandOnRowClick previewChevron={false} onToggle={() => toggleSection(`${analysis?.id}:source`)}><ul>{result.sourceContent.map(item => <li key={item}>{item}</li>)}</ul></DisclosureRow>}
                {result.sceneSpecific.length > 0 && <DisclosureRow className="sp-disclosure" rowClassName="sp-context-toggle" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('sceneSpecific')} open={openSections.includes(`${analysis?.id}:scene`)} expandable expandOnRowClick previewChevron={false} onToggle={() => toggleSection(`${analysis?.id}:scene`)}><ul>{result.sceneSpecific.map(item => <li key={item}>{item}</li>)}</ul></DisclosureRow>}
                {result.unknowns.length > 0 && <DisclosureRow className="sp-disclosure" rowClassName="sp-context-toggle" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('unknowns')} open={openSections.includes(`${analysis?.id}:unknowns`)} expandable expandOnRowClick previewChevron={false} onToggle={() => toggleSection(`${analysis?.id}:unknowns`)}><ul>{result.unknowns.map(item => <li key={item}>{item}</li>)}</ul></DisclosureRow>}
              </div>
            </section>
          </> : <section className="sp-profile-empty"><h3>{t('rules')}</h3><p>{t('analysisEmpty')}</p></section>}
      </div><footer className="sp-inspector-footer"><Button className="sp-analyze" variant="primary" disabled={!route || !files.length || !dimensions.length || pending || !state.history} onClick={() => route && void actions.analyze(files, route, dimensions)}>{t('analyze')}</Button></footer></aside></div>
          <section className="sp-history" aria-label={t('history')}><Button className="sp-history-toggle" variant="ghost" aria-label={t('history')} aria-expanded={historyOpen} aria-controls={viewId + '-history'} onClick={() => setHistoryOpen(value => !value)}><ui.IconChevronDownOutlineRegular size={14} /><span>{t('history')}</span><span className="sp-count" aria-hidden="true">{state.history?.tasks.length ?? 0}</span></Button><AnimatedCollapse className="sp-history-body" id={viewId + '-history'} open={historyOpen}>{state.history?.tasks.length ? <ul>{state.history.tasks.map(task => <li key={task.id}><button type="button" disabled={state.busy} aria-current={task.id === analysis?.id || task.id === generation?.id ? 'true' : undefined} onClick={() => { setFiles([]); setImportIssue(null); void actions.select(task.id) }}><StateDot state={task.status === 'succeeded' ? 'done' : task.status === 'running' ? 'ongoing' : task.status === 'failed' ? 'error' : 'idle'} /><span>{task.name || t(task.kind)}<small>{t(task.kind)}</small></span><small>{t(task.status)}</small></button></li>)}</ul> : <p className="sp-hint sp-history-empty">{t('historyEmpty')}</p>}</AnimatedCollapse></section>
    </main></div>
  }

  function Notice({ useWorkspace, actions, t }: Pick<WorkbenchProps, 'useWorkspace' | 'actions' | 't'>) {
    const notice = useWorkspace().notice
    return notice ? <Toast key={notice.sequence} text={t(notice.key)} {...(notice.key === 'copied' ? { tone: 'success' as const } : {})} onDone={actions.clearNotice} /> : null
  }
  return { Workbench, Notice }
}
