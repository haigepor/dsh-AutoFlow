/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Graphical edits preserve scene evidence and commit source-normalized regions on release. */
import type { WallpaperPlan, WallpaperSettings } from '../shared/wallpaper.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createSelectField } from './select-field.tsx'
import { dragWallpaperPlan, editWallpaperRegion, wallpaperEditorImageSize } from './wallpaper-plan-editor-geometry.ts'

/** The caller owns persistence and supplies an already authorized absolute preview URL. */
export interface WallpaperPlanEditorProps {
  plan: WallpaperPlan
  settings: WallpaperSettings
  source: { width: number; height: number; previewPath: string }
  onChange(plan: WallpaperPlan): void
  t: WorkbenchText
  disabled?: boolean
}
type Drag = { pointerId: number; x: number; y: number; plan: WallpaperPlan; region?: number; resize: boolean }

/** @param React Shared application runtime. @param ui Existing form and button primitives. @returns A template-aligned editor whose pointer moves stay in a local draft. */
export function createWallpaperPlanEditor(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui)
  function NumberField({ label, value, change, step = 'any', min, max }: { label: string; value: number; change(value: number): void; step?: string; min?: number; max?: number }) {
    const [text, setText] = React.useState(String(value))
    React.useEffect(() => setText(String(value)), [value])
    return <label className="vc-plan-editor-field"><span>{label}</span><input type="number" step={step} min={min} max={max} value={text} onChange={event => setText(event.currentTarget.value)} onBlur={() => {
      const number = Number(text)
      if (text.trim() && Number.isFinite(number)) { setText(String(value)); change(number) }
      else setText(String(value))
    }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} /></label>
  }
  return function WallpaperPlanEditor({ plan, settings, source, onChange, t, disabled = false }: WallpaperPlanEditorProps) {
    const [draft, setDraft] = React.useState(plan), current = React.useRef(plan), drag = React.useRef<Drag | null>(null)
    const [selected, setSelected] = React.useState<number | null>(null), [failed, setFailed] = React.useState(false), [retry, setRetry] = React.useState(0)
    const svg = React.useRef<SVGSVGElement>(null), id = React.useId().replace(/:/g, '')
    React.useEffect(() => { drag.current = null; current.current = plan; setDraft(plan); setSelected(value => value !== null && value < plan.regions.length ? value : null) }, [plan])
    React.useEffect(() => { if (disabled) { drag.current = null; current.current = plan; setDraft(plan) } }, [disabled, plan])
    React.useEffect(() => setFailed(false), [source.previewPath])
    const local = (next: WallpaperPlan) => { current.current = next; setDraft(next) }
    const commit = (next: WallpaperPlan) => { if (disabled) return; local(next); onChange(next) }
    const point = (event: { clientX: number; clientY: number }) => {
      const element = svg.current, matrix = element?.getScreenCTM()
      if (!element || !matrix) return null
      const at = element.createSVGPoint(); at.x = event.clientX; at.y = event.clientY
      return at.matrixTransform(matrix.inverse())
    }
    const begin = (event: import('react').PointerEvent<SVGElement>, region?: number, resize = false) => {
      if (disabled || failed || drag.current || event.button !== 0) return
      const at = point(event)
      if (!at) return
      event.preventDefault(); event.stopPropagation()
      svg.current?.focus({ preventScroll: true }); svg.current?.setPointerCapture(event.pointerId)
      setSelected(region ?? null)
      drag.current = { pointerId: event.pointerId, x: at.x, y: at.y, plan: current.current, ...(region === undefined ? {} : { region }), resize }
    }
    const cancel = () => {
      const active = drag.current
      if (!active) return
      drag.current = null; local(active.plan)
      if (svg.current?.hasPointerCapture(active.pointerId)) svg.current.releasePointerCapture(active.pointerId)
    }
    const finish = (event: import('react').PointerEvent<SVGSVGElement>) => {
      const active = drag.current
      if (!active || active.pointerId !== event.pointerId) return
      drag.current = null
      if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId)
      if (current.current !== active.plan && !disabled) onChange(current.current)
    }
    const size = wallpaperEditorImageSize(source, draft), placement = draft.placement, region = selected === null ? undefined : draft.regions[selected]
    const roleKeys = { subject: 'wallpaperEditorSubject', critical: 'wallpaperEditorCritical', anchor: 'wallpaperEditorAnchor' } as const
    const editRegion = (patch: Partial<WallpaperPlan['regions'][number]>) => {
      if (selected === null) return
      commit({ ...draft, regions: draft.regions.map((value, index) => index === selected ? { ...value, ...patch } : value) })
    }
    const setPlacement = (patch: Partial<WallpaperPlan['placement']>) => commit({ ...draft, placement: { ...placement, ...patch } })
    return <div className="vc-plan-editor" data-disabled={disabled || undefined} onKeyDown={event => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel() } }}>
      <div className="vc-plan-editor-preview">
        <svg ref={svg} role="group" tabIndex={0} aria-label={t('wallpaperEditorTitle')} aria-describedby={`${id}-help`} viewBox={`0 0 ${settings.width} ${settings.height}`} preserveAspectRatio="xMidYMid meet"
          onPointerMove={event => {
            const active = drag.current
            if (!active || active.pointerId !== event.pointerId) return
            const at = point(event)
            if (!at) return
            local(dragWallpaperPlan(active.plan, source, { x: at.x - active.x, y: at.y - active.y }, active.region, active.resize))
          }} onPointerUp={finish} onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancel() }} onLostPointerCapture={() => { if (drag.current) cancel() }}>
          <rect width={settings.width} height={settings.height} fill="transparent" onPointerDown={event => begin(event)} />
          <image key={`${source.previewPath}:${retry}`} className="vc-plan-editor-image" href={source.previewPath} x={placement.left} y={placement.top} width={size.width} height={size.height} preserveAspectRatio="none" onPointerDown={event => begin(event)} onError={() => { cancel(); setFailed(true) }} onLoad={() => setFailed(false)} />
          <g className="vc-plan-editor-guides" fill="none" strokeWidth={2}>
            <rect className="vc-plan-editor-clock" width={settings.width} height={settings.safe.top} />
            <rect className="vc-plan-editor-safe" x={settings.safe.left} y={settings.safe.top} width={settings.safe.width} height={settings.safe.height} />
            <rect className="vc-plan-editor-overflow" x={settings.safe.left - settings.sideOverflow} y={settings.safe.top + settings.topBuffer} width={settings.safe.width + 2 * settings.sideOverflow} height={settings.safe.height + settings.bottomOverflow - settings.topBuffer} />
            <rect className="vc-plan-editor-buffer" y={settings.safe.top} width={settings.width} height={settings.topBuffer} />
            <path className="vc-plan-editor-safe-lines" vectorEffect="non-scaling-stroke" d={`M${settings.safe.left} 0V${settings.height}M${settings.safe.left + settings.safe.width} 0V${settings.height}M0 ${settings.safe.top}H${settings.width}M0 ${settings.safe.top + settings.safe.height}H${settings.width}`} />
            <path className="vc-plan-editor-guide" vectorEffect="non-scaling-stroke" d={`M${settings.width / 2} 0V${settings.height}M0 ${settings.height / 2}H${settings.width}M0 ${settings.safe.top + settings.topBuffer}H${settings.width}`} />
          </g>
          {draft.regions.map((value, index) => {
            const x = placement.left + value.rect.x * size.width, y = placement.top + value.rect.y * size.height, width = value.rect.width * size.width, height = value.rect.height * size.height
            return <g key={index}>
              <rect className="vc-plan-editor-region" data-role={value.role} data-selected={selected === index || undefined} role="button" tabIndex={disabled ? -1 : 0} aria-label={`${value.name} · ${t(roleKeys[value.role])}`} aria-pressed={selected === index} vectorEffect="non-scaling-stroke" x={x} y={y} width={width} height={height} onPointerDown={event => begin(event, index)} onFocus={() => setSelected(index)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(index) } }} />
              <text className="vc-plan-editor-label" x={x + 10} y={y + 40}>{index + 1}. {value.name}</text>
              {selected === index && !disabled && <rect className="vc-plan-editor-handle" vectorEffect="non-scaling-stroke" x={x + width - 22} y={y + height - 22} width={44} height={44} onPointerDown={event => begin(event, index, true)} />}
            </g>
          })}
        </svg>
        <p className="vc-plan-editor-help" id={`${id}-help`}>{t('wallpaperEditorHelp')}</p>
        <div className="vc-plan-editor-legend"><ui.Tag tone="success">{t('wallpaperEditorSafe')}</ui.Tag><ui.Tag tone="danger">{t('wallpaperEditorClock')}</ui.Tag><ui.Tag tone="warning">{t('wallpaperEditorBuffer')}</ui.Tag><ui.Tag>{t('wallpaperEditorCenter')}</ui.Tag><ui.Tag>{t('wallpaperEditorOverflow')}</ui.Tag></div>
        <p className="vc-plan-editor-help">{t('wallpaperEditorOverflowHelp')}</p>
        {failed && <div className="vc-plan-editor-error" role="alert"><p>{t('wallpaperEditorImageFailed')}</p><ui.Button size="sm" variant="outline" onClick={() => { setFailed(false); setRetry(value => value + 1) }}>{t('wallpaperEditorRetryImage')}</ui.Button></div>}
      </div>
      <div className="vc-plan-editor-controls">
        <fieldset disabled={disabled}><legend>{t('wallpaperEditorPlacement')}</legend><div className="vc-plan-editor-fields">
          <NumberField label={t('wallpaperEditorLeft')} value={placement.left} step="1" change={left => setPlacement({ left: Math.round(left) })} />
          <NumberField label={t('wallpaperEditorTop')} value={placement.top} step="1" change={top => setPlacement({ top: Math.round(top) })} />
          <NumberField label={t('wallpaperEditorScale')} value={placement.scale} min={Number.EPSILON} max={1} step="0.01" change={scale => setPlacement({ scale: Math.max(Number.EPSILON, Math.min(1, scale)) })} />
        </div><small className="vc-plan-editor-help">{t('wallpaperEditorNoUpscale')}</small></fieldset>
        <fieldset disabled={disabled}><legend>{t('wallpaperEditorRegions')} · {draft.regions.length} / 32</legend>
          <SelectField label={t('wallpaperEditorRegions')} value={selected === null ? '' : String(selected)} options={[{ value: '', label: t('wallpaperEditorNoRegion') }, ...draft.regions.map((value, index) => ({ value: String(index), label: `${index + 1}. ${value.name} · ${t(roleKeys[value.role])}` }))]} disabled={disabled} onChange={value => setSelected(value === '' ? null : Number(value))} />
          {region ? <>
            <label className="vc-plan-editor-field"><span>{t('wallpaperEditorRegionName')}</span><input key={`${selected}:${region.name}`} defaultValue={region.name} maxLength={4096} onBlur={event => { const name = event.currentTarget.value.trim(); if (name) editRegion({ name }); else event.currentTarget.value = region.name }} /></label>
            <SelectField label={t('wallpaperEditorRole')} value={region.role} options={(['subject', 'critical', 'anchor'] as const).map(value => ({ value, label: t(roleKeys[value]) }))} disabled={disabled} onChange={role => { if (role === 'subject' || role === 'critical' || role === 'anchor') editRegion({ role }) }} />
            <div className="vc-plan-editor-fields">{(['x', 'y', 'width', 'height'] as const).map(key => <NumberField key={key} label={t(({ x: 'wallpaperEditorX', y: 'wallpaperEditorY', width: 'wallpaperEditorWidth', height: 'wallpaperEditorHeight' } as const)[key])} value={region.rect[key]} min={key === 'width' || key === 'height' ? Number.EPSILON : 0} max={1} step="0.001" change={value => editRegion({ rect: editWallpaperRegion(region.rect, { [key]: value }) })} />)}</div>
          </> : <p className="vc-plan-editor-help">{t('wallpaperEditorNoRegion')}</p>}
          <div className="vc-plan-editor-actions"><ui.Button size="sm" variant="outline" disabled={disabled || draft.regions.length >= 32} onClick={() => {
            const index = draft.regions.length
            commit({ ...draft, regions: [...draft.regions, { name: t('wallpaperEditorNewRegion').replace('{number}', String(index + 1)), role: 'critical', rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }] }); setSelected(index)
          }}>{t('wallpaperEditorAddRegion')}</ui.Button><ui.Button size="sm" variant="ghost" disabled={disabled || selected === null} onClick={() => { commit({ ...draft, regions: draft.regions.filter((_value, index) => index !== selected) }); setSelected(null) }}>{t('wallpaperEditorDeleteRegion')}</ui.Button></div>
        </fieldset>
        {(draft.mode === 'uncertain' || draft.uncertainties.length > 0) && <p role="status" className="vc-plan-editor-error">{t('wallpaperEditorUncertainties')}</p>}
        <details className="vc-plan-editor-evidence"><summary>{t('wallpaperEditorEvidence')}</summary><p>{draft.subject}</p><p>{draft.evidence}</p><p>{draft.reason}</p><ul>{[...draft.priorities, ...draft.anchors, ...draft.truncations, ...draft.uncertainties].map((value, index) => <li key={index}>{value}</li>)}</ul></details>
      </div>
    </div>
  }
}
