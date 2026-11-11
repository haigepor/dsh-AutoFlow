/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Human-only scope editing keeps reference revisions separate from saved analysis. */
import type { ImageView, StyleView } from './contract.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import type { CuratorStore } from './store.ts'
import { dimensions } from './workbench-actions.ts'

/** @param React Host React runtime. @param ui Existing native form primitives. @returns Explicit role and dimension editor with retryable write identity. */
export function createReferenceEditor(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function ReferenceEditor({ image, style, actions, t, onClose }: { image: ImageView; style: StyleView; actions: Pick<CuratorStore, 'execute'>; t: WorkbenchText; onClose(): void }) {
    const [role, setRole] = React.useState(image.role ?? 'undecided'), [intent, setIntent] = React.useState(image.intent ?? 'overall')
    const [selected, setSelected] = React.useState(image.dimensions ?? []), [comment, setComment] = React.useState('')
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(false)
    const request = React.useRef<{ value: string; operationId: string } | null>(null), reasonId = React.useId(), roleId = React.useId(), scopeId = React.useId()
    const roleHint = { positive: 'referenceEditPositiveHint', negative: 'referenceEditNegativeHint', undecided: 'referenceEditUndecidedHint' } as const
    const save = async () => {
      if (!image.referenceId) return
      const value = { styleId: style.styleId, expectedRevision: style.revision, referenceId: image.referenceId, role, intent: intent === 'overall' ? { kind: 'overall' } : { kind: 'dimensions', dimensions: selected }, ...(comment.trim() ? { comment: comment.trim() } : {}) }
      const serialized = JSON.stringify(value)
      if (request.current?.value !== serialized) request.current = { value: serialized, operationId: `reference-edit:${crypto.randomUUID()}` }
      setBusy(true); setError(false)
      try { await actions.execute('reference-edit', { ...value, operationId: request.current.operationId }); onClose() }
      catch (error) { setError(true) } // The store reports the structured failure; retain this editor for correction or retry.
      finally { setBusy(false) }
    }
    return <ui.Modal open title={t('referenceEditTitle')} closeLabel={t('close')} className="vc-reference-editor-modal" contentClassName="vc-reference-editor-content" onClose={() => { if (!busy) onClose() }} footer={<div className="vc-reference-editor-footer"><ui.Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</ui.Button><ui.Button variant="primary" disabled={busy || !image.referenceId || intent === 'dimensions' && !selected.length} onClick={() => { void save() }}>{busy && <ui.StateDot state="ongoing" />}{t(busy ? 'busy' : 'saveAdjustment')}</ui.Button></div>}>
      <div className="vc-reference-editor">
        <div className="vc-reference-editor-file"><div><span>{t('referenceEditImage')}</span><p className="vc-image-name" title={image.name}>{image.name.split(/[\\/]/).at(-1)}</p></div><ui.Tag>{image.width} × {image.height}</ui.Tag></div>
        <fieldset disabled={busy}><legend>{t('referenceEditRole')}</legend><ui.SegmentedControl id={roleId} label={t('referenceEditRole')} value={role} options={(['positive', 'negative', 'undecided'] as const).map(value => ({ value, label: t(value) }))} onChange={setRole} disabled={busy} className="vc-reference-editor-segments" />
          {(['positive', 'negative', 'undecided'] as const).map(value => <p key={value} id={`${roleId}-${value}-panel`} role="tabpanel" aria-labelledby={`${roleId}-${value}`} hidden={role !== value} className="vc-reference-editor-hint">{t(roleHint[value])}</p>)}
        </fieldset>
        <fieldset disabled={busy}><legend>{t('referenceEditScope')}</legend><ui.SegmentedControl id={scopeId} label={t('referenceEditScope')} value={intent} options={[{ value: 'overall', label: t('referenceEditOverall') }, { value: 'dimensions', label: t('referenceEditDimensions') }]} onChange={setIntent} disabled={busy} className="vc-reference-editor-segments" />
          <p id={`${scopeId}-overall-panel`} role="tabpanel" aria-labelledby={`${scopeId}-overall`} hidden={intent !== 'overall'} className="vc-reference-editor-hint">{t('referenceEditOverallHint')}</p>
          <div id={`${scopeId}-dimensions-panel`} role="tabpanel" aria-labelledby={`${scopeId}-dimensions`} hidden={intent !== 'dimensions'}>
            <div className="vc-reference-editor-dimension-heading"><span>{t('referenceEditDimensionsHint')}</span><span role="status">{t('referenceEditSelected').replace('{count}', String(selected.length))}</span></div>
            <div className="vc-reference-editor-dimensions">{dimensions.map(dimension => <ui.Checkbox key={dimension} checked={selected.includes(dimension)} onChange={checked => setSelected(current => checked ? [...current, dimension] : current.filter(value => value !== dimension))} label={t(dimension)} disabled={busy} />)}</div>
            {!selected.length && <p className="vc-reference-editor-required" role="status">{t('referenceEditRequired')}</p>}
          </div>
        </fieldset>
        <div className="vc-reference-editor-reason"><label htmlFor={reasonId}>{t('referenceEditReason')}</label><ui.TextArea id={reasonId} rows={3} maxLength={4096} value={comment} disabled={busy} placeholder={t('referenceEditReasonHint')} onChange={event => setComment(event.target.value)} /></div>
        <p className="vc-reference-editor-history">{t('referenceEditHistory')}</p>{error && <p role="alert" className="vc-notice">{t('referenceEditFailed')}</p>}
      </div>
    </ui.Modal>
  }
}
