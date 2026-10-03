import { previewSource } from './afp-preview-media.js'

/** Gallery, detail and local-selection surfaces shared by search, collections and reports.
 * @param {object} React React client runtime.
 * @param {object} UI Existing DSH primitives.
 * @param {object} icons Optional exported DSH icon components.
 * @param {Function} t Locale lookup function.
 * @param {object} store Shared photo state and actions.
 * @returns {object} Gallery, detail, preview and selection components.
 */
export function createAfpGallery(React, UI, icons, t, store) {
  const h = React.createElement
  const { Button, Tag, Modal, Tooltip } = UI

  function ImagePreview({ photo, large = false, retry = false, open }) {
    const [attempt, setAttempt] = React.useState(0)
    const [media, setMedia] = React.useState({ src: '', status: 'loading', host: null })
    const frame = React.useRef(null)
    const currentLease = React.useRef(null)
    const src = previewSource(photo?.previewPath, document.baseURI)
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const readEnabled = snapshot.status?.features?.includes('read')
    React.useEffect(() => {
      const controller = new AbortController()
      let lease, observer, started = false
      setMedia({ src: '', status: src && readEnabled ? 'loading' : 'error', host: null })
      const start = async () => {
        if (started || !src || !readEnabled) return
        started = true
        observer?.disconnect()
        try {
          lease = await store.acquirePreview(src, controller.signal, { refresh: attempt > 0 })
          if (controller.signal.aborted) return
          currentLease.current = lease
          setMedia({ src: lease.url, status: 'decoding', host: null })
        } catch (error) {
          if (!controller.signal.aborted) setMedia({ src: '', status: 'error', host: error.host ?? null })
        }
      }
      // 只在可见时订阅预览；退出时释放自己的租约，不取消其他组件共用的请求。
      if (!large && typeof IntersectionObserver === 'function' && frame.current) {
        observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void start() })
        observer.observe(frame.current)
      } else void start()
      return () => { controller.abort(); observer?.disconnect(); lease?.release(); if (currentLease.current === lease) currentLease.current = null }
    }, [src, attempt, large, readEnabled, snapshot.previewGeneration])
    const ready = media.status === 'ready'
    if (media.status === 'error' || !src) return h('div', { ref: frame, className: 'afp-wb-preview-container' }, h('div', { className: `afp-wb-image-fallback${large ? ' afp-wb-image-fallback-large' : ''}` },
      h('span', { 'aria-hidden': true }, '▧'), h('span', null, t('previewUnavailable')),
      media.host ? h('span', { className: 'afp-wb-preview-diagnostic' }, t('previewHostBlocked').replace('{host}', media.host)) : null,
      retry ? h(Button, { variant: 'ghost', size: 'sm', onClick: event => { event.stopPropagation(); setAttempt(value => value + 1) } }, t('retryPreview')) : null))
    const image = h('div', { className: `afp-wb-image-stage${large ? ' is-large' : ''}${ready ? ' is-ready' : ''}`, 'aria-busy': !ready },
      !ready ? h('span', { className: 'afp-skeleton afp-wb-image-skeleton', role: 'status', 'aria-label': t('loading') }) : null,
      media.src ? h('img', { className: large ? 'afp-wb-photo-large' : 'afp-wb-photo', src: media.src, alt: open ? '' : photo.title || t('photoDetails'),
        onLoad: () => setMedia(current => current.src === media.src ? { ...current, status: 'ready' } : current),
        decoding: 'async',
        onError: () => {
          store.invalidatePreview(src, media.src)
          if (currentLease.current?.url === media.src) currentLease.current.release()
          setMedia(current => current.src === media.src ? { ...current, status: 'error' } : current)
        } }) : null)
    return h('div', { ref: frame, className: 'afp-wb-preview-container' }, open ? h('button', { type: 'button', className: 'afp-wb-image-button', onClick: open, 'aria-label': `${t('openPhoto')} ${photo.title ?? photo.id}` }, image) : image)
  }

  function PhotoSkeleton() {
    return h('div', { className: 'afp-wb-skeleton-tile', 'aria-hidden': true }, h('span'), h('span'), h('span'))
  }

  function PhotoGrid({ items = [], selectedPhotos = {}, report = false, sourceCollectionId, loading = false }) {
    if (!items.length && !loading) return h('p', { className: 'afp-wb-empty' }, t(report ? 'noReportItems' : 'noPhotos'))
    return h('div', { className: 'afp-wb-gallery' }, ...items.map(item => {
      const photo = item
      const selected = Boolean(selectedPhotos[photo.id])
      const decision = report ? item.requestFailed ? 'requestFailed' : item.keep === true ? 'kept' : item.keep === false ? 'rejected' : 'notReviewed' : ''
      const selectLabel = `${t(selected ? 'removeFromSelection' : 'selectPhoto')} ${photo.title || photo.id}`
      const selectButton = !report ? h(Button, { variant: 'ghost', size: 'sm',
        className: `afp-wb-photo-select${selected ? ' is-selected' : ''}`, 'aria-label': selectLabel, 'aria-pressed': selected,
        onClick: event => { event.stopPropagation(); store.togglePhoto(photo, sourceCollectionId) } },
        h('span', { className: selected ? 'afp-wb-photo-selected-icon' : 'afp-wb-photo-select-icon', 'aria-hidden': true },
          icons.IconCheckOutlineRegular ? h(icons.IconCheckOutlineRegular, { size: 12 }) : null)) : null
      return h('article', { className: `afp-wb-photo-tile${selected ? ' is-selected' : ''}`, key: photo.id },
        h('div', { className: 'afp-wb-photo-frame', onClick: report ? undefined : () => store.togglePhoto(photo, sourceCollectionId),
          onContextMenu: event => { event.preventDefault(); void store.openPhoto(photo) } },
          h(ImagePreview, { photo, retry: true, open: report ? () => { void store.openPhoto(photo) } : undefined }),
          selectButton && Tooltip ? h(Tooltip, { label: t(selected ? 'removeFromSelection' : 'selectPhoto'), side: 'top', portal: true, maxWidth: 180 }, selectButton) : selectButton),
        h('button', { type: 'button', className: 'afp-wb-photo-open', onClick: () => { void store.openPhoto(photo) }, 'aria-label': `${t('openPhoto')} ${photo.title}` },
          h('span', { className: 'afp-wb-photo-title' }, photo.title || photo.id)),
        h('div', { className: 'afp-wb-photo-meta' },
          h('span', null, (photo.provider ?? 'AFP').replace(/^afpprovider:/i, '')), report ? h('span', null, t(item.category)) : null,
          report && decision ? h(Tag, { tone: decision === 'kept' ? 'success' : decision === 'requestFailed' ? 'warning' : 'neutral' }, t(decision)) : null),
        report && item.confidence != null ? h('p', { className: 'afp-wb-subtle' }, `${t('modelConfidence')}: ${item.confidence}`) : null,
        report && item.reason ? h('p', { className: 'afp-wb-subtle afp-wb-photo-reason' }, item.reason) : null)
    }), loading ? Array.from({ length: 6 }, (_, index) => h(PhotoSkeleton, { key: `loading-${index}` })) : null)
  }

  function DetailPane({ photo, loading, error, onClose, sourceCollectionId }) {
    const [previewOpen, setPreviewOpen] = React.useState(false)
    React.useEffect(() => setPreviewOpen(false), [photo?.id])
    if (!photo) return null
    return h('aside', { className: 'afp-wb-detail', 'aria-label': t('photoDetails') },
      h('div', { className: 'afp-wb-detail-head' }, h('h3', null, t('photoDetails')),
        h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-close-button', 'aria-label': t('closeDetails'), onClick: onClose }, icons.IconCloseOutlineRegular ? h(icons.IconCloseOutlineRegular, { size: 14 }) : t('close'))),
      h(ImagePreview, { key: photo.id, photo, large: true, retry: true, open: () => setPreviewOpen(true) }),
      loading ? h('div', { className: 'afp-wb-detail-skeleton', role: 'status', 'aria-label': t('loading') }, h('span', { className: 'afp-skeleton' }), h('span', { className: 'afp-skeleton' })) : null,
      error ? h('p', { className: 'afp-wb-error', role: 'alert' }, t('regionReadFailed')) : null,
      h('h4', { className: 'afp-wb-detail-title' }, photo.title || photo.id),
      photo.provider ? h('p', { className: 'afp-wb-subtle' }, `${t('provider')}: ${photo.provider.replace(/^afpprovider:/i, '')}`) : null,
      h('details', { className: 'afp-wb-photo-identifiers' }, h('summary', null, t('photoIdentifiers')),
        h('dl', null, h('dt', null, t('photoId')), h('dd', null, photo.id), photo.guid ? h(React.Fragment, null, h('dt', null, t('photoGuid')), h('dd', null, photo.guid)) : null)),
      photo.caption ? h('p', { className: 'afp-wb-caption' }, photo.caption) : null,
      photo.keywords?.length ? h('div', { className: 'afp-wb-keywords' }, ...photo.keywords.map(keyword => h(Tag, { key: keyword, tone: 'neutral' }, keyword))) : null,
      photo.reason ? h('p', { className: 'afp-wb-subtle' }, photo.reason) : null,
      photo.confidence != null ? h('p', { className: 'afp-wb-subtle' }, `${t('modelConfidence')}: ${photo.confidence}`) : null,
      photo.requestFailed ? h(Tag, { tone: 'warning' }, t('requestFailed')) : photo.keep === true ? h(Tag, { tone: 'success' }, t('kept')) : photo.keep === false ? h(Tag, { tone: 'neutral' }, t('rejected')) : null,
      h(Button, { variant: selected(photo.id) ? 'outline' : 'primary', size: 'sm', onClick: () => selected(photo.id) ? store.removePhoto(photo.id) : store.selectPhoto(photo, sourceCollectionId) }, t(selected(photo.id) ? 'removeFromSelection' : 'selectPhoto')),
      Modal ? h(Modal, { open: previewOpen, onClose: () => setPreviewOpen(false), title: photo.title || t('photoDetails'), closeLabel: t('close'),
        className: 'afp-wb-preview-modal', contentClassName: 'afp-wb-preview-modal-content' },
        previewOpen ? h(ImagePreview, { key: photo.id, photo, large: true, retry: true }) : null) : null)
  }
  function selected(id) { return Boolean(store.getSnapshot().selectedPhotos[id]) }

  function SelectionPane({ photos, onOpen }) {
    return h('aside', { className: 'afp-wb-detail afp-wb-selection', 'aria-label': t('selectionList') },
      h('div', { className: 'afp-wb-detail-head' }, h('h3', null, t('selectionList'))),
      !photos.length ? h('p', { className: 'afp-wb-empty' }, t('selectionEmpty')) : h('div', { className: 'afp-wb-selection-list' }, ...photos.map(photo => {
        const label = `${t('removePhoto')} ${photo.title || photo.id}`
        const removeButton = h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-selection-remove',
          'aria-label': label, onClick: () => store.removePhoto(photo.id) },
          icons.IconCloseOutlineRegular ? h(icons.IconCloseOutlineRegular, { size: 14 }) : t('remove'))
        return h('div', { className: 'afp-wb-selection-item', key: photo.id },
          h(ImagePreview, { photo, retry: true, open: () => onOpen(photo) }),
          h('button', { type: 'button', className: 'afp-wb-selection-open', onClick: () => onOpen(photo) }, h('span', null, photo.title || photo.id)),
          Tooltip ? h(Tooltip, { label: t('removeFromSelection'), side: 'top', align: 'end', portal: true, maxWidth: 180 }, removeButton) : removeButton)
      })),
      photos.length ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => store.clearSelection() }, t('clearSelection')) : null)
  }

  return { ImagePreview, PhotoGrid, PhotoSkeleton, DetailPane, SelectionPane }
}
