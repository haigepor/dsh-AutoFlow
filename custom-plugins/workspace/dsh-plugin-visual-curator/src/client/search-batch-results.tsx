/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Matched images remain grouped by their original task batch within one collection. */
import type { SearchBatchesState, SearchBatchesStore } from './search-batches-store.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'
import { createSelectField } from './select-field.tsx'
import { createImageGallery } from './image-gallery.tsx'
import { createReferencePreview } from './reference-preview.tsx'

interface Props { styleId: string; t: WorkbenchText; useBatches<T>(select: (state: SearchBatchesState) => T): T; actions: Pick<SearchBatchesStore, 'watch' | 'select' | 'refresh' | 'more' | 'moreImages' | 'remove'>; onOpen(runId: string, sessionId?: string): Promise<void> }

/** @param React Shared runtime. @returns Decorative batch placeholders using the existing loading tokens and caller-owned accessible label. */
export function createSearchBatchSkeleton(React: typeof import('react')) {
  return function SearchBatchSkeleton({ label }: { label: string }) { return <div className="vc-search-batch-list" role="status" aria-label={label}>{[0, 1, 2].map(index => <div className="vc-search-batch vc-search-batch-skeleton" key={index} aria-hidden="true">
          <div className="vc-search-batch-header"><div className="vc-search-batch-identity"><span className="vc-skeleton-fill vc-search-batch-skeleton-title" /><span className="vc-skeleton-fill vc-search-batch-skeleton-date" /></div><span className="vc-skeleton-fill vc-search-batch-skeleton-action" /></div>
          <span className="vc-skeleton-fill vc-search-batch-skeleton-brief" />
          <div className="vc-image-grid vc-results">{[0, 1].map(image => <div className="vc-result-card" key={image}><span className="vc-skeleton-fill vc-search-batch-skeleton-image" /><div className="vc-result-meta"><span className="vc-skeleton-fill vc-search-batch-skeleton-tag" /><span className="vc-skeleton-fill vc-search-batch-skeleton-tag" /></div></div>)}</div>
        </div>)}</div> }
}

/** @param React Shared runtime. @param ui Native controls. @returns Collection-scoped batch gallery with all batches selected initially. */
export function createSearchBatchResults(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui), ImageGallery = createImageGallery(React, ui), BatchSkeleton = createSearchBatchSkeleton(React), ReferencePreview = createReferencePreview(React, ui)
  function BatchResults({ styleId, t, useBatches, actions, onOpen }: Props) {
    const state = useBatches(value => value), page = state.styleId === styleId ? state.page : null
    const initialLoading = !page && (state.styleId !== styleId || !state.error)
    const [preview, setPreview] = React.useState<{ batchId: string; imageId: string } | null>(null)
    const closePreview = React.useCallback(() => setPreview(null), [])
    const [opening, setOpening] = React.useState(''), [openError, setOpenError] = React.useState(false)
    const [notice, setNotice] = React.useState<{ id: number; success: boolean } | null>(null)
    const noticeId = React.useRef(0)
    const [previewRefresh, setPreviewRefresh] = React.useState(0)
    const remove = async (runId: string) => {
      try { await actions.remove(runId); setNotice({ id: ++noticeId.current, success: true }) }
      catch (error) { setNotice({ id: ++noticeId.current, success: false }) }
    }
    // 同步恢复已看过的分组，避免缓存命中时仍先绘制一帧空列表。
    React.useLayoutEffect(() => actions.watch(styleId), [actions, styleId])
    const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : undefined }
    const previewBatch = page?.batches.find(batch => batch.runId === preview?.batchId)
    return <section className="vc-search-batches" aria-label={t('taskBatchResults')} aria-busy={state.loading || initialLoading}>
      <header className="vc-search-batches-toolbar"><div className="vc-search-batches-summary"><span>{t('taskPreviewMatched')} <strong>{page ? page.totalMatches : initialLoading ? <span className="vc-skeleton-fill vc-search-batches-count" aria-hidden="true" /> : '—'}</strong></span><small>{t('taskBatchCount')} {page ? page.totalBatches : initialLoading ? <span className="vc-skeleton-fill vc-search-batches-count" aria-hidden="true" /> : '—'}</small></div><div className="vc-search-batches-actions">
        <SelectField label={t('taskBatchFilter')} value={state.batchId} options={[{ value: '', label: t('taskAllBatches') }, ...(page?.batches.map(batch => ({ value: batch.runId, label: `${new Date(batch.createdAt).toLocaleString()} · ${t(batch.kind === 'crop' ? 'cropKind' : 'searchKind')} · ${batch.runId.slice(0, 8)}` })) ?? [])]} disabled={initialLoading || state.deleting.length > 0} onChange={actions.select} />
        <ui.Button size="sm" variant="ghost" disabled={state.loading || state.deleting.length > 0} onClick={() => { setPreviewRefresh(value => value + 1); actions.refresh() }}><ui.IconRefreshOutlineRegular size={14} />{t('refresh')}</ui.Button>
      </div></header>
      {(state.error || openError) && <div className="vc-notice" role="alert">{t(openError ? 'taskScopeFailed' : 'taskBatchReadFailed')}</div>}
      <div className="vc-search-batches-scroll">
        {initialLoading && <BatchSkeleton label={t('taskBatchLoading')} />}
        <div className="vc-search-batch-list">{page?.batches.map(batch => <section className="vc-search-batch" key={batch.runId} data-search-batch={batch.runId}>
          <header className="vc-search-batch-header"><div className="vc-search-batch-identity"><div className="vc-search-batch-title">{batch.kind === 'crop' ? <ui.IconListPenOutlineRegular size={16} /> : <ui.IconSearchOutlineRegular size={16} />}<strong>{t(batch.kind === 'crop' ? 'cropKind' : 'searchKind')}</strong><ui.Tag tone={batch.status === 'completed' ? 'success' : batch.status === 'failed' ? 'danger' : 'neutral'}>{t(batch.status)}</ui.Tag></div><div className="vc-search-batch-meta"><time dateTime={batch.createdAt}>{new Date(batch.createdAt).toLocaleString()}</time></div></div><div className="vc-search-batch-actions"><ui.Tag tone="info">{t('taskPreviewMatched')} {batch.matched}</ui.Tag><ui.Button size="sm" variant="ghost" disabled={!!opening} onClick={() => { setOpening(batch.runId); setOpenError(false); void onOpen(batch.runId, batch.sessionId).catch(() => setOpenError(true)).finally(() => setOpening('')) }}>{opening === batch.runId && <ui.StateDot state="ongoing" />}{t('taskRunInformation')}<ui.IconChevronRightOutlineRegular size={12} /></ui.Button><ui.Tooltip portal label={t(['completed', 'failed', 'cancelled'].includes(batch.status) ? 'taskDeleteHint' : 'taskDeleteActive')}><ui.Button size="sm" variant="ghost" className="vc-search-batch-delete" aria-label={t('taskDelete')} disabled={!['completed', 'failed', 'cancelled'].includes(batch.status) || state.deleting.length > 0} aria-busy={state.deleting.includes(batch.runId) || undefined} onClick={() => { void remove(batch.runId) }}>{state.deleting.includes(batch.runId) ? <ui.StateDot state="ongoing" /> : <ui.IconTrashOutlineRegular size={14} />}</ui.Button></ui.Tooltip></div></header>
          {batch.taskBrief && <p className="vc-search-batch-brief">{batch.taskBrief}</p>}
          {batch.unavailable ? <p className="vc-search-batch-empty" role="status"><ui.IconInfoOutlineRegular size={16} />{t('taskBatchUnavailable')}</p> : <div className="vc-image-grid vc-results">{batch.images.map(image => {
            const path = resource(image.previewPath)
            return <figure className="vc-result-card" key={image.imageVersionId}>{path && <ReferencePreview src={resource(image.thumbnailPath ?? '') ?? path} href={path} alt={image.name} width={image.width} height={image.height} refreshKey={previewRefresh} t={t} onPreview={() => setPreview({ batchId: batch.runId, imageId: image.imageVersionId })} />}<figcaption className="vc-result-meta"><ui.Tag tone="success">{t('taskPreviewMatched')}</ui.Tag><small>{image.width} × {image.height}</small></figcaption></figure>
          })}</div>}
          {!batch.unavailable && !batch.images.length && <p className="vc-search-batch-empty">{t('taskBatchNoMatches')}</p>}
          {batch.nextImagePageToken && <ui.Button variant="outline" size="sm" disabled={state.loading} onClick={() => { void actions.moreImages(batch.runId) }}>{t('more')}</ui.Button>}
        </section>)}</div>
        {page && !page.batches.length && <p className="vc-task-empty">{t('taskBatchEmpty')}</p>}
        {page?.nextPageToken && <ui.Button variant="outline" disabled={state.loading} onClick={() => { void actions.more() }}>{t('taskMoreBatches')}</ui.Button>}
      </div>
      {notice && <ui.Toast key={notice.id} text={t(notice.success ? 'taskBatchDeleted' : 'taskBatchDeleteFailed')} {...(notice.success ? { tone: 'success' as const } : {})} onDone={() => setNotice(null)} />}
      <ImageGallery images={previewBatch?.images.flatMap(image => { const path = resource(image.previewPath); return path ? [{ id: image.imageVersionId, path, name: image.name }] : [] }) ?? []} selectedId={preview?.imageId ?? null} onSelect={imageId => { if (preview) setPreview({ ...preview, imageId }) }} onClose={closePreview} t={t} />
    </section>
  }
  return function SearchBatchResults(props: Props) { return <BatchResults key={props.styleId} {...props} /> }
}
