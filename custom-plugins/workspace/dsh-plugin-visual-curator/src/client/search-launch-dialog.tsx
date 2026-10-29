/** @jsxRuntime classic */
/** @jsx React.createElement */
/** A compact Workspace launch form; execution belongs to the Host and native Session. */
import type { CuratorSnapshot, StyleView } from './contract.ts'
import type { SearchLaunchState, SearchLaunchStore } from './search-launch-store.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createSelectField } from './select-field.tsx'
import { createBackgroundTaskCard } from './background-task-card.tsx'

type LaunchActions = Pick<SearchLaunchStore, 'start' | 'retry' | 'stop' | 'refresh' | 'loadOptions' | 'openSession'>
type LaunchHook = <T>(select: (state: SearchLaunchState) => T) => T

/** @param React Shell React. @param ui Native form, modal and progress primitives. @returns Simple launch form and shared background feedback. */
export function createSearchLaunchUI(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui), Card = createBackgroundTaskCard(React, ui)
  function Background({ useLaunches, actions, t }: { useLaunches: LaunchHook; actions: LaunchActions; t: WorkbenchText }) {
    const state = useLaunches(value => value), entry = state.submission ? state.entries.find(item => item.id === state.submission!.input.operationId) : state.entries[0]
    if (!entry && !state.submission) return null
    const failed = entry?.status === 'failed' || state.submission?.status === 'rejected' || !!entry?.runStatus && ['failed', 'interrupted'].includes(entry.runStatus), stopped = entry?.status === 'stopped', preparing = !failed && (!entry || entry.status === 'working')
    return <Card id={entry?.id ?? state.submission!.input.operationId} kind="search" status={entry?.status ?? state.submission!.status} active={preparing || entry?.runStatus === 'running'} success={entry?.runStatus === 'completed' && entry.qualified >= entry.input.targetCount} progress={entry?.runIds.length ? { completed: entry.qualified, total: entry.input.targetCount } : undefined} label={t(entry?.stopping ? failed ? 'searchLaunchStopFailed' : 'searchLaunchStopping' : failed ? 'searchLaunchFailed' : stopped ? 'searchLaunchStopped' : preparing ? 'searchLaunchPreparing' : entry?.runStatus === 'completed' ? entry.qualified < entry.input.targetCount ? 'searchLaunchPartial' : 'searchLaunchCompleted' : entry?.runIds.length ? 'searchLaunchExecuting' : 'searchLaunchPlanning')} progressLabel={t('searchLaunchProgress')}
      hint={failed || state.error ? `${t('searchLaunchRecovery')} (${state.error || entry?.error?.code || state.submission?.error || entry?.runStatus})` : entry?.runIds.length ? <span>{t('searchLaunchQualified')} {entry.qualified} / {entry.input.targetCount}{entry.directory && <small className="vc-search-launch-directory">{entry.directory}</small>}</span> : t('searchLaunchBackground')}
      actions={<div className="vc-search-launch-card-actions">{entry && entry.stage !== 'preparing' && entry.stage !== 'creating-session' && <ui.Button size="sm" variant="outline" onClick={() => actions.openSession(entry.sessionId)}>{t('searchLaunchOpen')}</ui.Button>}{(failed || state.submission?.status === 'unknown') && <ui.Button size="sm" variant="outline" onClick={() => { if (entry) void actions.retry(entry.id); else if (state.submission) void actions.start(state.submission.input) }}>{t('searchLaunchContinue')}</ui.Button>}{entry && !stopped && <ui.Button size="sm" onClick={() => { void actions.stop(entry.id) }}>{t('searchLaunchStop')}</ui.Button>}</div>} />
  }
  function Dialog({ open, onClose, style, snapshot, useLaunches, actions, t }: { open: boolean; onClose(): void; style: StyleView; snapshot: CuratorSnapshot; useLaunches: LaunchHook; actions: LaunchActions; t: WorkbenchText }) {
    const state = useLaunches(value => value), retained = state.submission?.input ?? state.entries.find(item => item.status === 'working' || item.status === 'failed')?.input
    const [workspaceId, setWorkspace] = React.useState(retained?.workspaceId ?? ''), [brief, setBrief] = React.useState(retained?.taskBrief ?? t('searchLaunchDefaultBrief').replace('{name}', style.name))
    const [quantity, setQuantity] = React.useState(retained?.targetCount ?? Math.min(10, snapshot.configuration.limits.maxCandidates)), [output, setOutput] = React.useState<string>(retained?.output.kind ?? 'original'), [usageId, setUsage] = React.useState(retained?.output.kind === 'usage' ? retained.output.usageRevisionId : snapshot.usages[0]?.usageRevisionId ?? '')
    const operationId = React.useRef(retained?.operationId ?? crypto.randomUUID()), opened = React.useRef(false)
    const usages = state.options?.usages ?? snapshot.usages
    const selected = state.entries.find(item => item.id === operationId.current), pending = state.submission?.input.operationId === operationId.current ? state.submission : null
    const locked = !!pending && pending.status !== 'rejected' || !!selected && selected.status !== 'stopped'
    React.useEffect(() => { void actions.loadOptions(); void actions.refresh() }, [actions])
    React.useEffect(() => { if (!workspaceId && state.options?.workspaces.length) setWorkspace(state.options.workspaces[0]!.id) }, [state.options, workspaceId])
    React.useEffect(() => { if (!usageId && usages.length) setUsage(usages[0]!.usageRevisionId) }, [usages, usageId])
    React.useEffect(() => { if (selected?.status === 'accepted' && !opened.current) { opened.current = true; if (actions.openSession(selected.sessionId)) onClose() } }, [selected?.status, selected?.sessionId, actions, onClose])
    const start = () => {
      if (pending && pending.status !== 'rejected') { void actions.start(pending.input); return }
      if (pending?.status === 'rejected') operationId.current = crypto.randomUUID()
      if (selected) { void actions.retry(selected.id); return }
      if (!style.modelProfile) return
      void actions.start({ operationId: operationId.current, workspaceId, modelProfileId: style.modelProfile.id, taskBrief: brief, targetCount: quantity, output: output === 'original' ? { kind: 'original' } : { kind: 'usage', usageRevisionId: usageId } })
    }
    const workspace = state.options?.workspaces.find(item => item.id === workspaceId), usage = usages.find(item => item.usageRevisionId === usageId)
    return <ui.Modal open={open} onClose={onClose} title={t('searchLaunchTitle')} closeLabel={t('close')} className="vc-search-launch-modal" contentClassName="vc-search-launch-content" footer={<div className="vc-task-footer"><ui.Button variant="outline" onClick={onClose}>{t('close')}</ui.Button><ui.Button variant="primary" disabled={pending?.status === 'submitting' || selected?.status === 'working' || !workspace || !brief.trim() || !Number.isInteger(quantity) || quantity < 1 || quantity > (state.options?.maxTargetCount ?? snapshot.configuration.limits.maxCandidates) || output === 'usage' && !usage || !style.modelProfile || style.modelProfile.stale} onClick={start}>{(pending?.status === 'submitting' || selected?.status === 'working') && <ui.StateDot state="ongoing" />}{t(pending?.status === 'unknown' || selected?.status === 'failed' ? 'searchLaunchContinue' : 'startTask')}</ui.Button></div>}>
      <div className="vc-search-launch-form"><div className="vc-search-launch-summary"><ui.IconSparkleRegular size={16} /><div><strong>{style.name}</strong><small>{t('searchLaunchDatasetAuto')}</small></div><ui.Tag>{style.modelProfile ? `v${style.modelProfile.revision}` : t('saved')}</ui.Tag></div>
      {(state.error || pending?.error || selected?.error) && <div className="vc-notice" role="alert">{t('searchLaunchRecovery')} ({state.error || pending?.error || selected?.error?.code})<ui.Button size="sm" onClick={() => { void actions.loadOptions(); void actions.refresh() }}>{t('refresh')}</ui.Button></div>}
      <label className="vc-search-launch-field"><span>{t('searchLaunchWorkspace')}</span>{state.optionsLoading && !state.options ? <span className="vc-skeleton-fill vc-search-launch-skeleton" aria-busy="true" /> : <SelectField label={t('searchLaunchWorkspace')} value={workspaceId} options={(state.options?.workspaces ?? []).map(item => ({ value: item.id, label: item.title }))} disabled={locked || !state.options?.workspaces.length} onChange={setWorkspace} />}<small>{workspace?.path ?? t('searchLaunchNoWorkspace')}</small></label>
      <label className="vc-search-launch-field"><span>{t('taskBriefLabel')}</span><ui.TextArea data-modal-autofocus rows={3} maxLength={4000} value={brief} disabled={locked} onChange={event => setBrief(event.target.value)} /></label>
      <div className="vc-search-launch-grid"><label className="vc-search-launch-field"><span>{t('targetCountLabel')}</span><ui.Input type="number" min={1} max={state.options?.maxTargetCount ?? snapshot.configuration.limits.maxCandidates} value={quantity} disabled={locked} onChange={event => setQuantity(Number(event.target.value))} /></label><label className="vc-search-launch-field"><span>{t('searchLaunchOutput')}</span><SelectField label={t('searchLaunchOutput')} value={output} disabled={locked} options={[{ value: 'original', label: t('searchLaunchOriginal') }, { value: 'usage', label: t('searchLaunchSized') }]} onChange={setOutput} /></label></div>
      {output === 'usage' && <div className="vc-search-launch-field"><span>{t('usageLabel')}</span><SelectField label={t('usageLabel')} value={usageId} disabled={locked || !usages.length} options={usages.map(item => ({ value: item.usageRevisionId, label: `${item.name} · ${item.targetWidth} × ${item.targetHeight}` }))} onChange={setUsage} />{state.options?.usagePageToken && <ui.Button size="sm" disabled={state.optionsLoading} onClick={() => { void actions.loadOptions(true) }}>{t('more')}</ui.Button>}{!usage && <small>{t('taskUsageRequired')}</small>}</div>}
      <p className="vc-search-launch-hint">{t('searchLaunchAutoHint')}</p>
      {(pending || selected) && <Background useLaunches={useLaunches} actions={actions} t={t} />}</div>
    </ui.Modal>
  }
  return { Dialog, Background }
}
