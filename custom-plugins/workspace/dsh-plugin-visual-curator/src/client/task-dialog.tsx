/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Two-step task form reuses saved usages, preparation and the existing background starts. */
import type { WorkbenchProps } from './workbench.tsx'
import type { StyleView, CuratorSnapshot, ActionArgs } from './contract.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import type { UsageRevision } from '../shared/model.ts'
import type { TaskPreparation } from '../shared/task-preparation.ts'
import { resultId } from './workbench-actions.ts'
import { createSelectField } from './select-field.tsx'

/** @param React Shell React. @param ui Shared controls. @returns Stable task dialog. */
export function createTaskDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Modal, Button, Input, TextArea, DisclosureRow, StateDot, Tag } = ui
  const SelectField = createSelectField(React, ui)
  return function TaskDialog({ open, style, snapshot, actions, t, imageVersionId, onClose, onStarted, onSettings }: {
    open: boolean; style: StyleView; snapshot: CuratorSnapshot; actions: WorkbenchProps['actions']; t: WorkbenchText; imageVersionId?: string | undefined
    onClose(): void; onStarted(runId: string): void; onSettings(): void
  }) {
    const [brief, setBrief] = React.useState(''), [target, setTarget] = React.useState(Math.min(10, snapshot.configuration.limits.maxCandidates)), [usageId, setUsageId] = React.useState(snapshot.usages.at(-1)?.usageRevisionId ?? '')
    const [queries, setQueries] = React.useState(''), [protectedText, setProtected] = React.useState(''), [advanced, setAdvanced] = React.useState(false)
    const [editing, setEditing] = React.useState(!snapshot.usages.length), [usageName, setUsageName] = React.useState(''), [width, setWidth] = React.useState(1920), [height, setHeight] = React.useState(1080)
    const [formats, setFormats] = React.useState(['jpeg']), [regions, setRegions] = React.useState<UsageRevision['safeRegions']>([]), [usageProtected, setUsageProtected] = React.useState('')
    const [preset, setPreset] = React.useState<{ presetId: string; revisionId: string; allowUpscale: boolean } | null>(null)
    const [prepared, setPrepared] = React.useState<TaskPreparation | null>(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
    const [visionCalls, setVisionCalls] = React.useState(snapshot.configuration.limits.maxVisionCalls), [pages, setPages] = React.useState(snapshot.configuration.limits.maxSearchPages)
    const operationId = React.useRef(crypto.randomUUID()), alive = React.useRef(true)
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    const rows = (text: string) => text.split('\n').map(row => row.trim()).filter(Boolean)
    const run = async (work: () => Promise<void>, message: string) => {
      if (busy) return
      setBusy(true); setError('')
      try { await work() } catch (failure) { if (alive.current) setError(`${t(message === 'usage' ? 'taskSaveError' : 'taskCheckFailed')} (${failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : t('error')})`) }
      finally { if (alive.current) setBusy(false) }
    }
    const saveUsage = () => run(async () => {
      let a = width, b = height
      while (b) [a, b] = [b, a % b]
      const value = await actions.execute(preset ? 'usage-save' : 'usage-create', { operationId: crypto.randomUUID(), ...(preset ? { presetId: preset.presetId, expectedCurrentRevisionId: preset.revisionId } : {}), name: usageName.trim(), output: { aspectP: width / a, aspectQ: height / a, targetWidth: width, targetHeight: height, acceptedFormats: formats, allowUpscale: preset?.allowUpscale ?? false }, safeRegions: regions, protectedContent: rows(usageProtected) })
      if (alive.current) { setUsageId(resultId(value)); setEditing(false); setPreset(null) }
    }, 'usage')
    const check = () => run(async () => {
      const args: ActionArgs = { kind: imageVersionId ? 'crop' : 'search', releaseId: style.modelProfile?.id ?? style.defaultReleaseId ?? '', usageRevisionId: usageId, taskBrief: brief.trim(), targetCount: target, protectedContent: rows(protectedText), budgets: { maxVisionCalls: visionCalls, maxSearchPages: pages }, ...(queries.trim() ? { queries: rows(queries) } : {}), ...(imageVersionId ? { imageVersionId } : {}) }
      const value = await actions.prepareTask(args)
      if (alive.current) setPrepared(value)
    }, 'task')
    const start = () => run(async () => {
      if (prepared?.status !== 'ready') return
      const value = await actions.execute(imageVersionId ? 'crop-start' : 'search-start', { ...prepared.normalizedInput, operationId: operationId.current, preparationDigest: prepared.preparationDigest })
      if (alive.current) onStarted(resultId(value, 'runId'))
    }, 'task')
    const ready = prepared?.status === 'ready'
    const editUsage = () => {
      const usage = snapshot.usages.find(item => item.usageRevisionId === usageId)
      if (!usage) return
      setUsageName(usage.name); setWidth(usage.targetWidth); setHeight(usage.targetHeight)
      setUsageProtected(usage.protectedContent.join('\n')); setFormats(usage.acceptedFormats ?? ['jpeg'])
      setRegions(usage.safeRegions.map(region => ({ rect: { x: region.x, y: region.y, width: region.width, height: region.height }, strength: region.strength, interference: region.description })))
      setPreset(usage.presetId ? { presetId: usage.presetId, revisionId: usageId, allowUpscale: usage.allowUpscale ?? false } : null)
      setEditing(true)
    }
    const selectedUsage = prepared?.status === 'ready' ? prepared.summary.usage : undefined
    return <Modal open={open} onClose={() => { if (!busy) onClose() }} title={t(ready ? 'taskCheck' : 'taskRequirements')} closeLabel={t('close')}
      className="vc-task-modal" contentClassName="vc-task-modal-content" footer={<div className="vc-task-footer">
        <Button variant="outline" disabled={busy} onClick={() => ready ? setPrepared(null) : onClose()}>{t(ready ? 'backTask' : 'cancel')}</Button>
        <Button variant="primary" disabled={busy || editing || !brief.trim() || !usageId} onClick={() => { void (ready ? start() : check()) }}>{busy && <StateDot state="ongoing" />}{t(ready ? imageVersionId ? 'taskStartCrop' : 'startTask' : 'checkTask')}</Button>
      </div>}>
      <div className="vc-task-form">
        <div className="vc-task-context"><ui.IconSparkleRegular size={14} /><span>{style.name}</span><Tag>{style.modelProfile ? `v${style.modelProfile.revision}` : t('saved')}</Tag></div>
        {error && <p className="vc-notice" role="alert">{error}</p>}
        {prepared?.status === 'blocked' && <div className="vc-notice" role="alert">{t('taskCheckFailed')} ({prepared.error.code})<Button size="sm" onClick={onSettings}>{t('taskConfig')}</Button></div>}
        {prepared?.status === 'needs-input' && <p className="vc-notice">{t('taskUsageRequired')}</p>}
        {ready && selectedUsage ? <section className="vc-task-form">
          <p className="vc-task-brief">{brief}</p>
          <dl className="vc-task-review-grid">
            <div><dt>{t('usageLabel')}</dt><dd>{selectedUsage.name} · {selectedUsage.output.targetWidth} × {selectedUsage.output.targetHeight}</dd></div>
            <div><dt>{t('taskFormat')}</dt><dd>{selectedUsage.output.acceptedFormats.join(' / ')}</dd></div>
            <div><dt>{t('taskSource')}</dt><dd>{snapshot.configuration.source.provider === 'unsplash' ? 'Unsplash' : t('taskConfiguredSource')}</dd></div>
            <div><dt>{t('targetCountLabel')}</dt><dd>{String(prepared.normalizedInput.targetCount ?? 1)}</dd></div>
            <div><dt>{t('taskVisionLimit')}</dt><dd>{prepared.summary.budgets.maxVisionCalls}</dd></div>
            <div><dt>{t('taskSearchLimit')}</dt><dd>{prepared.summary.budgets.maxSearchPages}</dd></div>
            <div><dt>{t('taskCandidates')}</dt><dd>{prepared.summary.budgets.maxCandidates}</dd></div>
            <div><dt>{t('taskBudget')}</dt><dd>{Math.round((prepared.summary.budgets.maxDownloadBytes ?? 0) / 1024 / 1024)} MiB · {Math.round((prepared.summary.budgets.deadlineMs ?? 0) / 1000)} s</dd></div>
          </dl>
          {!!selectedUsage.protectedContent.length && <div className="vc-task-review-section"><h3>{t('protectedLabel')}</h3><p>{selectedUsage.protectedContent.join(' / ')}</p></div>}
          {!!selectedUsage.safeRegions.length && <div className="vc-task-review-section"><h3>{t('safeRegionsLabel')}</h3><ul>{selectedUsage.safeRegions.map((region, index) => <li key={index}>{t(region.strength === 'required' ? 'taskRegionRequired' : 'taskRegionPreferred')} · {region.interference}</li>)}</ul></div>}
          {!imageVersionId && <div className="vc-task-review-section"><h3>{t('queriesLabel')}</h3><p>{Array.isArray(prepared.normalizedInput.queries) ? prepared.normalizedInput.queries.join(' / ') : ''}</p></div>}
          <div className="vc-task-review-section"><div className="vc-task-label-row"><h3>{t('taskInstructions')}</h3><Tag>{t('taskMatchThreshold')} · {Math.round((prepared.summary.executionRecipe?.styleMatching?.minSatisfiedRatio ?? 0) * 100)}%</Tag></div><ul>{prepared.summary.release.rules.map(rule => <li key={rule.ruleId}>{rule.statement}</li>)}</ul></div>
          <p className="vc-task-hint">{t('taskNoCharge')}</p>
        </section> : <fieldset disabled={busy} className="vc-task-form vc-task-fields">
          <label>{t('taskBriefLabel')}<TextArea rows={3} data-modal-autofocus value={brief} onChange={event => setBrief(event.target.value)} /></label>
          <div className={imageVersionId ? 'vc-task-basics vc-task-basics-crop' : 'vc-task-basics'}>
            {!imageVersionId && <label>{t('targetCountLabel')}<Input type="number" min={1} max={snapshot.configuration.limits.maxCandidates} value={target} onChange={event => setTarget(Number(event.target.value))} /></label>}
            <div className="vc-task-usage"><div className="vc-task-label-row"><span>{t('usageLabel')}</span><div className="vc-task-inline-actions">
              <Button size="sm" variant="ghost" onClick={() => { setPreset(null); setUsageName(''); setEditing(true) }}><ui.IconPlusOutlineRegular size={12} />{t('newUsage')}</Button>
              <Button size="sm" variant="ghost" disabled={!usageId} onClick={editUsage}>{t('editUsage')}</Button>
            </div></div><SelectField label={t('usageLabel')} value={usageId} disabled={busy} options={[{ value: '', label: t('taskUsageRequired') }, ...snapshot.usages.map(usage => ({ value: usage.usageRevisionId, label: `${usage.name} · ${usage.targetWidth} × ${usage.targetHeight}` }))]} onChange={setUsageId} /></div>
          </div>
          {editing && <fieldset className="vc-task-form vc-task-usage-editor">
            <div className="vc-task-label-row"><h3>{t(preset ? 'editUsage' : 'newUsage')}</h3><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('cancel')}</Button></div>
            <label>{t('taskUsageName')}<Input value={usageName} onChange={event => setUsageName(event.target.value)} /></label>
            <div className="vc-task-output-fields">
              <label>{t('widthLabel')}<Input type="number" min={1} value={width} onChange={event => setWidth(Number(event.target.value))} /></label>
              <label>{t('heightLabel')}<Input type="number" min={1} value={height} onChange={event => setHeight(Number(event.target.value))} /></label>
              <label>{t('taskFormat')}<SelectField label={t('taskFormat')} value={formats[0] ?? 'jpeg'} disabled={busy} options={[{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }]} onChange={value => setFormats([value])} /></label>
            </div>
            <label>{t('taskUsageProtected')}<TextArea rows={2} value={usageProtected} onChange={event => setUsageProtected(event.target.value)} /></label>
            <div className="vc-task-form vc-task-safe-regions">
              <div className="vc-task-label-row"><h3>{t('safeRegionsLabel')}</h3><Button size="sm" variant="ghost" onClick={() => setRegions(previous => [...previous, { rect: { x: 0, y: 0, width: 0.3, height: 1 }, interference: '', strength: 'required' }])}><ui.IconPlusOutlineRegular size={12} />{t('taskRegionAdd')}</Button></div>
              {!regions.length && <p className="vc-task-hint">{t('taskRegionEmpty')}</p>}
              {regions.length > 0 && <div className="vc-region-preview" role="img" aria-label={t('safeRegionsLabel')} style={{ aspectRatio: Math.max(1, width) / Math.max(1, height) }}>{regions.map((region, index) => <div className="vc-region-box" key={index} style={{ left: `${region.rect.x * 100}%`, top: `${region.rect.y * 100}%`, width: `${region.rect.width * 100}%`, height: `${region.rect.height * 100}%` }}>{index + 1}</div>)}</div>}
              {regions.map((region, index) => <fieldset key={index} className="vc-task-form vc-task-region-fields">
                <div className="vc-task-label-row"><Tag>{t('safeRegionsLabel')} {index + 1}</Tag><Button size="sm" variant="ghost" onClick={() => setRegions(previous => previous.filter((_, at) => at !== index))}>{t('taskRegionRemove')}</Button></div>
                <div className="vc-task-coordinate-fields">{(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>{t(({ x: 'taskRegionX', y: 'taskRegionY', width: 'taskRegionWidth', height: 'taskRegionHeight' } as const)[field])}<Input type="number" min={0} max={1} step={0.01} value={region.rect[field]} onChange={event => { const value = Number(event.target.value); setRegions(previous => previous.map((item, at) => at === index ? { ...item, rect: { ...item.rect, [field]: value } } : item)) }} /></label>)}</div>
                <label>{t('taskRegionText')}<TextArea rows={2} value={region.interference} onChange={event => { const value = event.target.value; setRegions(previous => previous.map((item, at) => at === index ? { ...item, interference: value } : item)) }} /></label>
                <label>{t('taskRegionStrength')}<SelectField label={t('taskRegionStrength')} value={region.strength} disabled={busy} options={[{ value: 'required', label: t('taskRegionRequired') }, { value: 'preferred', label: t('taskRegionPreferred') }]} onChange={next => { const value = next === 'required' ? 'required' : 'preferred'; setRegions(previous => previous.map((item, at) => at === index ? { ...item, strength: value } : item)) }} /></label>
              </fieldset>)}
            </div>
            <div className="vc-task-editor-actions"><Button size="sm" variant="outline" disabled={busy || !usageName.trim() || width < 1 || height < 1} onClick={() => void saveUsage()}>{t('taskSavedUsage')}</Button></div>
          </fieldset>}
          <label>{t('taskProtectedExtra')}<TextArea rows={2} value={protectedText} onChange={event => setProtected(event.target.value)} /></label>
          <DisclosureRow className="vc-task-advanced" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('moreSettings')} open={advanced} onToggle={() => setAdvanced(value => !value)} expandable expandOnRowClick>
            <div className="vc-task-form"><p className="vc-task-hint">{t('taskSource')}: {snapshot.configuration.source.provider === 'unsplash' ? 'Unsplash' : t('taskConfiguredSource')}</p>
              {!imageVersionId && <label>{t('queriesLabel')}<TextArea rows={2} value={queries} onChange={event => setQueries(event.target.value)} /></label>}
              <div className="vc-task-budget-fields"><label>{t('taskVisionLimit')}<Input type="number" min={1} max={snapshot.configuration.limits.maxVisionCalls} value={visionCalls} onChange={event => setVisionCalls(Number(event.target.value))} /></label>{!imageVersionId && <label>{t('taskSearchLimit')}<Input type="number" min={1} max={snapshot.configuration.limits.maxSearchPages} value={pages} onChange={event => setPages(Number(event.target.value))} /></label>}</div>
            </div>
          </DisclosureRow>
        </fieldset>}
      </div>
    </Modal>
  }
}
