import { previewSource } from './afp-preview-media.js'
import { createPreviewLoading } from './afp-preview-loading.js'
import { photoDisplayTitle } from './afp-photo-labels.js'

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
  const PreviewLoading = createPreviewLoading(React)
  const decisionLabel = decision => t(decision === 'kept' || decision === 'rejected' ? `filter_${decision}` : decision)

  function ImagePreview({ photo, large = false, retry = false, open, openLabel = t('openPhoto') }) {
    const [attempt, setAttempt] = React.useState(0)
    const [media, setMedia] = React.useState({ src: '', status: 'loading', host: null })
    const frame = React.useRef(null)
    const currentLease = React.useRef(null)
    const recovery = React.useRef(null)
    if (!recovery.current) recovery.current = { used: 0, refresh: false }
    const src = previewSource(photo?.previewPath, document.baseURI)
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const readEnabled = snapshot.status?.features?.includes('read')
    // 旧Host没有重试策略时保留手动刷新，不推测其代理502是否为临时错误。
    const retryCount = snapshot.status?.previewCache?.retryCount ?? 0
    const retryDelayMs = snapshot.status?.previewCache?.retryDelayMs ?? 0
    React.useEffect(() => { recovery.current.used = 0; recovery.current.refresh = false }, [src, readEnabled, snapshot.previewGeneration])
    const fail = error => {
      const again = error.retryable === true && recovery.current.used < retryCount
      if (again) recovery.current.used++
      setMedia({ src: '', status: again ? 'retrying' : 'error', host: error.host ?? null,
        recoveryCount: recovery.current.used, exhausted: error.retryable === true && retryCount > 0 && !again })
    }
    React.useEffect(() => {
      if (media.status !== 'retrying' || !src || !readEnabled) return
      const doc = frame.current?.ownerDocument ?? document
      let timer, observer, visible = large || typeof IntersectionObserver !== 'function'
      const schedule = () => {
        clearTimeout(timer)
        if (visible && !doc.hidden) timer = setTimeout(() => setAttempt(value => value + 1), retryDelayMs * 2 ** Math.max(0, media.recoveryCount - 1))
      }
      if (!large && typeof IntersectionObserver === 'function' && frame.current) {
        observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); schedule() })
        observer.observe(frame.current)
      }
      doc.addEventListener('visibilitychange', schedule); schedule()
      return () => { clearTimeout(timer); observer?.disconnect(); doc.removeEventListener('visibilitychange', schedule) }
    }, [media.status, media.recoveryCount, src, readEnabled, snapshot.previewGeneration, retryDelayMs, large])
    React.useLayoutEffect(() => {
      const controller = new AbortController()
      let lease, observer, started = false
      // 缓存租约在布局阶段恢复，避免筛选切换时先绘制骨架屏；仍遵守过期和账号失效。
      lease = src && readEnabled && !recovery.current.refresh ? store.acquireCachedPreview?.(src, controller.signal) : null
      if (lease) { started = true; currentLease.current = lease; setMedia({ src: lease.url, status: 'ready', host: null }) }
      else setMedia({ src: '', status: src && readEnabled ? 'loading' : 'error', host: null })
      const start = async () => {
        if (started || !src || !readEnabled) return
        started = true
        observer?.disconnect()
        try {
          // 自动恢复复用其他组件已成功的新版本；只有用户手动刷新强制失效缓存。
          const refresh = recovery.current.refresh
          recovery.current.refresh = false
          lease = await store.acquirePreview(src, controller.signal, { refresh })
          if (controller.signal.aborted) return
          currentLease.current = lease
          setMedia({ src: lease.url, status: 'decoding', host: null })
        } catch (error) {
          if (!controller.signal.aborted) fail(error)
        }
      }
      // 只在可见时订阅预览；退出时释放自己的租约，不取消其他组件共用的请求。
      if (!started && !large && typeof IntersectionObserver === 'function' && frame.current) {
        observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void start() })
        observer.observe(frame.current)
      } else void start()
      return () => { controller.abort(); observer?.disconnect(); lease?.release(); if (currentLease.current === lease) currentLease.current = null }
    }, [src, attempt, large, readEnabled, snapshot.previewGeneration])
    const ready = media.status === 'ready'
    if (media.status === 'error' || !src) return h('div', { ref: frame, className: 'afp-wb-preview-container' }, h('div', { className: `afp-wb-image-fallback${large ? ' afp-wb-image-fallback-large' : ''}` },
      h('span', { className: 'afp-wb-preview-error-icon', 'aria-hidden': true },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
          h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 4 }), h('path', { d: 'M3 17l5-5 4 4 3-3 6 6M8 8h.01', strokeLinecap: 'round', strokeLinejoin: 'round' }))),
      h('span', { className: 'afp-wb-preview-error-title' }, t('previewUnavailable')),
      media.exhausted ? h('span', { className: 'afp-wb-preview-error-hint' }, t('previewRetryExhausted')) : null,
      media.host ? h('span', { className: 'afp-wb-preview-diagnostic' }, t('previewHostBlocked').replace('{host}', media.host)) : null,
      retry ? h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-preview-retry', onClick: event => {
        event.stopPropagation(); recovery.current.used = 0; recovery.current.refresh = true; setAttempt(value => value + 1)
      } }, icons.IconRefreshOutlineRegular ? h(icons.IconRefreshOutlineRegular, { size: 12 }) : null, t('retryPreview')) : null))
    const image = h('div', { className: `afp-wb-image-stage${large ? ' is-large' : ''}${ready ? ' is-ready' : ''}`, 'aria-busy': !ready },
      !ready ? h(PreviewLoading, { label: t(media.status === 'retrying' ? 'previewRetrying' : 'loading'), animation: snapshot.status?.previewAnimation }) : null,
      media.status === 'retrying' ? h('span', { className: 'afp-wb-preview-retrying' }, t('previewRetrying')) : null,
      media.src ? h('img', { className: large ? 'afp-wb-photo-large' : 'afp-wb-photo', src: media.src, alt: open ? '' : photoDisplayTitle(photo, t('photoDetails')),
        onLoad: () => setMedia(current => current.src === media.src ? { ...current, status: 'ready' } : current),
        decoding: 'async',
        onError: () => {
          if (currentLease.current?.url !== media.src) return
          store.invalidatePreview(src, media.src)
          currentLease.current.release(); currentLease.current = null
          fail({ retryable: true })
        } }) : null)
    return h('div', { ref: frame, className: 'afp-wb-preview-container' }, open ? h('button', { type: 'button', className: 'afp-wb-image-button',
      onClick: event => { event.stopPropagation(); open() }, 'aria-label': `${openLabel} ${photoDisplayTitle(photo, t('photoDetails'))}` }, image) : image)
  }

  function PhotoSkeleton({ imageOnly = false } = {}) {
    return h('div', { className: `afp-wb-skeleton-tile${imageOnly ? ' is-image-only' : ''}`, 'aria-hidden': true },
      h('span'), imageOnly ? null : h('span'), imageOnly ? null : h('span'))
  }

  function PhotoDetailsIcon() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 11v6' }),
    h('circle', { cx: 12, cy: 7.5, r: .8, fill: 'currentColor', stroke: 'none' }))
  }

  function PhotoSelectionIcon({ selected }) {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 5 }),
    h('path', { d: selected ? 'M8 12h8' : 'm7.5 12 3 3 6-6' }))
  }

  function ReviewAction({ label, Icon, ...props }) {
    return h(Button, { variant: 'ghost', size: 'sm', ...props, 'aria-label': label },
      h(Icon, { selected: props['aria-pressed'] }), h('span', null, label))
  }

  function PhotoGrid({ items = [], selectedPhotos = {}, report = false, onReview, sourceCollectionId, loading = false }) {
    if (!items.length && !loading) return h('p', { className: 'afp-wb-empty' }, t(report ? 'noReportItems' : 'noPhotos'))
    return h('div', { className: 'afp-wb-gallery' }, ...items.map(item => {
      const photo = item
      const selected = Boolean(selectedPhotos[photo.id])
      const decision = report ? item.requestFailed ? 'requestFailed' : item.keep === true ? 'kept' : item.keep === false ? 'rejected' : 'notReviewed' : ''
      const title = photoDisplayTitle(photo, t('photoDetails'))
      const confidence = report && item.confidence != null ? h('span', { className: 'afp-wb-photo-confidence',
        tabIndex: 0, 'aria-label': `${t('modelConfidence')}: ${item.confidence}` }, item.confidence) : null
      const selectLabel = `${t(selected ? 'removeFromSelection' : 'selectPhoto')} ${title}`
      return h('article', { className: `afp-wb-photo-tile${report ? ' is-report' : ''}${selected ? ' is-selected' : ''}`, key: report ? `${item.category}:${photo.id}` : photo.id },
        h('div', { className: 'afp-wb-photo-frame', onClick: report ? () => onReview?.(photo) : () => store.togglePhoto(photo, sourceCollectionId),
          role: report ? undefined : 'button', tabIndex: report ? undefined : 0, 'aria-label': report ? undefined : selectLabel,
          'aria-pressed': report ? undefined : selected,
          onKeyDown: report ? undefined : event => {
            if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
              event.preventDefault(); store.togglePhoto(photo, sourceCollectionId)
            }
          },
          onContextMenu: event => { event.preventDefault(); void store.openPhoto(photo) } },
          h(ImagePreview, { photo, retry: true, open: report ? () => onReview?.(photo) : undefined, openLabel: report ? t('reviewPhoto') : t('openPhoto') }),
          confidence && Tooltip ? h(Tooltip, { label: `${t('modelConfidence')}: ${item.confidence}`, side: 'top', portal: true }, confidence) : confidence),
        h('button', { type: 'button', className: 'afp-wb-photo-open', onClick: () => report ? onReview?.(photo) : void store.openPhoto(photo),
          onContextMenu: event => { event.preventDefault(); void store.openPhoto(photo) }, 'aria-label': `${t(report ? 'reviewPhoto' : 'openPhoto')} ${title}` },
          h('span', { className: 'afp-wb-photo-title' }, title)),
        h('div', { className: 'afp-wb-photo-meta' },
          h('span', null, (photo.provider ?? 'AFP').replace(/^afpprovider:/i, ''), report ? ` · ${t(item.category)}` : ''),
          report && decision ? h(Tag, { tone: decision === 'kept' ? 'success' : decision === 'requestFailed' ? 'warning' : 'neutral' }, decisionLabel(decision)) : null,
          report && selected ? h(Tag, { tone: 'info' }, t('selected')) : null),
        report ? h('p', { className: 'afp-wb-subtle afp-wb-photo-reason' },
          item.requestFailed ? t('reportRequestFailureHelp') : item.reason || t('reportUnreviewedHelp')) : null,
        report ? h('div', { className: 'afp-wb-photo-review-actions' },
          h(ReviewAction, { label: t('photoDetails'), Icon: PhotoDetailsIcon,
            onClick: () => { void store.openPhoto(photo) } }),
          h(ReviewAction, { label: t(selected ? 'removeFromSelection' : 'selectPhoto'), Icon: PhotoSelectionIcon,
            'aria-pressed': selected, disabled: !selected && (item.keep !== true || item.requestFailed === true),
            onClick: () => selected ? store.removePhoto(photo.id) : store.selectPhoto(photo) })) : null)
    }), loading ? Array.from({ length: 6 }, (_, index) => h(PhotoSkeleton, { key: `loading-${index}` })) : null)
  }

  function ReportGallery({ items, selectedPhotos }) {
    const [reviewId, setReviewId] = React.useState(null)
    const key = item => `${item.category}:${item.id}`
    const photo = items.find(item => key(item) === reviewId) ?? null
    // 过滤器或分页刷新移除当前图片时关闭审阅，避免切回过滤器后意外重新打开。
    React.useEffect(() => { if (reviewId && !photo) setReviewId(null) }, [reviewId, photo])
    return h(React.Fragment, null,
      h(PhotoGrid, { items, selectedPhotos, report: true, onReview: item => setReviewId(key(item)) }),
      h(ReviewModal, { photo, items, onChange: item => setReviewId(key(item)), onClose: () => setReviewId(null) }))
  }

  function ReviewModal({ photo, items, onChange, onClose }) {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const index = items.findIndex(item => item.id === photo?.id && item.category === photo.category)
    const move = delta => { const next = items[index + delta]; if (next) onChange(next) }
    const details = () => { onClose(); void store.openPhoto(photo) }
    const decision = photo?.requestFailed ? 'requestFailed' : photo?.keep === true ? 'kept' : photo?.keep === false ? 'rejected' : 'notReviewed'
    const selected = Boolean(state.selectedPhotos[photo?.id])
    const canSelect = selected || photo?.keep === true && !photo.requestFailed
    return Modal ? h(Modal, { open: Boolean(photo), onClose, title: t('reviewPhoto'), closeLabel: t('close'),
      className: 'afp-wb-preview-modal afp-wb-review-modal', contentClassName: 'afp-wb-preview-modal-content',
        onKeyDownCapture: event => {
          if (!photo) return
          if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest?.('input, textarea, [contenteditable="true"]')) return
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowLeft' ? -1 : 1) }
        },
      footer: photo ? h('div', { className: 'afp-wb-review-controls' },
        h('div', { className: 'afp-wb-actions' },
          h(Button, { variant: 'outline', size: 'sm', disabled: index <= 0, onClick: () => move(-1) }, t('reviewPrevious')),
          h('span', { className: 'afp-wb-review-position', role: 'status', 'aria-live': 'polite' }, `${index + 1} / ${items.length}`),
          h(Button, { variant: 'outline', size: 'sm', disabled: index >= items.length - 1, onClick: () => move(1) }, t('reviewNext'))),
        h('div', { className: 'afp-wb-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: details }, t('photoDetails')),
          h(Button, { variant: selected ? 'outline' : 'primary', size: 'sm', disabled: !canSelect, 'aria-pressed': selected,
            onClick: () => selected ? store.removePhoto(photo.id) : store.selectPhoto(photo) }, t(selected ? 'removeFromSelection' : 'selectPhoto')),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => { onClose(); store.set({ selectionOpen: true }) } }, t('selectionList')))) : undefined },
      photo ? h('div', { className: 'afp-wb-review-body' },
        h('div', { className: 'afp-wb-review-image', onContextMenu: event => { event.preventDefault(); details() } },
          h(ImagePreview, { key: photo.id, photo, large: true, retry: true })),
        h('aside', { className: 'afp-wb-review-info' },
          h('div', { className: 'afp-wb-review-heading' }, h('strong', null, photoDisplayTitle(photo, t('photoDetails'))),
            h(Tag, { tone: decision === 'kept' ? 'success' : decision === 'requestFailed' ? 'warning' : 'neutral' }, decisionLabel(decision))),
          h('dl', { className: 'afp-wb-review-fields' },
            h('div', null, h('dt', null, t('categoryFilter')), h('dd', null, t(photo.category))),
            h('div', null, h('dt', null, t('provider')), h('dd', null, (photo.provider ?? 'AFP').replace(/^afpprovider:/i, ''))),
            photo.confidence != null ? h('div', null, h('dt', null, t('modelConfidence')), h('dd', null, photo.confidence)) : null),
          photo.reason ? h('p', { className: 'afp-wb-review-reason' }, photo.reason) : null,
          photo.caption ? h('p', { className: 'afp-wb-caption' }, photo.caption) : null)) : null) : null
  }

  function DetailPane({ photo, report = false, loading, error, onClose, sourceCollectionId }) {
    const [previewOpen, setPreviewOpen] = React.useState(false)
    React.useEffect(() => setPreviewOpen(false), [photo?.id])
    if (!photo) return null
    return h('aside', { className: 'afp-wb-detail', 'aria-label': t('photoDetails') },
      h('div', { className: 'afp-wb-detail-head' }, h('h3', null, t('photoDetails')),
        h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-close-button', 'aria-label': t('closeDetails'), onClick: onClose }, icons.IconCloseOutlineRegular ? h(icons.IconCloseOutlineRegular, { size: 14 }) : t('close'))),
      h(ImagePreview, { key: photo.id, photo, large: true, retry: true, open: () => setPreviewOpen(true) }),
      loading ? h('div', { className: 'afp-wb-detail-skeleton', role: 'status', 'aria-label': t('loading') }, h('span', { className: 'afp-skeleton' }), h('span', { className: 'afp-skeleton' })) : null,
      error ? h('p', { className: 'afp-wb-error', role: 'alert' }, t('regionReadFailed')) : null,
      h('h4', { className: 'afp-wb-detail-title' }, photoDisplayTitle(photo, t('photoDetails'))),
      photo.provider ? h('p', { className: 'afp-wb-subtle' }, `${t('provider')}: ${photo.provider.replace(/^afpprovider:/i, '')}`) : null,
      h('details', { className: 'afp-wb-photo-identifiers' }, h('summary', null, t('photoIdentifiers')),
        h('dl', null, h('dt', null, t('photoId')), h('dd', null, photo.id), photo.guid ? h(React.Fragment, null, h('dt', null, t('photoGuid')), h('dd', null, photo.guid)) : null)),
      photo.caption ? h('p', { className: 'afp-wb-caption' }, photo.caption) : null,
      photo.keywords?.length ? h('div', { className: 'afp-wb-keywords' }, ...photo.keywords.map(keyword => h(Tag, { key: keyword, tone: 'neutral' }, keyword))) : null,
      photo.reason ? h('p', { className: 'afp-wb-subtle' }, photo.reason) : null,
      photo.confidence != null ? h('p', { className: 'afp-wb-subtle' }, `${t('modelConfidence')}: ${photo.confidence}`) : null,
      photo.requestFailed ? h(Tag, { tone: 'warning' }, t('requestFailed')) : photo.keep === true ? h(Tag, { tone: 'success' }, report ? decisionLabel('kept') : t('kept')) : photo.keep === false ? h(Tag, { tone: 'neutral' }, report ? decisionLabel('rejected') : t('rejected')) : null,
      h(Button, { variant: selected(photo.id) ? 'outline' : 'primary', size: 'sm', disabled: report && !selected(photo.id) && (photo.keep !== true || photo.requestFailed),
        onClick: () => selected(photo.id) ? store.removePhoto(photo.id) : store.selectPhoto(photo, sourceCollectionId) }, t(selected(photo.id) ? 'removeFromSelection' : 'selectPhoto')),
      h(PreviewModal, { photo: previewOpen ? photo : null, onClose: () => setPreviewOpen(false) }))
  }

  /** Optional navigation stays within the caller's visible list; single-photo details omit controls. */
  function PreviewModal({ photo, items = [], onChange, onClose }) {
    const index = items.findIndex(item => item.id === photo?.id && item.category === photo?.category)
    const canNavigate = index >= 0 && items.length > 1 && Boolean(onChange)
    const move = (delta, target) => {
      const next = items[index + delta]
      if (!canNavigate || !next) return
      // 在首尾按钮禁用前保留同组焦点，避免后续方向键落到页面正文。
      const navigation = target?.closest?.('.afp-wb-preview-navigation')
      if (navigation && (index + delta === 0 || index + delta === items.length - 1)) navigation.focus()
      onChange(next)
    }
    return Modal ? h(Modal, { open: Boolean(photo), onClose, title: photo ? photoDisplayTitle(photo, t('photoDetails')) : t('photoDetails'), closeLabel: t('close'),
      className: 'afp-wb-preview-modal', contentClassName: 'afp-wb-preview-modal-content',
      onKeyDownCapture: event => {
        if (!canNavigate || event.altKey || event.ctrlKey || event.metaKey
          || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowLeft' ? -1 : 1, event.target)
        }
      }, footer: canNavigate ? h('div', { className: 'afp-wb-actions afp-wb-preview-navigation', tabIndex: -1,
        role: 'group', 'aria-label': t('reviewPhoto') },
        h(Button, { variant: 'outline', size: 'sm', disabled: index <= 0, onClick: event => move(-1, event?.currentTarget) }, t('reviewPrevious')),
        h('span', { className: 'afp-wb-review-position', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, `${index + 1} / ${items.length}`),
        h(Button, { variant: 'outline', size: 'sm', disabled: index >= items.length - 1, onClick: event => move(1, event?.currentTarget) }, t('reviewNext'))) : undefined },
      photo ? h(ImagePreview, { key: photo.id, photo, large: true, retry: true }) : null) : null
  }
  function selected(id) { return Boolean(store.getSnapshot().selectedPhotos[id]) }

  function SelectionPane({ photos, onOpen }) {
    return h('aside', { className: 'afp-wb-detail afp-wb-selection', 'aria-label': t('selectionList') },
      h('div', { className: 'afp-wb-detail-head' }, h('h3', null, t('selectionList'))),
      !photos.length ? h('p', { className: 'afp-wb-empty' }, t('selectionEmpty')) : h('div', { className: 'afp-wb-selection-list' }, ...photos.map(photo => {
        const label = `${t('removePhoto')} ${photoDisplayTitle(photo, t('photoDetails'))}`
        const removeButton = h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-selection-remove',
          'aria-label': label, onClick: () => store.removePhoto(photo.id) },
          icons.IconCloseOutlineRegular ? h(icons.IconCloseOutlineRegular, { size: 14 }) : t('remove'))
        return h('div', { className: 'afp-wb-selection-item', key: photo.id },
          h(ImagePreview, { photo, retry: true, open: () => onOpen(photo) }),
          h('button', { type: 'button', className: 'afp-wb-selection-open', onClick: () => onOpen(photo) }, h('span', null, photoDisplayTitle(photo, t('photoDetails')))),
          Tooltip ? h(Tooltip, { label: t('removeFromSelection'), side: 'top', align: 'end', portal: true, maxWidth: 180 }, removeButton) : removeButton)
      })),
      photos.length ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => store.clearSelection() }, t('clearSelection')) : null)
  }

  return { ImagePreview, PreviewModal, ReviewModal, ReportGallery, PhotoGrid, PhotoSkeleton, DetailPane, SelectionPane }
}
