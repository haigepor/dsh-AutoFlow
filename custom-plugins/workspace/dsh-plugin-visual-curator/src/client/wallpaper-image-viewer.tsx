/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Pixel-scale inspection keeps the image and its optional annotation slot in one transform. */
import type { WorkbenchText } from './workbench-locale.ts'
import { createSelectField } from './select-field.tsx'

/** Normalized annotation regions share the complete image axes; width and height identify the frozen output template. */
export interface WallpaperInspectionGuides {
  width: number; height: number; safe: { x: number; y: number; width: number; height: number };
  regions: ({ id: string; name: string; rect: WallpaperInspectionGuides['safe'] } & ({ layer: 'regions'; role: string } | { layer: 'defects' }))[];
}

/** @param rect Region normalized to the complete image. @param dimensions Selected image or template size. @returns Pixel coordinates rounded to two decimal places without changing saved geometry. */
export function wallpaperGuidePixels(rect: WallpaperInspectionGuides['safe'], dimensions: { width: number; height: number }) {
  return { x: Number((rect.x * dimensions.width).toFixed(2)), y: Number((rect.y * dimensions.height).toFixed(2)), width: Number((rect.width * dimensions.width).toFixed(2)), height: Number((rect.height * dimensions.height).toFixed(2)) }
}


/** @param React Shared renderer. @param ui Existing modal, controls and loading components. @returns A read-only image inspector with image-pixel zoom and pointer panning. */
export function createWallpaperImageViewer(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui)
  // Tick spacing follows screen pixels; values remain in the selected document's pixels.
  function rulerTicks(length: number, origin: number, pixelsPerUnit: number) {
    const rough = 80 / pixelsPerUnit, power = 10 ** Math.floor(Math.log10(rough))
    const major = (rough / power <= 1 ? 1 : rough / power <= 2 ? 2 : rough / power <= 5 ? 5 : 10) * power
    const step = major / 5, start = Math.ceil(-origin / pixelsPerUnit / step), end = Math.floor((length - origin) / pixelsPerUnit / step)
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => { const tick = start + offset; return { value: Number((tick * step).toFixed(2)), position: origin + tick * step * pixelsPerUnit, major: tick % 5 === 0 } })
  }
  type ViewerProps = {
    src: string; label: string; annotated?: boolean; guides?: WallpaperInspectionGuides | undefined; dimensions?: { width: number; height: number } | undefined; children?: import('react').ReactNode;
    navigation?: { previous?: (() => void) | undefined; next?: (() => void) | undefined; label: string } | undefined;
    onClose(): void; onSave(): void; onContextMenu?: ((event: import('react').MouseEvent<HTMLDivElement>) => void) | undefined; t: WorkbenchText;
  }
  function ImageInspection({ src, label, dimensions, annotated = false, guides, children, navigation, onSave, onContextMenu, t }: ViewerProps) {
    const [frame, setFrame] = React.useState<HTMLDivElement | null>(null)
    const [viewport, measure] = React.useState({ width: 0, height: 0 })
    const [natural, loaded] = React.useState<{ width: number; height: number }>()
    const [error, failed] = React.useState(false), [reload, retry] = React.useState(0)
    const [zoom, setZoom] = React.useState<number | 'fit'>('fit'), [pan, setPan] = React.useState({ x: 0, y: 0 })
    const [safe, showSafe] = React.useState(annotated), [regions, showRegions] = React.useState(annotated), [defects, showDefects] = React.useState(annotated)
    const [coordinates, showCoordinates] = React.useState(annotated && !!guides)
    const [basis, setBasis] = React.useState<'image' | 'template'>('image')
    const [selectedGuide, selectGuide] = React.useState('safe')
    const [cursor, setCursor] = React.useState<{ x: number; y: number }>()
    const drag = React.useRef<{ pointer: number; x: number; y: number; panX: number; panY: number }>()
    const size = natural ?? dimensions
    const coordinateSize = coordinates && basis === 'template' ? guides : size
    const guideRows = guides ? [{ id: 'safe', name: t('wallpaperInspectorSafe'), rect: guides.safe, layer: 'safe' as const }, ...guides.regions] : []
    const selected = guideRows.find(guide => guide.id === selectedGuide)
    const fit = size && viewport.width && viewport.height ? Math.max(0.01, Math.min((viewport.width - (coordinates ? 112 : 48)) / size.width, (viewport.height - (coordinates ? 112 : 48)) / size.height, 1)) : 1
    const scale = zoom === 'fit' ? fit : zoom
    const origin = { x: viewport.width / 2 + pan.x - (size?.width ?? 0) * scale / 2, y: viewport.height / 2 + pan.y - (size?.height ?? 0) * scale / 2 }
    const pixels = selected && coordinateSize ? wallpaperGuidePixels(selected.rect, coordinateSize) : undefined
    const endPixels = selected && coordinateSize ? wallpaperGuidePixels({ ...selected.rect, x: selected.rect.x + selected.rect.width, y: selected.rect.y + selected.rect.height }, coordinateSize) : undefined
    const selectedVisible = selected && (selected.layer === 'safe' ? safe : selected.layer === 'regions' ? regions : defects)
    const bounds = size && selected ? { x: origin.x + selected.rect.x * size.width * scale, y: origin.y + selected.rect.y * size.height * scale, width: selected.rect.width * size.width * scale, height: selected.rect.height * size.height * scale } : undefined
    const cursorPixels = cursor && size ? { x: Number(((cursor.x - origin.x) / scale * (coordinateSize?.width ?? size.width) / size.width).toFixed(2)), y: Number(((cursor.y - origin.y) / scale * (coordinateSize?.height ?? size.height) / size.height).toFixed(2)) } : undefined
    const selectRegion = (id: string) => {
      const guide = guideRows.find(guide => guide.id === id)
      if (!guide) return
      selectGuide(id)
      setCursor(undefined)
      if (size && zoom !== 'fit') setPan({ x: (0.5 - guide.rect.x - guide.rect.width / 2) * size.width * scale, y: (0.5 - guide.rect.y - guide.rect.height / 2) * size.height * scale })
      if (guide.layer === 'safe') showSafe(true); else if (guide.layer === 'regions') showRegions(true); else showDefects(true)
    }
    const changeZoom = (value: number, point = { x: viewport.width / 2, y: viewport.height / 2 }) => {
      setCursor(undefined)
      const next = Math.max(0.05, Math.min(4, value))
      const x = point.x - viewport.width / 2, y = point.y - viewport.height / 2
      setPan({ x: x - (x - pan.x) * next / scale, y: y - (y - pan.y) * next / scale }); setZoom(next)
    }
    const wheel = React.useRef<(event: WheelEvent) => void>(() => {})
    wheel.current = event => {
      event.preventDefault(); event.stopPropagation()
      if (!frame) return
      const bounds = frame.getBoundingClientRect()
      changeZoom(scale * Math.exp(-event.deltaY * 0.002), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    }
    // Percentages require the viewport's actual CSS dimensions, including modal and window resizing.
    React.useEffect(() => {
      if (!frame) return
      const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect) { setCursor(undefined); measure({ width: rect.width, height: rect.height }) } })
      observer.observe(frame)
      frame.focus({ preventScroll: true })
      const onWheel = (event: WheelEvent) => wheel.current(event)
      frame.addEventListener('wheel', onWheel, { passive: false })
      return () => { observer.disconnect(); frame.removeEventListener('wheel', onWheel) }
    }, [frame])
    const reset = () => { setCursor(undefined); setZoom('fit'); setPan({ x: 0, y: 0 }) }
    const actualSize = () => { setCursor(undefined); setZoom(1); setPan({ x: 0, y: 0 }) }
    const documentStyle: import('react').CSSProperties & { '--vc-inspector-scale': number } = { '--vc-inspector-scale': scale, width: size?.width, height: size?.height, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})` }
    return <>
      <div className="vc-image-inspector-toolbar" role="toolbar" aria-label={t('wallpaperInspectorTools')}>
        <div className="vc-image-inspector-tools vc-inspector-view-tools"><ui.Button size="sm" variant={zoom === 'fit' ? 'outline' : 'ghost'} onClick={reset}><ui.IconFullscreenOutlineRegular size={14} />{t('wallpaperInspectorFit')}</ui.Button><ui.Button size="sm" variant={scale === 1 ? 'outline' : 'ghost'} onClick={actualSize}>{t('wallpaperInspectorActual')}</ui.Button><span className="vc-inspector-tool-separator" aria-hidden="true" />
        <ui.ZoomControls className="vc-image-inspector-zoom" zoom={scale} visible fit={{ label: t('wallpaperInspectorFit'), selected: zoom === 'fit', onSelect: reset }} labels={{ controls: t('wallpaperInspectorZoom'), menu: t('wallpaperInspectorZoom'), out: t('directCropZoomOut'), into: t('directCropZoomIn'), value: percent => `${percent}%` }} onZoom={changeZoom} onActiveChange={() => {}} />
        </div>
        <div className="vc-image-inspector-tools">{guides && <ui.Button size="sm" variant={coordinates ? 'outline' : 'ghost'} aria-pressed={coordinates} onClick={() => { setCursor(undefined); showCoordinates(value => !value) }}>{t('wallpaperCoordinates')}</ui.Button>}{navigation && <><ui.Button size="sm" variant="ghost" disabled={!navigation.previous} aria-label={t('wallpaperGalleryPrevious')} onClick={navigation.previous}><ui.IconChevronLeftOutlineRegular size={14} /></ui.Button><span>{navigation.label}</span><ui.Button size="sm" variant="ghost" disabled={!navigation.next} aria-label={t('wallpaperGalleryNext')} onClick={navigation.next}><ui.IconChevronRightOutlineRegular size={14} /></ui.Button></>}<ui.Tooltip portal label={t('wallpaperSaveImage')} side="bottom"><ui.Button size="sm" variant="ghost" aria-label={t('wallpaperSaveImage')} onClick={onSave}><ui.IconDownloadOutlineRegular size={16} /></ui.Button></ui.Tooltip></div>
      </div>
      {coordinates && guides && <div className="vc-inspector-measurement-tools" role="group" aria-label={t('wallpaperCoordinates')} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation() }} onTouchStart={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}>
        <div className="vc-inspector-measurement-options">
        <SelectField label={t('wallpaperCoordinateRegion')} value={selectedGuide} options={guideRows.map(guide => ({ value: guide.id, label: guide.name }))} onChange={selectRegion} />
        <div className="vc-coordinate-basis" role="group" aria-label={t('wallpaperCoordinateBasis')}><ui.Button size="sm" variant={basis === 'image' ? 'outline' : 'ghost'} aria-pressed={basis === 'image'} onClick={() => setBasis('image')}>{t('wallpaperCoordinateImage')}</ui.Button><ui.Button size="sm" variant={basis === 'template' ? 'outline' : 'ghost'} aria-pressed={basis === 'template'} onClick={() => setBasis('template')}>{t('wallpaperCoordinateTemplate')}</ui.Button></div>
        </div>
        <div className="vc-inspector-document-info"><span>{coordinateSize && `${coordinateSize.width} × ${coordinateSize.height} px`}</span><span>{t('wallpaperCoordinateOrigin')}</span>
        <ui.Tooltip portal label={t('wallpaperCoordinateEstimate')} side="bottom"><ui.Button size="sm" variant="ghost" aria-label={t('wallpaperCoordinateEstimate')}><ui.IconInfoOutlineRegular size={14} /></ui.Button></ui.Tooltip>
        </div>
      </div>}
      <div className="vc-image-inspector-workspace" data-rulers={coordinates || undefined}>
      {coordinates && coordinateSize && size && <><span className="vc-inspector-ruler-corner" aria-hidden="true">px</span>
        <svg className="vc-inspector-ruler vc-inspector-ruler-x" aria-label={t('wallpaperRulerX')}>
          {rulerTicks(viewport.width, origin.x, size.width * scale / coordinateSize.width).map(tick => <g key={tick.value} data-value={tick.value} transform={`translate(${tick.position},0)`}><path d={`M0 ${tick.major ? 14 : 20}V26`} />{tick.major && <text x="3" y="11">{tick.value}</text>}</g>)}
          {selectedVisible && bounds && <g className="vc-ruler-selection" data-layer={selected.layer}><path d={`M${bounds.x} 26v-8h${bounds.width}v8`} /></g>}
          {cursor && <path className="vc-ruler-cursor" d={`M${cursor.x} 0V26`} />}
        </svg>
        <svg className="vc-inspector-ruler vc-inspector-ruler-y" aria-label={t('wallpaperRulerY')}>
          {rulerTicks(viewport.height, origin.y, size.height * scale / coordinateSize.height).map(tick => <g key={tick.value} data-value={tick.value} transform={`translate(0,${tick.position})`}><path d={`M${tick.major ? 14 : 20} 0H26`} />{tick.major && <text transform="translate(11,-3) rotate(-90)">{tick.value}</text>}</g>)}
          {selectedVisible && bounds && <g className="vc-ruler-selection" data-layer={selected.layer}><path d={`M26 ${bounds.y}h-8v${bounds.height}h8`} /></g>}
          {cursor && <path className="vc-ruler-cursor" d={`M0 ${cursor.y}H26`} />}
        </svg></>}
      <div className="vc-image-inspector-stage" ref={setFrame} tabIndex={0} aria-label={t('wallpaperInspectorCanvas')} data-dragging={!!drag.current || undefined} onContextMenu={onContextMenu} onKeyDown={event => {
        if (event.key === 'Escape') return
        event.stopPropagation()
        if (event.key === '0') { event.preventDefault(); reset() }
        else if (event.key === '1') { event.preventDefault(); actualSize() }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(scale * 1.25) }
        else if (event.key === '-') { event.preventDefault(); changeZoom(scale / 1.25) }
        else if (event.key.toLowerCase() === 'g' && children) showSafe(value => !value)
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setCursor(undefined); const step = event.shiftKey ? 80 : 16; setPan(value => ({ x: value.x + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0), y: value.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0) })) }
      }} onTouchStart={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()} onDoubleClick={() => scale === 1 ? reset() : actualSize()} onPointerDown={event => {
        if (event.button !== 0 || !natural) return
        event.preventDefault(); setCursor(undefined); drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMove={event => {
        const start = drag.current
        if (start?.pointer === event.pointerId) { setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y }); return }
        if (!natural || event.pointerType === 'touch') return
        const rect = event.currentTarget.getBoundingClientRect(), point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        setCursor(point.x >= origin.x && point.x <= origin.x + natural.width * scale && point.y >= origin.y && point.y <= origin.y + natural.height * scale ? point : undefined)
      }} onPointerLeave={() => setCursor(undefined)} onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId) } }} onLostPointerCapture={() => { drag.current = undefined }}>
        {!natural && !error && <span className="vc-inspector-loading" role="status" aria-label={t('galleryPreviewLoading')}><ui.StateDot state="ongoing" /></span>}
        {error ? <div className="vc-inspector-loading" role="alert"><span>{t('galleryPreviewError')}</span><ui.Button size="sm" variant="outline" onClick={() => { failed(false); retry(value => value + 1) }}>{t('retry')}</ui.Button></div> : <div className="vc-image-inspector-document" data-loaded={!!natural || undefined} data-safe={safe} data-regions={regions} data-defects={defects} style={documentStyle}>
          <img key={`${src}:${reload}`} src={src} alt={label} draggable={false} decoding="async" onLoad={event => loaded({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => failed(true)} />{children}{coordinates && selectedVisible && selected && guides && <svg className="vc-review-overlay vc-inspector-selection" viewBox={`0 0 ${guides.width} ${guides.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x={selected.rect.x * guides.width} y={selected.rect.y * guides.height} width={selected.rect.width * guides.width} height={selected.rect.height * guides.height} /></svg>}
        </div>}
        {coordinates && natural && selectedVisible && bounds && pixels && endPixels && <svg className="vc-inspector-measurements" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-label={t('wallpaperCoordinates')} data-layer={selected.layer}>
          <g className="vc-inspector-dimension-lines"><path d={`M${bounds.x} ${bounds.y - 10}v-12m0 6h${bounds.width}m0 -6v12 M${bounds.x + bounds.width + 10} ${bounds.y}h12m-6 0v${bounds.height}m-6 0h12`} /></g>
          <g className="vc-inspector-dimension-labels">
            <text data-coordinate="position" x={bounds.x} y={bounds.y - 40}>X {pixels.x} · Y {pixels.y} px</text>
            <text data-coordinate="width" x={bounds.x + bounds.width / 2} y={bounds.y - 21} textAnchor="middle">W {pixels.width} px</text>
            <text data-coordinate="height" transform={`translate(${bounds.x + bounds.width + 30},${bounds.y + bounds.height / 2}) rotate(-90)`} textAnchor="middle">H {pixels.height} px</text>
            <text data-coordinate="end" x={bounds.x + bounds.width} y={bounds.y + bounds.height + 20} textAnchor="end">X₂ {endPixels.x} · Y₂ {endPixels.y} px</text>
          </g>
        </svg>}
        {cursor && cursorPixels && <svg className="vc-inspector-crosshair" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-label={t('wallpaperCursorPosition')}>
          <path d={`M${cursor.x} 0V${viewport.height}M0 ${cursor.y}H${viewport.width}`} />
          <text x={Math.min(Math.max(8, cursor.x + 14), Math.max(8, viewport.width - 180))} y={cursor.y > viewport.height - 32 ? cursor.y - 14 : cursor.y + 24}>X {cursorPixels.x} · Y {cursorPixels.y} px</text>
        </svg>}
      </div>
      </div>
      <footer className="vc-image-inspector-status"><div><output aria-label={t('wallpaperInspectorZoom')}>{Math.round(scale * 100)}%</output>{size && <span>{size.width} × {size.height} px</span>}<span>{t('wallpaperInspectorHint')}</span></div>{children && <div className="vc-image-inspector-layers"><ui.Checkbox label={t('wallpaperInspectorSafe')} checked={safe} onChange={showSafe} /><ui.Checkbox label={t('wallpaperInspectorRegions')} checked={regions} onChange={showRegions} /><ui.Checkbox label={t('wallpaperInspectorDefects')} checked={defects} onChange={showDefects} /></div>}</footer>
    </>
  }
  return function WallpaperImageViewer(props: ViewerProps) {
    return <ui.Modal open onClose={props.onClose} title={props.label} closeLabel={props.t('close')} className="vc-image-inspector-modal" contentClassName="vc-image-inspector-shell">
      <ImageInspection key={`${props.src}:${props.annotated === true}`} {...props} />
    </ui.Modal>
  }
}
