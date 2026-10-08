import { afpTurnRows, useAfpResolvedResults } from './afp-conversation-progress.js'
import { createAfpGallery } from './afp-workbench-gallery.js'
import { previewSource } from './afp-preview-media.js'
import { photoDisplayTitle } from './afp-photo-labels.js'
import { cancelPhotoScroll, slidePhotoStrip } from './afp-photo-scroll.js'

const tools = ['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_result_page']
const resourceId = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
const errorMessages = new Map([
  ['authentication-failed', 'agentPhotosAuthenticationFailed'], ['login-failed', 'agentPhotosAuthenticationFailed'],
  ['credentials-missing', 'agentPhotosAuthenticationFailed'], ['access-denied', 'agentPhotosAccessDenied'],
  ['api-schema-rejected', 'agentPhotosSchemaRejected'], ['query-rejected', 'agentPhotosQueryRejected'],
  ['rate-limited', 'agentPhotosRateLimited'], ['read-timeout', 'agentPhotosTimedOut'],
])

function failureMessage(block) {
  const messages = [block.error?.message, ...(block.content ?? []).filter(item => item.type === 'text').map(item => item.text)]
  for (const text of messages) {
    if (typeof text !== 'string') continue
    try {
      const error = JSON.parse(text.startsWith('Error: ') ? text.slice(7) : text)
      const message = errorMessages.get(error?.code)
      if (message) return message
    } catch (error) {
      // 旧日志的自由文本只能使用固定提示，不能显示远端错误正文。
    }
  }
  return 'agentPhotosFailed'
}

/** Project persisted AFP results without trusting URLs or consulting the current search state.
 * @param {object} props Tool slot phase and frozen call/result record.
 * @returns {object} Safe photo metadata and localized display-state keys.
 */
export function conversationPhotoModel({ phase, block }) {
  if (phase !== 'result') return { state: 'running', message: 'agentPhotosLoading', photos: [] }
  if (block.error?.code === 'interrupted') return { state: 'stopped', message: 'agentPhotosStopped', photos: [] }
  if (block.isError) return { state: 'error', message: failureMessage(block), photos: [] }
  let result
  try {
    const text = block.content?.filter(item => item.type === 'text').map(item => item.text).join('\n')
    result = block.meta?.afp?.version === 1 ? block.meta.afp.result : JSON.parse(text)
  } catch (error) {
    // 旧日志或缺失结果只显示固定提示，不能把原始响应和可能的签名地址回显到卡片。
    return { state: 'error', message: 'agentPhotosInvalid', photos: [] }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { state: 'error', message: 'agentPhotosInvalid', photos: [] }
  if (result.found === false && result.photo === null) return { state: 'ok', message: 'agentPhotoNotFound', photos: [] }
  const rows = result.found === true ? [result.photo] : result.items
  if (!Array.isArray(rows)) return { state: 'error', message: 'agentPhotosInvalid', photos: [] }
  const photos = [], seen = new Set()
  for (const row of rows) {
    if (!row || !resourceId(row.id) || seen.has(row.id)) continue
    seen.add(row.id)
    // 旧元数据没有 previewPath；新旧记录均由 ID 重建固定路由，忽略结果中任意地址。
    photos.push({ id: row.id, title: typeof row.title === 'string' ? row.title : row.id,
      provider: typeof row.provider === 'string' ? row.provider : null,
      caption: typeof row.caption === 'string' ? row.caption : '',
      previewPath: `api/afp/preview?photoId=${encodeURIComponent(row.id)}` })
  }
  if (rows.length && !photos.length) return { state: 'error', message: 'agentPhotosInvalid', photos: [] }
  return { state: 'ok', message: photos.length ? 'agentPhotosCount' : 'noPhotos', photos }
}

/** Create read-only inline cards using the workbench's authenticated raster cache and modal.
 * @param {object} React Client React runtime.
 * @param {object} UI Shared disclosure, button and modal primitives.
 * @param {object} icons Existing DSH icons.
 * @param {Function} t Plugin locale lookup.
 * @param {object} store Profile preview store; no search or membership action is used.
 * @returns {Function} Component accepting tool.call.toolview owner props.
 */
export function createAfpConversationPhotos(React, UI, icons, t, store) {
  const h = React.createElement, { ImagePreview } = createAfpGallery(React, UI, icons, t, store)
  return function AfpConversationPhotos(props) {
    const owner = props.useChat ? props.useChat(snapshot => afpTurnRows(snapshot, props.callId)) : null
    const rows = useAfpResolvedResults(React, store, props.sessionId, owner?.turn.turn, owner?.rows ?? [])
    const process = props.useChat ? props.useChat(snapshot => conversationCandidatePhotoModel(snapshot, props.callId)) : null
    const model = props.photoModel ?? (process?.latest ? conversationCandidateModel(rows) : conversationPhotoModel(props))
    const [summaryExpanded, setSummaryExpanded] = React.useState(true)
    const disclosure = props.summary ? { expanded: summaryExpanded, toggle: () => setSummaryExpanded(value => !value) } : props.useDisclosure()
    const completed = props.useChat ? props.useChat(snapshot => conversationCallHasSummary(snapshot, props.callId)) : false
    const expandable = model.photos.length > 0 && (props.summary || !completed && process?.latest !== false)
    React.useEffect(() => { if (completed && !props.summary && disclosure.expanded) disclosure.toggle() }, [completed])
    const showGallery = expandable && disclosure.expanded
    const [selectedId, setSelectedId] = React.useState(null)
    const [edges, setEdges] = React.useState({ back: false, forward: false })
    const strip = React.useRef(null)
    const scrollMotion = React.useRef({})
    const selected = showGallery ? model.photos.find(photo => photo.id === selectedId) : undefined
    const selectedIndex = model.photos.findIndex(photo => photo.id === selectedId)
    const photoKeys = model.photos.map(photo => photo.id).join('\u0000')
    const summary = t(model.message).replace('{count}', String(model.photos.length))
    const href = photo => previewSource(photo.previewPath, document.baseURI)
    function measureStrip() {
      const node = strip.current
      const next = { back: Boolean(node && node.scrollLeft > 1), forward: Boolean(node && node.scrollWidth - node.clientWidth - node.scrollLeft > 1) }
      setEdges(prior => prior.back === next.back && prior.forward === next.forward ? prior : next)
    }
    React.useEffect(() => {
      const node = strip.current
      if (!node) return
      measureStrip()
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measureStrip) : null
      observer?.observe(node)
      return () => { observer?.disconnect(); cancelPhotoScroll(scrollMotion.current) }
    }, [photoKeys, showGallery])
    React.useEffect(() => { if (!showGallery) setSelectedId(null) }, [showGallery])
    function toggle() { setSelectedId(null); disclosure.toggle() }
    function slide(direction) {
      const node = strip.current
      if (!node) return
      slidePhotoStrip(node, direction, scrollMotion.current)
    }
    function changePhoto(direction) {
      const next = model.photos[selectedIndex + direction]
      if (selectedIndex >= 0 && next) setSelectedId(next.id)
    }
    function arrow(direction, disabled, onClick, label) {
      const button = h(UI.Button, { variant: 'ghost', size: 'sm', className: 'afp-chat-nav-button', disabled, onClick, 'aria-label': t(label) },
        h(direction < 0 ? icons.IconChevronLeftOutlineRegular : icons.IconChevronRightOutlineRegular, { size: 14 }))
      return h(UI.Tooltip, { label: t(label), side: 'top', portal: true }, button)
    }
    return h('section', { className: 'afp-chat-photos', 'data-tool': props.toolName, 'data-state': model.state, 'data-afp-summary': props.summary ? true : undefined, 'aria-label': t('agentPhotos') },
      h('div', { className: 'afp-chat-header' }, h(UI.DisclosureRow, { title: t(props.summary ? 'agentFinalPhotos' : process?.latest ? 'agentSummaryPhotos' : props.toolName === 'afp_photo_details' ? 'photoDetails' : props.toolName === 'afp_collection_items' ? 'collectionPhotos' : 'agentSearchResults'), icon: h(icons.IconSearchOutlineRegular, { size: 14 }),
        open: showGallery, expandable, onToggle: toggle,
        expandOnRowClick: true, keepContentWhenOpen: true, running: model.state === 'running',
        contentClassName: 'afp-chat-flow-content', contentLayoutClassName: 'afp-chat-flow-line',
        collapsedContent: h(React.Fragment, null, h('span', { className: 'afp-chat-separator', 'aria-hidden': true }, '·'),
          h('span', { className: 'afp-chat-summary', role: model.state === 'error' ? 'alert' : 'status', title: summary }, summary)) }),
      !showGallery && props.inspect ? h(UI.Button, { variant: 'ghost', size: 'sm', className: 'afp-chat-inspect', onClick: props.inspect }, t('agentInspectRecord')) : null),
      props.summary && model.basis ? h('p', { className: 'afp-chat-help' }, t(model.basis === 'visual' ? 'agentSelectionVisual' : 'agentSelectionMetadata')) : null,
      props.summary && model.criteria ? h('p', { className: 'afp-chat-help' }, t('agentSelectionCriteria') + model.criteria) : null,
      h(UI.AnimatedCollapse ?? React.Fragment, { open: showGallery }, showGallery ? h(React.Fragment, null,
      edges.back || edges.forward ? h('div', { className: 'afp-chat-strip-toolbar' },
        h('span', { className: 'afp-chat-help' }, t('agentPhotosBrowse')),
        h('div', { className: 'afp-chat-nav' }, arrow(-1, !edges.back, () => slide(-1), 'agentPreviousPhotos'), arrow(1, !edges.forward, () => slide(1), 'agentNextPhotos'))) : null,
      showGallery ? h('div', { ref: strip, className: 'afp-chat-photo-strip', role: 'region', 'aria-label': t('agentPhotos'),
        tabIndex: model.photos.length > 1 ? 0 : undefined, onScroll: measureStrip,
        onWheel: () => cancelPhotoScroll(scrollMotion.current), onPointerDown: () => cancelPhotoScroll(scrollMotion.current),
        onKeyDown: () => cancelPhotoScroll(scrollMotion.current) }, ...model.photos.map(photo => h('article', { className: 'afp-chat-photo-card', key: photo.id },
        h('div', { className: 'afp-chat-photo-frame' }, h(ImagePreview, { photo, retry: true, open: () => setSelectedId(photo.id) })),
        h('button', { className: 'afp-chat-photo-title', type: 'button', onClick: () => setSelectedId(photo.id) }, photoDisplayTitle(photo, t('photoDetails'))),
        h('div', { className: 'afp-chat-photo-footer' }, h('span', null, photo.provider?.replace(/^afpprovider:/i, '') || 'AFP'),
          h('a', { href: href(photo), target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${t('agentOpenPreview')} ${photoDisplayTitle(photo, t('photoDetails'))}` }, t('agentOpenPreview')))),
      )) : null,
      props.inspect ? h(UI.Button, { variant: 'ghost', size: 'sm', className: 'afp-chat-inspect', onClick: props.inspect }, t('agentInspectRecord')) : null) : null),
      props.summary && model.photos.length ? h('div', { className: 'afp-agent-result-table-wrap', tabIndex: 0, role: 'region', 'aria-label': t('agentFinalPhotos') }, h('table', { className: 'afp-agent-result-table' },
        h('thead', null, h('tr', null, ...['agentResultIndex', 'agentResultDescription', 'photoId', 'agentResultLink'].map(key => h('th', { key, scope: 'col' }, t(key))))),
        h('tbody', null, ...model.photos.map((photo, index) => h('tr', { key: photo.id }, h('td', null, index + 1),
          h('td', null, photo.caption || photo.title), h('td', null, h('code', null, photo.id)),
          h('td', null, h('a', { href: href(photo), target: '_blank', rel: 'noopener noreferrer' }, t('agentOpenPreview')))))))) : null,
      h(UI.Modal, { open: Boolean(selected), onClose: () => setSelectedId(null), title: selected ? photoDisplayTitle(selected, t('photoDetails')) : t('photoDetails'), closeLabel: t('close'),
        className: 'afp-wb-preview-modal afp-chat-preview-modal', contentClassName: 'afp-wb-preview-modal-content',
        onKeyDownCapture: event => {
          if (!selected || model.photos.length < 2 || event.altKey || event.ctrlKey || event.metaKey
            || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); event.stopPropagation(); changePhoto(event.key === 'ArrowLeft' ? -1 : 1)
          }
        },
        footer: selected ? h('div', { className: 'afp-chat-modal-footer' },
          h('a', { className: 'afp-chat-preview-link', href: href(selected), target: '_blank', rel: 'noopener noreferrer' }, t('agentOpenPreview'))) : null },
      selected ? h(React.Fragment, null,
        h('div', { className: 'afp-chat-modal-toolbar' }, selected.provider ? h(UI.Tag, { tone: 'neutral' }, selected.provider.replace(/^afpprovider:/i, '')) : null,
          model.photos.length > 1 ? h('div', { className: 'afp-chat-nav' }, arrow(-1, selectedIndex <= 0, () => changePhoto(-1), 'agentPreviousPhoto'),
            h('span', { className: 'afp-chat-photo-counter', role: 'status' }, `${selectedIndex + 1} / ${model.photos.length}`),
            arrow(1, selectedIndex === model.photos.length - 1, () => changePhoto(1), 'agentNextPhoto')) : null),
        h('div', { className: 'afp-chat-modal-image' }, h(ImagePreview, { key: selected.id, photo: selected, large: true, retry: true })),
        selected.caption ? h('p', { className: 'afp-chat-caption' }, selected.caption) : null,
        h('details', { className: 'afp-chat-identifiers', key: selected.id }, h('summary', null, t('photoIdentifiers')),
          h('dl', null, h('dt', null, t('photoId')), h('dd', null, selected.id)))) : null))
  }
}

/** Check whether the owning Turn has a nonempty explicit final selection.
 * @param {object} snapshot Current session's Chat snapshot, including hidden nodes.
 * @param {string} callId Tool identity, including nested dispatch calls.
 * @returns {boolean} Closed owner with photo evidence; unrelated Turns cannot hide this call.
 */
export function conversationCallHasSummary(snapshot, callId) {
  function contains(block) {
    return block.callId === callId || (block.subCalls ?? []).some(contains)
  }
  for (const node of snapshot.nodes.values()) {
    if (node.kind !== 'tool-call' || !contains(node.data.root)) continue
    const turn = node.location.kind === 'step' || node.location.kind === 'turn' ? node.location.turn : undefined
    if (turn?.status !== 'closed') return false
    const rows = snapshot.nodes.turnDataSource(turn.turn, 'tool-call').getSnapshot()
    return conversationSummaryPhotoModel(rows).photos.length > 0
  }
  return false
}

/** Collect this Turn's persisted AFP candidates, retaining order and one card per photo ID.
 * @param {Array} rows Turn-scoped tool roots, including hidden process nodes.
 * @returns {object} Safe photo metadata; failed and unrelated calls contribute nothing.
 */
export function conversationCandidateModel(rows) {
  const photos = [], seen = new Set()
  function visit(block) {
    if (block.kind === 'tool-result' && tools.includes(block.call?.name)) {
      for (const photo of conversationPhotoModel({ phase: 'result', block }).photos) {
        if (seen.has(photo.id)) continue
        seen.add(photo.id); photos.push(photo)
      }
    }
    for (const child of block.subCalls ?? []) visit(child)
  }
  for (const row of rows) visit(row.root)
  return { state: 'ok', message: photos.length ? 'agentPhotosCount' : 'noPhotos', photos }
}

/** Project the latest successful explicit selection; search pages never become final photos.
 * @param {Array} rows Turn-scoped persisted tool roots, including nested calls.
 * @returns {object} Final photos and their recorded screening basis; absence is an empty list.
 */
export function conversationSummaryPhotoModel(rows) {
  let model = { state: 'ok', message: 'noPhotos', photos: [] }
  function visit(block) {
    if (block.kind === 'tool-result' && block.call?.name === 'afp_photo_selection' && !block.isError) {
      try {
        const result = block.meta?.afp?.version === 1 ? block.meta.afp.result : JSON.parse(block.content.filter(item => item.type === 'text').map(item => item.text).join('\n'))
        if (['metadata', 'visual'].includes(result?.selection?.basis)) model = {
          ...conversationPhotoModel({ phase: 'result', block }), basis: result.selection.basis,
          criteria: typeof result.selection.criteria === 'string' ? result.selection.criteria : '',
        }
      } catch (error) { /* 旧日志缺少最终选择记录时，不能将候选推测为合格图片。 */ }
    }
    for (const child of block.subCalls ?? []) visit(child)
  }
  for (const row of rows) visit(row.root)
  return model
}

/** Keep a single merged candidate gallery on the owning Turn's latest successful read.
 * @param {object} snapshot Session Chat snapshot.
 * @param {string} callId Tool identity, including nested dispatch calls.
 * @returns {object|null} Latest-read flag and merged candidates, or null for an unknown owner.
 */
export function conversationCandidatePhotoModel(snapshot, callId) {
  const contains = block => block.callId === callId || (block.subCalls ?? []).some(contains)
  for (const node of snapshot.nodes.values()) {
    if (node.kind !== 'tool-call' || !contains(node.data.root)) continue
    const turn = node.location.kind === 'step' || node.location.kind === 'turn' ? node.location.turn : undefined
    if (!turn) return null
    const rows = snapshot.nodes.turnDataSource(turn.turn, 'tool-call').getSnapshot()
    let last
    function visit(block) {
      if (block.kind === 'tool-result' && tools.includes(block.call?.name) && conversationPhotoModel({ phase: 'result', block }).photos.length) last = block.callId
      for (const child of block.subCalls ?? []) visit(child)
    }
    for (const row of rows) visit(row.root)
    return { latest: callId === last, model: conversationCandidateModel(rows) }
  }
  return null
}

/** Render only a completed Turn's explicit final selection outside its folded process.
 * @param {object} React Client React runtime.
 * @param {Function} Cards Shared horizontal photo gallery and enlarged preview.
 * @param {object} store Authenticated plugin data access.
 * @param {Function} t Plugin locale translator.
 * @returns {Function} Final gallery or a missing-selection notice for new completed Turns.
 */
export function createAfpConversationSummary(React, Cards, store, t) {
  return function AfpConversationSummary({ turn, useChat, sessionId }) {
    const nodes = useChat(snapshot => snapshot.nodes)
    // 按本轮订阅隐藏的工具节点，避免当前搜索状态或其他轮次污染总结。
    const source = nodes.turnDataSource(turn.turn, 'tool-call')
    const rows = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    const hydrated = useAfpResolvedResults(React, store, sessionId, turn.turn, rows)
    const photoModel = conversationSummaryPhotoModel(hydrated)
    if (turn.status !== 'closed') return null
    if (!photoModel.photos.length) {
      const saved = block => Boolean(block.meta?.afp?.result?.resultRef) || (block.subCalls ?? []).some(saved)
      // 只有新版调用记录显示缺少最终选图的提示，旧会话保持原有展示。
      if (!hydrated.some(row => saved(row.root))) return null
      return React.createElement('p', { className: 'afp-chat-help', role: 'status' }, t(photoModel.basis ? 'agentFinalEmpty' : 'agentNoSavedFinalPhotos'))
    }
    return React.createElement(Cards, { summary: true, photoModel })
  }
}

/** Register the summary contribution without replacing the shipped turn or action renderer.
 * @param {object} ctx Client slot context.
 * @param {Function} Component Completed-Turn photos.
 * @param {string} locale Plugin locale namespace.
 * @returns {void} The registration is disposed with the plugin.
 */
export function registerAfpConversationSummary(ctx, Component, locale) {
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'afp.photos-summary', order: 60, locale,
  }, Component))
}

/** Register keyed AFP tool cards independently of optional workbench page entries.
 * @param {object} ctx Client slot context whose registration effects own disposal.
 * @param {Function} Component Inline photo view.
 * @param {string} locale Registered plugin locale namespace.
 * @returns {void} Pending slot injections and registrations follow the plugin lifetime.
 */
export function registerAfpConversationPhotos(ctx, Component, locale) {
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of tools) yield ctx.slots.register({ name: 'tool.call.toolview', key, locale }, Component)
  })
}
