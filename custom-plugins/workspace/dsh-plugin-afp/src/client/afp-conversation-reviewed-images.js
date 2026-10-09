import { createAfpGallery } from './afp-workbench-gallery.js'

/** Build protected preview paths only for recorded opaque photo identities.
 * @param {Array<string>} ids Successfully read or judged photo identities.
 * @returns {Array<object>} Unique identities and same-origin preview paths.
 */
export function reviewedPreviewPhotos(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.trim() && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id)))]
    .map(id => ({ id, previewPath: 'api/afp/preview?photoId=' + encodeURIComponent(id) }))
}

/** Validate original UI outcomes and merge preview identities without inventing a verdict.
 * @param {Array<object>} results Saved image outcomes.
 * @param {Array<string>} ids Successfully read live or historical previews.
 * @returns {Array<object>} Protected photos with passed, rejected, incomplete or unknown status.
 */
export function reviewedImageRows(results, ids = []) {
  const rows = new Map()
  for (const result of Array.isArray(results) ? results : []) {
    const photo = reviewedPreviewPhotos([result?.id])[0]
    if (!photo) continue
    const category = typeof result.category === 'string' ? result.category : ''
    rows.set(category + '\n' + photo.id, { ...photo, category,
      title: typeof result.title === 'string' ? result.title : undefined,
      status: result.requestFailed === true ? 'incomplete' : result.keep === true ? 'passed' : result.keep === false ? 'rejected' : 'unknown',
      reasonCode: ['visual-rule', 'category', 'confidence', 'duplicate-or-limit'].includes(result.reasonCode) ? result.reasonCode : null })
  }
  const known = new Set([...rows.values()].map(photo => photo.id))
  for (const photo of reviewedPreviewPhotos(ids)) if (!known.has(photo.id)) rows.set('\n' + photo.id, { ...photo, status: 'unknown' })
  return [...rows.values()]
}

/** Create a lazy horizontal preview list; no candidate is inferred from a search.
 * @param {object} React Client runtime.
 * @param {object} UI Shared buttons and preview primitives.
 * @param {Function} t Plugin translator.
 * @param {object} store Authenticated progress and original-result access.
 * @returns {object} Two independently expandable outcome lists and the shared Workbench modal.
 */
export function createReviewedPreviews(React, UI, t, store) {
  const h = React.createElement, { ImagePreview, PreviewModal } = createAfpGallery(React, UI, {}, t, store)
  function ReviewedPreviews({ open, liveIds, livePhotos, resultRef, sessionId, turn, callId, onOpen }) {
    const owner = JSON.stringify([sessionId, turn, callId, resultRef])
    const [saved, setSaved] = React.useState({ owner: '', ids: [], photos: [], unavailable: false })
    const [expanded, setExpanded] = React.useState({})
    React.useEffect(() => {
      if (!open || !resultRef || !sessionId || !turn || !store || saved.owner === owner && saved.unavailable !== 'failed') return
      const controller = new AbortController()
      // 历史缩略图只读原工具结果，不能用后来变化的运行报告替换当时的查看记录。
      void store.conversationData('conversation-result', { sessionId, turn, callId, resultRef }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setSaved({ owner, ids: result.reviewedPhotoIds ?? [], photos: result.reviewedPhotos ?? [], unavailable: result.reviewedPhotoIds || result.reviewedPhotos ? false : 'missing' }) })
        .catch(error => { if (!controller.signal.aborted) setSaved({ owner, ids: [], photos: [], unavailable: 'failed' }) })
      return () => controller.abort()
    }, [open, owner])
    const photos = reviewedImageRows(livePhotos ?? (saved.owner === owner ? saved.photos : []), liveIds ?? (saved.owner === owner ? saved.ids : []))
    if (!open) return null
    const unknown = photos.filter(photo => photo.status === 'unknown').length
    // 旧记录或读取失败没有逐图结论，不能以“通过 0 张”替代未知数量。
    if (resultRef && (saved.owner !== owner || saved.unavailable || unknown && unknown === photos.length)) return h('div', null,
      saved.owner === owner && saved.unavailable ? h('p', { className: 'afp-chat-help' }, t(saved.unavailable === 'failed' ? 'feedbackPreviewRecordFailed' : 'feedbackPreviewRecordUnavailable'))
        : unknown ? h('p', { className: 'afp-chat-help' }, t('feedbackPhotoStatusUnknown').replace('{count}', String(unknown))) : null)
    const icon = h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
      h('rect', { x: 6, y: 6, width: 15, height: 15, rx: 3 }), h('path', { d: 'M3 15V5a2 2 0 0 1 2-2h10M6 17l4-4 4 4 3-3 4 4M11 10h.01', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    return h('div', { className: 'afp-reviewed-lists' },
      ...['passed', 'rejected'].map(status => {
        const items = photos.filter(photo => photo.status === status).map((photo, index) => ({ ...photo,
          title: photo.title || t('feedbackPreviewOrdinal').replace('{index}', String(index + 1)) }))
        const title = t(status === 'passed' ? 'feedbackPhotosPassed' : 'feedbackPhotosRejected').replace('{count}', String(items.length))
        return h('div', { key: status, className: 'afp-reviewed-disclosure', 'data-review-status': status }, h(UI.DisclosureRow, {
          title, open: Boolean(expanded[status] && items.length), expandable: items.length > 0, expandOnRowClick: true,
          onToggle: () => { setExpanded(value => ({ ...value, [status]: !value[status] })); onOpen(null) }, titleClassName: 'afp-agent-tool-title', icon,
        }, expanded[status] && items.length ? h('div', { className: 'afp-reviewed-previews', tabIndex: 0, role: 'region', 'aria-label': t('feedbackRowTitle') + ' · ' + title },
          ...items.map(photo => {
            return h('div', { key: (photo.category ?? '') + '\n' + photo.id, className: 'afp-reviewed-thumbnail', title: photo.reasonCode ? t('feedbackReason_' + photo.reasonCode) : title },
              h(ImagePreview, { photo, retry: true, open: () => onOpen(photo, items) }))
          })) : null))
      }),
      unknown && resultRef ? h('p', { className: 'afp-chat-help' }, t('feedbackPhotoStatusUnknown').replace('{count}', String(unknown))) : null)
  }
  return { ReviewedPreviews, PreviewModal }
}
