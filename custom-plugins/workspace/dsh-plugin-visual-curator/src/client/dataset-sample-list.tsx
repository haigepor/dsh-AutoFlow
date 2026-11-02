/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Frozen observations retain every loaded sample while only measured visible rows mount. */
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect, type VirtualItem } from '@tanstack/virtual-core'
import type { DatasetDetail } from '../shared/datasets.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'
import { createReferencePreview } from './reference-preview.tsx'

/** Measured row heights remain valid only at the recorded scroll-region width. */
export interface DatasetSampleLayout { width: number; items: VirtualItem[] }

/** @param React Host runtime. @param ui Existing primitives. @returns Variable-height observation rows; paging and scroll ownership stay with the detail dialog. */
export function createDatasetSampleList(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const ReferencePreview = createReferencePreview(React, ui)
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  return function DatasetSampleList({ detail, scrollRef, restoreOffset, layout, onLayout, t }: { detail: DatasetDetail; scrollRef: React.RefObject<HTMLDivElement>; restoreOffset(): number; layout: DatasetSampleLayout | undefined; onLayout(value: DatasetSampleLayout): void; t: WorkbenchText }) {
    const listRef = React.useRef<HTMLDivElement>(null), samples = React.useRef(detail.samples)
    samples.current = detail.samples
    const [, render] = React.useReducer((revision: number) => revision + 1, 0)
    const [margin, setMargin] = React.useState(0), width = React.useRef(0)
    const getScrollElement = React.useCallback(() => scrollRef.current, [scrollRef])
    const getItemKey = React.useCallback((index: number) => samples.current[index]!.referenceId, [])
    const virtualizer = React.useMemo(() => new Virtualizer<HTMLDivElement, HTMLElement>({ count: 0, getScrollElement, estimateSize: () => 500,
      initialOffset: restoreOffset, initialMeasurementsCache: layout?.width === scrollRef.current?.clientWidth ? layout?.items ?? [] : [], scrollToFn: elementScroll, observeElementOffset, observeElementRect }), [getScrollElement])
    virtualizer.setOptions({ ...virtualizer.options, count: detail.samples.length, getItemKey, scrollMargin: margin, overscan: 2, onChange: () => render() })
    React.useLayoutEffect(() => virtualizer._didMount(), [virtualizer])
    React.useLayoutEffect(() => () => onLayout({ width: width.current, items: virtualizer.takeSnapshot() }), [virtualizer])
    React.useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = restoreOffset() }, [virtualizer])
    React.useLayoutEffect(() => {
      virtualizer._willUpdate()
      const scroll = scrollRef.current, list = listRef.current
      if (!scroll || !list) return
      const next = list.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop
      if (Math.abs(next - margin) > 0.5) setMargin(next)
      if (width.current && width.current !== scroll.clientWidth) virtualizer.measure()
      width.current = scroll.clientWidth
    })
    return <div ref={listRef} className="vc-dataset-samples vc-dataset-samples-virtual" role="list" data-sample-total={detail.samples.length} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => {
        const sample = detail.samples[row.index]!
        return <div className="vc-dataset-sample-row" ref={virtualizer.measureElement} data-index={row.index} key={row.key} role="listitem" aria-posinset={row.index + 1} aria-setsize={detail.sampleTotal} style={{ transform: `translateY(${row.start - margin}px)` }}><article className="vc-dataset-sample" data-reference-id={sample.referenceId}>
          {sample.previewPath && sample.previewSize ? <ReferencePreview width={sample.previewSize.width} height={sample.previewSize.height} src={resource(sample.previewPath)} href={resource(sample.previewPath)} alt={sample.referenceId} refreshKey={0} t={t} /> : <div className="vc-dataset-preview-missing"><ui.IconFolderOpenOutlineRegular size={24} /><span>{t('datasetPreviewMissing')}</span></div>}
          <div className="vc-stack"><div className="vc-row"><ui.Tag>{t(sample.role)}</ui.Tag>{sample.observations.some(row => row.uncertain) && <ui.Tag tone="warning">{t('uncertain')}</ui.Tag>}</div><code className="vc-dataset-id">{sample.referenceId}</code>{sample.observations.length ? sample.observations.map((observation, index) => <p key={index}><strong>{observation.field}</strong> · {observation.uncertain && <ui.Tag tone="warning">{t('uncertain')}</ui.Tag>}{typeof observation.value === 'string' ? observation.value : JSON.stringify(observation.value)}</p>) : <p>{t('datasetNoObservations')}</p>}</div>
        </article></div>
      })}
    </div>
  }
}
