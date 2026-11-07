/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Rule edits reuse immutable profile saves; local notes are frozen into new search briefs. */
import type { WorkbenchProps } from './workbench.tsx'
import type { StyleView } from './contract.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createProfileSaveQueue, type ProfileSaveState } from './profile-save-queue.ts'
import { isMatchingRule } from '../shared/reference-semantics.ts'
import cover from '../../assets/canvas-style-cover-v1.webp'

/** @param React Shell runtime. @param ui Native form controls. @returns An expandable style inspector retaining failed edits until retry. */
export function createCanvasStyleSidebar(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function CanvasStyleSidebar({ open, style, actions, t, notes, onNotes, onClose, onProfile, onReferences, onSearch }: {
    open: boolean; style: StyleView; actions: Pick<WorkbenchProps['actions'], 'execute' | 'reconcileProfile'>; t: WorkbenchText; notes: string
    onNotes(value: string): void; onClose(): void; onProfile(): void; onReferences(): void; onSearch(notes: string): void
  }) {
    const profile = style.modelProfile, latest = React.useRef(actions); latest.current = actions
    const [save, setSave] = React.useState<ProfileSaveState>({ profileId: '', changes: [], saving: false, failed: false, error: undefined })
    const [editing, setEditing] = React.useState<{ ruleId: string; statement: string } | null>(null)
    const [readError, setReadError] = React.useState(false), [tab, setTab] = React.useState<'rules' | 'brief'>('rules')
    const panelId = React.useId()
    const focusEditor = React.useCallback((target: HTMLTextAreaElement | null) => { target?.focus({ preventScroll: true }) }, [])
    const queue = React.useRef<ReturnType<typeof createProfileSaveQueue> | null>(null), alive = React.useRef(true)
    const input = { styleId: style.styleId, analysisRunId: profile?.analysisRunId ?? '', profileId: profile?.id ?? '' }
    const current = React.useRef(input); current.current = input
    React.useEffect(() => {
      alive.current = true
      const owned = createProfileSaveQueue({ changed: setSave, save: async value => {
        const reply = await latest.current.execute('profile-save', { ...value, changes: value.changes.map(change => ({ ...change })) })
        if (!reply || typeof reply !== 'object' || !('id' in reply) || typeof reply.id !== 'string') throw new Error('invalid-profile-save-response')
        return { id: reply.id }
      } })
      queue.current = owned; owned.sync(current.current)
      return () => { alive.current = false; owned.dispose(); queue.current = null }
    }, [])
    React.useEffect(() => { queue.current?.sync(input) }, [style.styleId, profile?.analysisRunId, profile?.id, save.failed])
    React.useEffect(() => { setEditing(null) }, [profile?.analysisRunId])
    const pending = new Map(save.changes.map(change => [change.ruleId, change]))
    const options = (profile?.options ?? []).map(option => {
      const change = pending.get(option.rule.ruleId)
      return change ? { ...option, enabled: change.enabled, rule: { ...option.rule, statement: change.statement ?? option.rule.statement } } : option
    })
    const retry = async () => {
      const identity = current.current.analysisRunId
      try {
        await latest.current.reconcileProfile(style.styleId)
        if (!alive.current || current.current.analysisRunId !== identity) return
        setReadError(false); queue.current?.sync(current.current); await queue.current?.flush()
      } catch (error) { if (alive.current) setReadError(true) }
    }
    const finish = async (next: () => void) => { if (!editing && await queue.current?.flush() && alive.current) next() }
    const disabled = !profile || profile.stale || readError
    const enabledCount = options.filter(option => option.enabled && isMatchingRule(option.rule)).length
    return <div className="vc-canvas-style-dock" data-open={open || undefined} aria-hidden={!open} {...open ? {} : { inert: '' }}><aside className="vc-canvas-style-sidebar" aria-label={t('workflowStylePanel')} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); void finish(onClose) } }}>
      <header><div className="vc-canvas-style-identity"><img src={cover} alt="" width={40} height={40} draggable={false} /><div><strong>{t('workflowStylePanel')}</strong><small>{style.name}{profile ? ` · v${profile.revision}` : ''}</small></div></div><ui.Tooltip portal label={t('close')}><ui.Button size="sm" variant="ghost" disabled={save.saving || !!editing} aria-label={t('close')} onClick={() => { void finish(onClose) }}><ui.IconCloseOutlineRegular size={16} /></ui.Button></ui.Tooltip></header>
      <ui.SegmentedTabs className="vc-canvas-style-tabs" label={t('workflowStylePanel')} variant="underline" value={tab} onChange={setTab} items={[{ value: 'rules', label: t('organizedRules'), id: `${panelId}-rules-tab`, panelId: `${panelId}-rules` }, { value: 'brief', label: t('workflowStyleNotesTitle'), id: `${panelId}-brief-tab`, panelId: `${panelId}-brief` }]} />
      <div className="vc-canvas-style-scroll">
        <section id={`${panelId}-rules`} role="tabpanel" aria-labelledby={`${panelId}-rules-tab`} hidden={tab !== 'rules'} className="vc-canvas-style-section">
          <div className="vc-canvas-style-section-title"><div><h3>{t('workflowRulesEnabled')}</h3><small>{enabledCount} / {options.length}</small></div><ui.Tag tone={save.failed || profile?.stale ? 'warning' : save.saving ? 'info' : 'neutral'}>{t(save.saving ? 'workflowSaving' : save.failed ? 'profileUnsaved' : 'saved')}</ui.Tag></div>
          <p>{t('workflowStyleGuidance')}</p>
          {!options.length && <p>{t('workflowWaitingAnalysis')}</p>}
          {profile?.stale && <p className="vc-notice">{t('needsAnalysis')}</p>}
          <div className="vc-canvas-rule-list">{options.map((option, index) => <article className="vc-canvas-style-rule" data-enabled={option.enabled || undefined} key={option.rule.ruleId}>
            <div className="vc-canvas-rule-heading"><small>{t('workflowRuleNumber').replace('{number}', String(index + 1))}</small><ui.Tooltip portal label={t('workflowEditRule')}><ui.Button className="vc-canvas-rule-edit" size="sm" variant="ghost" disabled={disabled || !!editing} aria-label={t('workflowEditRule')} onClick={() => setEditing({ ruleId: option.rule.ruleId, statement: option.rule.statement })}><ui.IconListPenOutlineRegular size={14} /></ui.Button></ui.Tooltip></div>
            <ui.Checkbox className="vc-canvas-rule-toggle" label={option.rule.statement} checked={option.enabled} disabled={disabled || !!editing} onChange={enabled => queue.current?.change({ ruleId: option.rule.ruleId, enabled })} />
            <ui.AnimatedCollapse open={editing?.ruleId === option.rule.ruleId} className="vc-canvas-rule-editor">{editing?.ruleId === option.rule.ruleId && <div><ui.TextArea ref={focusEditor} rows={4} maxLength={2000} value={editing.statement} onChange={event => setEditing({ ...editing, statement: event.currentTarget.value })} aria-label={t('workflowEditRule')} /><div className="vc-flow-node-actions"><ui.Button size="sm" variant="primary" disabled={disabled || !editing.statement.trim()} onClick={() => { queue.current?.change({ ruleId: option.rule.ruleId, enabled: option.enabled, statement: editing.statement.trim() }); setEditing(null) }}>{t('workflowSave')}</ui.Button><ui.Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('cancel')}</ui.Button></div></div>}</ui.AnimatedCollapse>
          </article>)}</div>
          <p className="vc-flow-muted">{t('workflowRulesHint')}</p>
          {(save.failed || readError) && <div className="vc-notice" role="alert">{t('profileSaveError')}<ui.Button size="sm" variant="outline" onClick={() => { void retry() }}>{t('retry')}</ui.Button></div>}
        </section>
        <section id={`${panelId}-brief`} role="tabpanel" aria-labelledby={`${panelId}-brief-tab`} hidden={tab !== 'brief'} className="vc-canvas-style-section"><h3>{t('workflowNextBrief')}</h3><p>{t('workflowNextBriefHint')}</p><ui.TextArea rows={8} maxLength={2000} value={notes} onChange={event => onNotes(event.currentTarget.value)} aria-label={t('workflowNextBrief')} placeholder={t('workflowBriefPlaceholder')} /><figure className="vc-canvas-style-cover"><img src={cover} alt="" width={640} height={320} draggable={false} /><figcaption>{t('workflowIllustration')}</figcaption></figure></section>
      </div>
      <footer><div className="vc-canvas-style-tools"><ui.Button size="sm" variant="ghost" disabled={!!editing || save.saving} onClick={() => { void finish(onProfile) }}>{t('workflowFullProfile')}</ui.Button><ui.Button size="sm" variant="ghost" onClick={onReferences}>{t('workflowCurrentReferences')}</ui.Button></div><ui.Button variant="primary" disabled={!!editing || save.saving || save.failed || disabled} onClick={() => { void finish(() => onSearch(notes)) }}>{t('workflowNewSearch')}</ui.Button></footer>
    </aside></div>

  }
}
