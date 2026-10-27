/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Collections open with no selection; explicit select-all enumerates remaining pages. */
import type { ConfigurationView, StyleView } from './contract.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import type { GalleryCollection, GalleryPage, GalleryPhoto } from '../shared/gallery.ts'
import { readCollectionPhotos, filterGalleryPhotos } from './gallery-reference.ts'
import { galleryTaskActive, galleryTaskProgress, type GalleryTaskView } from '../shared/gallery-task.ts'
import { createGalleryMedia, galleryImageSource } from './gallery-media.tsx'

interface Props {
  config: ConfigurationView; style: StyleView; role: 'positive' | 'negative'; actions: WorkbenchProps['actions']; t: WorkbenchText
  task: GalleryTaskView | undefined
  onClose(): void; onManageAccounts(): void
}

/** @param React Shell React runtime. @param ui Project-owned primitives. @returns Stable collection reference dialog. */
export function createGalleryReferenceDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Modal, Checkbox, Tag, StateDot, Input, Tooltip } = ui
  const { GallerySkeleton, GalleryPhotoPreview, GalleryLoadMore } = createGalleryMedia(React, ui)
  return function GalleryReferenceDialog({ config, style, role, actions, t, onClose, onManageAccounts, task }: Props) {
    const accounts = config.source.unsplash.accounts
    const [accountId, setAccountId] = React.useState(config.source.unsplash.defaultAccountId ?? accounts[0]?.id ?? '')
    const account = accounts.find(item => item.id === accountId)
    const [folders, setFolders] = React.useState<GalleryCollection[]>([]), [nextCursor, setNextCursor] = React.useState<string | null>(null)
    const [folder, setFolder] = React.useState<GalleryCollection | null>(null), [photos, setPhotos] = React.useState<GalleryPhoto[]>([])
    const [selected, setSelected] = React.useState<Set<string>>(new Set()), [page, setPage] = React.useState(0), [query, setQuery] = React.useState('')
    const [loading, setLoading] = React.useState(false), [saving, setSaving] = React.useState(false), [stopping, setStopping] = React.useState(false)
    const [appending, setAppending] = React.useState(false)
    const [enumerated, setEnumerated] = React.useState(false)
    const [photoCursor, setPhotoCursor] = React.useState<string | null>(null), [allIntent, setAllIntent] = React.useState(false)
    const [error, setError] = React.useState(''), [readCount, setReadCount] = React.useState(0)
    const request = React.useRef<AbortController | null>(null), prefetch = React.useRef<AbortController | null>(null), sequence = React.useRef(0), alive = React.useRef(true)
    const folderCursors = React.useRef(new Set<string>())
    const failedFolderCursor = React.useRef<string | null>(null)
    const heading = React.useRef<HTMLHeadingElement>(null)
    const content = React.useRef<HTMLElement>(null)
    const excluded = React.useRef(new Set<string>())
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; ++sequence.current; request.current?.abort(); prefetch.current?.abort() } }, [])
    const message = (failure: unknown) => {
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : ''
      if (code === 'source-request-timeout') return t('galleryRequestTimeout')
      if (code === 'source-dns-failed') return t('galleryDnsError')
      if (code === 'source-tls-failed') return t('galleryTlsError')
      if (code === 'source-network-failed' || code === 'source-response-incomplete') return t('galleryNetworkError')
      if (code === 'source-access-check' || code === 'source-access-denied') return t('galleryAccessError')
      return t(code === 'gallery-reference-limit' ? 'galleryReferenceLimit' : code === 'source-continuation-invalid' ? 'galleryPageChanged' : code === 'source-rate-limited' ? 'galleryRateLimited' : code === 'owner-denied' || code === 'source-auth-required' ? 'gallerySessionError' : 'galleryConnectionError')
    }
    const loadFolders = async (cursor: string | null = null) => {
      prefetch.current?.abort()
      request.current?.abort(); const controller = new AbortController(); request.current = controller; const version = ++sequence.current
      failedFolderCursor.current = cursor
      setLoading(true); setAppending(!!cursor); setEnumerated(false); setError(''); setFolder(null); setPhotos([]); setSelected(new Set()); if (!cursor) setQuery('')
      setPhotoCursor(null); setAllIntent(false)
      if (!cursor) { setFolders([]); setNextCursor(null); folderCursors.current.clear(); excluded.current.clear(); if (content.current) content.current.scrollTop = 0 }
      try {
        const data = await actions.galleryRead('gallery-collections', { accountId, cursor }, controller.signal) as GalleryPage<GalleryCollection>
        if (!alive.current || version !== sequence.current) return
        if (data.nextCursor && (data.nextCursor === cursor || folderCursors.current.has(data.nextCursor))) throw Object.assign(new Error('gallery-cursor-cycle'), { code: 'source-continuation-invalid' })
        if (cursor) folderCursors.current.add(cursor)
        setFolders(current => [...new Map([...(cursor ? current : []), ...data.items].map(item => [item.id, item])).values()]); setNextCursor(data.nextCursor)
      } catch (failure) { if (alive.current && !controller.signal.aborted && version === sequence.current) setError(message(failure)) }
      finally { if (alive.current && version === sequence.current) { setLoading(false); setAppending(false) } }
    }
    React.useEffect(() => { if (account) void loadFolders(); else { request.current?.abort(); prefetch.current?.abort(); ++sequence.current; setFolders([]); setFolder(null); setPhotos([]); setLoading(false) } }, [accountId, account?.userId, account?.credentialRef])
    const loadPhotos = async (value: GalleryCollection, all = false, append = false) => {
      request.current?.abort(); const controller = new AbortController(); request.current = controller; const version = ++sequence.current
      setAppending(append); setAllIntent(all); setFolder(value); setLoading(true); setError('')
      if (!append) {
        prefetch.current?.abort()
        excluded.current.clear(); setEnumerated(false); setPhotoCursor(null); setPhotos([]); setSelected(new Set()); setReadCount(0); setPage(0); setQuery('')
        if (content.current) content.current.scrollTop = 0
        heading.current?.focus({ preventScroll: true })
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.limits.deadlineMs)])
      try {
        let continuation: string | null = null
        const loaded = await readCollectionPhotos(async (cursor, signal) => await actions.galleryRead('gallery-photos', { accountId, scope: { kind: 'collection', collectionId: value.id }, cursor }, signal) as GalleryPage<GalleryPhoto>, { maxFiles: config.limits.maxGalleryReferenceFiles, signal, initialPhotos: append ? photos : [], cursor: append ? photoCursor : null, stopAfterPage: !all, retry: { attempts: config.source.unsplash.readRetryAttempts ?? 0, delayMs: config.source.unsplash.readRetryDelayMs ?? 0 }, onProgress: count => { if (alive.current && version === sequence.current) setReadCount(count) }, onPage: (photos, cursor) => {
          if (!alive.current || version !== sequence.current) return
          continuation = cursor
          setPhotos(photos); setPhotoCursor(cursor); setEnumerated(cursor === null)
          // 只有明确选择全选时才扩展选择；读取后续页不会覆盖用户逐张取消的图片。
          if (all) setSelected(new Set(photos.filter(photo => !excluded.current.has(photo.id)).map(photo => photo.id)))
        } })
        if (!all && continuation && loaded.length < config.limits.maxGalleryReferenceFiles && alive.current && version === sequence.current) {
          // 仅预读下一页元数据到现有共享缓存；滚动读取会复用同一请求，不递归预读或更改勾选。
          prefetch.current?.abort(); const warm = new AbortController(); prefetch.current = warm
          void actions.galleryRead('gallery-photos', { accountId, scope: { kind: 'collection', collectionId: value.id }, cursor: continuation }, AbortSignal.any([warm.signal, AbortSignal.timeout(config.limits.requestTimeoutMs)])).catch(error => { /* 预读失败不改变当前列表；滚动到该页时由正常读取显示错误与重试。 */ })
        }
      } catch (failure) { if (alive.current && !controller.signal.aborted && version === sequence.current) setError(message(failure)) }
      finally { if (alive.current && version === sequence.current) { setLoading(false); setAppending(false) } }
    }
    const activeTask = !!task && galleryTaskActive(task.status)
    const locked = saving || activeTask
    const addReferences = async () => {
      if (locked || uncertain || !selected.size || !account || !folder) return
      if (!actions.getSnapshot().snapshot?.collectionPaging) { setError(t('galleryReferenceUnavailable')); return }
      const photoIds = [...selected]
      // 提交点击时的明确选择；终止读页并隔离迟到响应，避免全选继续扩张本次任务。
      ++sequence.current; request.current?.abort(); prefetch.current?.abort(); setLoading(false); setAppending(false); setAllIntent(false)
      setSaving(true); setError('')
      try {
        await actions.startGalleryReferences({ operationId: crypto.randomUUID(), styleId: style.styleId, expectedRevision: actions.getSnapshot().snapshot?.styles.find(item => item.styleId === style.styleId)?.revision ?? style.revision, accountId, role, photoIds })
        if (alive.current) setSelected(new Set())
      } catch (failure) { if (alive.current) setError(t('importUnknown')) }
      finally { if (alive.current) setSaving(false) }
    }
    const uncertain = task?.status === 'needs-review'
    const eligible = photos
    const filteredFolders = folders.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    const filteredPhotos = React.useMemo(() => filterGalleryPhotos(photos, query), [photos, query])
    const visiblePhotos = filteredPhotos.slice(0, (page + 1) * config.limits.pageSize)
    const toggle = (id: string, enabled: boolean) => { if (enabled) excluded.current.delete(id); else excluded.current.add(id); setSelected(current => { const next = new Set(current); if (enabled) next.add(id); else next.delete(id); return next }) }
    const clearSelection = () => {
      if (loading && allIntent) { ++sequence.current; request.current?.abort(); prefetch.current?.abort(); setLoading(false); setAppending(false) }
      setAllIntent(false); excluded.current.clear(); setSelected(new Set())
    }
    const selectAll = () => {
      if (!folder) return
      excluded.current.clear(); setSelected(new Set(eligible.map(photo => photo.id))); setAllIntent(true)
      if (!enumerated) void loadPhotos(folder, true, photos.length > 0)
    }
    return <Modal open onClose={onClose} closeOnBackdropClick={false} title={t('galleryReference')} description={activeTask || saving ? t('galleryBackgroundHint') : t('galleryReferenceHint')} closeLabel={t('close')} className="vc-gallery-reference-modal" contentClassName="vc-gallery-reference-frame" footer={<div className="vc-gallery-reference-footer">
      <div role="status" aria-live="polite">{activeTask && task ? <><StateDot state="ongoing" />{t('galleryTaskRunning')} {galleryTaskProgress(task).referenced} / {task.total}</> : <><span>{style.name}</span><Tag>{t(role)}</Tag>{folder && <span>{t('gallerySelected')} {selected.size} · {t('referenceLoaded')} {photos.length}</span>}</>}</div>
      {loading && folder && <Button size="sm" variant="outline" onClick={() => { ++sequence.current; request.current?.abort(); prefetch.current?.abort(); setLoading(false); setAppending(false); setEnumerated(false); setError(t('galleryReadCancelled')) }}>{t('galleryCancelRead')}</Button>}
      <Button size="sm" variant="outline" onClick={onClose}>{t('close')}</Button>
      {activeTask && task && <Button size="sm" variant="outline" disabled={stopping || task.status === 'cancelling'} onClick={() => { setStopping(true); void actions.stopGalleryReferences(task.id).catch(() => { if (alive.current) setError(t('galleryConnectionError')) }).finally(() => { if (alive.current) setStopping(false) }) }}>{t(task.status === 'cancelling' ? 'galleryStopping' : 'galleryStopImport')}</Button>}
      <Button size="sm" variant="primary" disabled={locked || !account || !folder || !selected.size || uncertain} onClick={() => { void addReferences() }}>{locked && <StateDot state="ongoing" />}{t(locked ? 'busy' : 'galleryImport')}{!locked && !!selected.size && (' ' + selected.size)}</Button>
    </div>}>
      <div className="vc-gallery-reference-layout">
        <nav className="vc-gallery-reference-accounts" aria-label={t('galleryChooseAccount')}><small>{t('galleryChooseAccount')}</small>{accounts.map(item => <Button key={item.id} size="sm" variant="ghost" className="vc-gallery-account" aria-pressed={item.id === accountId} disabled={locked} onClick={() => setAccountId(item.id)}><span className="vc-gallery-avatar" aria-hidden="true">{(item.name || item.label).slice(0, 1)}</span><span><strong>{item.label}</strong><small>@{item.username}</small></span></Button>)}<Button size="sm" variant="ghost" disabled={locked} onClick={onManageAccounts}>{t('galleryManageAccounts')}<ui.IconChevronRightOutlineRegular size={12} /></Button></nav>
        <section ref={content} className="vc-gallery-reference-content" aria-busy={loading || saving}>
          <header className="vc-gallery-reference-heading">{folder && <Button size="sm" variant="ghost" disabled={locked} onClick={() => { void loadFolders() }}><ui.IconChevronLeftOutlineRegular size={12} />{t('galleryFolders')}</Button>}<h3 tabIndex={-1} ref={heading}>{folder?.title ?? account?.label ?? t('galleryFolders')}</h3>{!!accounts.length && <Input aria-label={t(folder ? 'galleryReferenceSearchLoaded' : 'galleryFilterFolders')} placeholder={t(folder ? 'galleryReferenceSearchLoaded' : 'galleryFilterFolders')} icon={<ui.IconSearchOutlineRegular size={14} />} value={query} disabled={locked || loading && !!folder} onChange={event => { setQuery(event.target.value); setPage(0) }} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />}</header>
          {error && <div className="vc-gallery-reference-error" role="alert"><StateDot state="warning" /><div><strong>{t(photos.length ? 'galleryReadMoreError' : 'galleryReadError')}</strong><p>{error}</p>{photos.length > 0 && <small>{t('referenceLoaded')} {photos.length} · {t('gallerySelectionRetained')}</small>}</div>{!activeTask && !saving && <Button size="sm" variant="outline" disabled={loading} onClick={() => { if (folder) void loadPhotos(folder, allIntent, photos.length > 0 && !enumerated); else void loadFolders(failedFolderCursor.current) }}><ui.IconRefreshOutlineRegular size={14} />{t('retry')}</Button>}</div>}
          {loading && !appending && (!folder || !photos.length) && <GallerySkeleton kind={folder ? 'photos' : 'folders'} count={config.limits.pageSize} label={`${t(folder && allIntent ? 'galleryReadAllPhotos' : 'galleryLoading')}${folder ? ` ${readCount}` : ''}`} />}
          {!accounts.length ? <div className="vc-gallery-empty"><ui.IconFolderOpenOutlineRegular size={28} /><strong>{t('galleryNoAccounts')}</strong><Button size="sm" variant="outline" onClick={onManageAccounts}>{t('galleryManageAccounts')}</Button></div> : folder ? <>
            {!!photos.length && <div className="vc-gallery-reference-selection">
              <div className="vc-gallery-selection-actions">
                <Checkbox checked={eligible.length > 0 && selected.size === eligible.length && (allIntent || enumerated)} label={t('gallerySelectAllShort')} disabled={locked || uncertain || !eligible.length || loading && allIntent} onChange={enabled => { if (enabled) selectAll(); else clearSelection() }} />
                <span className="vc-gallery-selection-count">{t('gallerySelected')} {selected.size}</span>
                <Button size="sm" variant="ghost" aria-label={t('galleryClearSelection')} disabled={locked || uncertain || !selected.size} onClick={clearSelection}>{t('galleryClearSelectionShort')}</Button>
              </div>
              <div className="vc-gallery-selection-status">
                <span className="vc-gallery-reference-progress" role="status" aria-live="polite">{loading && <StateDot state="ongoing" />}{t(loading ? 'galleryLoadingShort' : 'referenceLoaded')} {photos.length}{folder.totalPhotos > 0 && ` / ${folder.totalPhotos}`}</span>
                {photos.some(photo => photo.premium) && <Tooltip label={t('galleryPremiumPreview')} openOnClick portal side="bottom" align="end" maxWidth={280}><Button size="sm" variant="ghost" className="vc-gallery-selection-info" aria-label={t('galleryPhotoAvailability')}><ui.IconInfoOutlineRegular size={16} /></Button></Tooltip>}
              </div>
            </div>}
            <div className="vc-gallery-photos">{visiblePhotos.map(photo => <figure key={photo.id} data-selected={selected.has(photo.id)}><GalleryPhotoPreview photo={photo} selected={selected.has(photo.id)} disabled={locked || uncertain} onToggle={() => toggle(photo.id, !selected.has(photo.id))} t={t} /><figcaption><Checkbox checked={selected.has(photo.id)} label={photo.title || photo.id} disabled={locked || uncertain} onChange={enabled => toggle(photo.id, enabled)} /><small>{photo.photographer}{photo.premium && ` · ${t('galleryPremiumBrand')}`}</small></figcaption></figure>)}</div>
            {!loading && !filteredPhotos.length && !error && <div className="vc-gallery-empty">{t(query ? 'noMatches' : 'galleryEmptyPhotos')}</div>}
            <GalleryLoadMore hasMore={visiblePhotos.length < filteredPhotos.length || !!photoCursor} loading={loading && appending && !allIntent} disabled={locked || loading || !!error} version={`${visiblePhotos.length}:${photoCursor}`} kind="photos" label={t('galleryLoading')} onLoad={() => { setPage(value => value + 1); if (visiblePhotos.length >= filteredPhotos.length && photoCursor) void loadPhotos(folder, false, true) }} />
          </> : <><div className="vc-gallery-folders">{filteredFolders.map(item => <Button key={item.id} variant="ghost" className="vc-gallery-folder" onClick={() => { void loadPhotos(item) }}>{item.coverUrl ? <img src={galleryImageSource(item.coverPath, item.coverUrl)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span className="vc-gallery-folder-cover"><ui.IconFolderOpenOutlineRegular size={24} /></span>}<span className="vc-gallery-folder-info"><strong>{item.title}</strong><small>{item.totalPhotos} {t('galleryPhotoUnit')}{item.private && <Tag>{t('galleryPrivate')}</Tag>}</small></span></Button>)}</div>{!loading && !filteredFolders.length && !error && <div className="vc-gallery-empty"><ui.IconFolderOpenOutlineRegular size={28} /><strong>{t(query ? 'noMatches' : 'galleryEmptyFoldersTitle')}</strong><p>{t('galleryReferenceEmpty')}</p></div>}<GalleryLoadMore hasMore={!!nextCursor} loading={loading && appending} disabled={locked || !!error} version={folders.length} kind="folders" label={t('galleryLoading')} onLoad={() => { if (nextCursor) void loadFolders(nextCursor) }} /></>}
        </section>
      </div>
    </Modal>
  }
}
