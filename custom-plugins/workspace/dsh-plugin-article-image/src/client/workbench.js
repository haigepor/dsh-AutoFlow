/** Task-first editorial workbench using native AutoFlow primitives. */
import { createArtwork } from './artwork.js'
import { createControls } from './controls.js'
import { assetUrl, createRichArticle, runPresentation, promptSyncState, updatePlanShot } from './workflow-view.js'
import { createWorkflowPanels } from './workflow-panels.js'
import logo from '../../assets/article-image-logo.webp'

/** Compose article, prompt and review surfaces. @param {object} React React runtime. @param {object} ui Shared primitives. @param {object} store Profile store. @param {Function} t Locale lookup. @param {Function} toast App overlay notice. @returns {Function} Workbench component. */
export function createWorkbench(React, ui, store, t, toast) {
  const { Button, Input, Tag, StateDot, Checkbox, SegmentedControl, LinkIconMedium, IconFlatListOutlineRegular, IconRefreshOutlineRegular, IconSparkleRegular, IconSearchOutlineRegular, IconPanelLeftOutlineRegular, IconWarningOutlineRegular, IconPlusOutlineRegular, Modal, Tooltip, ImageLightbox } = ui
  const h = React.createElement
  const { Illustration } = createArtwork(React), { Select, Disclosure, ActionsMenu } = createControls(React, ui)
  const RichArticle = createRichArticle(React), { Diagnostics, Quality, Understanding, References } = createWorkflowPanels(React, ui, t)
  const activeStates = new Set(['fetching', 'queued', 'capturing', 'understanding', 'planning', 'checking', 'running'])
  const tone = value => activeStates.has(value) ? 'info' : ({ failed: 'danger', approved: 'success', interrupted: 'warning', review: 'warning', 'needs-source-review': 'warning', 'waiting-config': 'warning' })[value] ?? 'quiet'
  const dotState = value => activeStates.has(value) ? 'ongoing' : ({ failed: 'error', approved: 'done', interrupted: 'warning', review: 'warning', 'needs-source-review': 'warning', 'waiting-config': 'warning' })[value] ?? 'idle'
  function displayTitle(item) {
    if (item.article?.title || item.sourceHash) return item.article?.title || item.title
    try {
      const url = new URL(item.url), slug = url.pathname.split('/').filter(Boolean).at(-1)
      return slug ? decodeURIComponent(slug).replace(/\.(?:html?|shtml|ghtml)$/i, '').replace(/[-_]/g, ' ') : url.hostname
    } catch { return item.title || item.url }
  }
  return function Workbench() {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const { status, page, detail, busy } = state
    const initialEditor = React.useMemo(() => store.getEditorDraft(state.selected), [])
    const [url, setUrl] = React.useState(''), [mapping, setMapping] = React.useState({ link: 'Links', category: 'Category', language: '', notes: '' })
    const [tab, setTab] = React.useState(initialEditor?.tab ?? 'article'), [draft, setDraft] = React.useState(initialEditor?.draft ?? null), [baseRevision, setBaseRevision] = React.useState(initialEditor?.baseRevision ?? 0)
    const [dirty, setDirty] = React.useState(initialEditor?.dirty ?? false), [manual, setManual] = React.useState(initialEditor?.manual ?? false), [manualTitle, setManualTitle] = React.useState(initialEditor?.manualTitle ?? ''), [manualBody, setManualBody] = React.useState(initialEditor?.manualBody ?? '')
    const [selected, setSelected] = React.useState([])
    const [query, setQuery] = React.useState(''), [pendingNavigation, setPendingNavigation] = React.useState(null)
    const [sourceOpen, setSourceOpen] = React.useState(false), [importError, setImportError] = React.useState('')
    const [importResult, setImportResult] = React.useState(null), [manualDirty, setManualDirty] = React.useState(initialEditor?.manualDirty ?? false)
    const [collapsed, setCollapsed] = React.useState(false), queueId = React.useId()
    const [draftOrigin, setDraftOrigin] = React.useState(initialEditor?.draftOrigin ?? null), [syncPromptShots, setSyncPromptShots] = React.useState(initialEditor?.syncPromptShots ?? [])
    const [sourceEvidence, setSourceEvidence] = React.useState(''), [inspectedAsset, setInspectedAsset] = React.useState(null), [pendingBlock, setPendingBlock] = React.useState('')
    const priorRun = React.useRef(null)
    React.useEffect(() => { if (status && !url) { setUrl(status.source.url); setMapping(status.source.mapping) } }, [status])
    React.useEffect(() => {
      const cached = store.getEditorDraft(detail?.id)
      setDraft(cached?.draft ?? (detail?.plan ? structuredClone(detail.plan) : null)); setDraftOrigin(cached?.draftOrigin ?? (detail?.plan ? structuredClone(detail.plan) : null)); setSyncPromptShots(cached?.syncPromptShots ?? []); setSourceEvidence(''); setInspectedAsset(null); setPendingBlock(''); setBaseRevision(cached?.baseRevision ?? detail?.revision ?? 0); setDirty(cached?.dirty ?? false); setManual(cached?.manual ?? false); setManualBody(cached?.manualBody ?? ''); setManualTitle(cached?.manualTitle ?? ''); setManualDirty(cached?.manualDirty ?? false)
      if (cached) setTab(cached.tab)
    }, [detail?.id])
    React.useEffect(() => {
      if (!dirty && detail) { setDraft(detail.plan ? structuredClone(detail.plan) : null); setDraftOrigin(detail.plan ? structuredClone(detail.plan) : null); setSyncPromptShots([]); setBaseRevision(detail.revision) }
    }, [detail?.revision, dirty])
    React.useEffect(() => {
      if (!detail?.id) return
      // 页面切换会卸载面板；草稿保存在 profile Client store，保留原始 revision，直到明确保存或丢弃。
      if (dirty || manualDirty) store.setEditorDraft(detail.id, { tab, draft, draftOrigin, baseRevision, dirty, manual, manualTitle, manualBody, manualDirty, syncPromptShots })
      else store.clearEditorDraft(detail.id)
    }, [detail?.id, tab, draft, draftOrigin, baseRevision, dirty, manual, manualTitle, manualBody, manualDirty, syncPromptShots])
    React.useEffect(() => { setSourceEvidence(''); setInspectedAsset(null) }, [detail?.snapshot?.id])
    const closeAsset = React.useCallback(() => setInspectedAsset(null), [])
    const editable = status?.features.includes('tools') && !busy
    const progress = runPresentation(detail?.run), active = progress.active || activeStates.has(detail?.state)
    const prerequisite = status?.browser && !status.browser.available ? status.browser : status?.analysis && !status.analysis.available ? status.analysis : null
    const reviewed = detail?.state === 'approved' && !detail?.legacy && detail?.approval && detail?.plan?.inputHash
    const pendingPrompts = draft ? promptSyncState(draft, draftOrigin, syncPromptShots) : []
    React.useEffect(() => {
      if (priorRun.current?.id === detail?.run?.id && ['queued', 'running'].includes(priorRun.current?.status) && detail?.run?.status === 'review' && !dirty && !manualDirty) setTab('prompts')
      priorRun.current = detail?.run ?? null
    }, [detail?.run?.id, detail?.run?.status, dirty, manualDirty])
    React.useEffect(() => {
      if (tab !== 'article' || !pendingBlock) return
      const block = document.getElementById(`article-image-block-${pendingBlock}`)
      block?.scrollIntoView({ block: 'center' }); block?.focus({ preventScroll: true }); setPendingBlock('')
    }, [tab, pendingBlock, detail?.snapshot?.id])
    const visibleItems = (page?.items ?? []).filter(item => `${displayTitle(item)} ${item.url} ${item.category}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    const navigate = callback => { if (dirty || manualDirty) setPendingNavigation(() => callback); else callback() }
    const openManual = () => navigate(() => { setManualTitle(detail.article?.title ?? ''); setManualBody(detail.article?.paragraphs.map(paragraph => paragraph.text).join('\n\n') ?? ''); setManualDirty(false); setManual(true) })
    React.useEffect(() => {
      if (!dirty && !manualDirty) return
      const prevent = event => { event.preventDefault(); event.returnValue = '' }
      window.addEventListener('beforeunload', prevent)
      return () => window.removeEventListener('beforeunload', prevent)
    }, [dirty, manualDirty])
    const act = async (operation, args) => {
      try { const value = await store.mutate(operation, args); if (value) { toast(t(['fetch', 'process', 'resume'].includes(operation) ? 'fetchStarted' : operation === 'stop' ? 'stopRequested' : 'saved'), 'success'); return true } }
      catch (error) { toast(t(`error_${error.message}`) || t('error_operation-failed'), 'error') }
      return false
    }
    const updateShot = (index, key, value) => { setDraft(current => updatePlanShot(current, index, key, value)); setSyncPromptShots(current => current.filter(offset => offset !== index)); setDirty(true) }
    const updateBrief = (key, value) => { setDraft(current => ({ ...current, brief: { ...current.brief, [key]: value } })); setSyncPromptShots([]); setDirty(true) }
    const locateBlock = id => { setTab('article'); setPendingBlock(id) }
    const inspectAsset = id => {
      const asset = detail.snapshot?.assets.find(item => item.id === id), src = asset?.status === 'ready' ? assetUrl(detail.snapshot.id, id) : ''
      if (src) setInspectedAsset({ ...asset, src }); else toast(t('assetUnavailable'), 'error')
    }
    const field = (label, value, change, multiline = false) => h('label', { className: 'ai-field', key: label }, h('span', null, label),
      multiline ? h('textarea', { value, disabled: busy || active && !sourceOpen, 'aria-label': label, onChange: event => change(event.target.value), rows: 3 }) : h(Input, { className: 'ai-input', value, disabled: busy || active && !sourceOpen, onChange: event => change(event.target.value) }))
    const button = (label, onClick, disabled = false, extra = {}) => h(Button, { onClick, disabled, size: 'sm', variant: 'outline', ...extra }, label)
    const empty = (kind, title, text, actions) => h('div', { className: 'ai-empty-block' }, h(Illustration, { kind }), h('h3', null, title), h('p', null, text), actions && h('div', { className: 'ai-actions' }, actions))
    const stateLabel = value => t(`state_${value}`)
    if (!status) return h('main', { className: 'article-image-workbench ai-loading' }, state.error
      ? h('div', { role: 'alert' }, t('loadFailed'), button(t('retry'), () => store.reload()))
      : h('span', { className: 'ai-spinner', role: 'status', 'aria-label': t('loading') }))
    return h('main', { className: 'article-image-workbench' },
      h('header', { className: 'ai-heading' }, h('div', { className: 'ai-brand' }, h('img', { src: logo, alt: '', width: 27, height: 27, className: 'ai-logo' }), h('h1', null, t('title'))),
        h('div', { className: 'ai-header-actions' }, h(Tooltip, { label: t('generationHint'), portal: true }, h('span', null, h(Tag, { tone: 'quiet' }, t('phaseOne')))), button(t('import'), () => { setImportError(''); setImportResult(null); setSourceOpen(true) }, !editable, { variant: page?.total ? 'outline' : 'primary', icon: h(IconPlusOutlineRegular, { size: 14 }) }), button(t('refresh'), () => store.reload(), busy, { icon: h(IconRefreshOutlineRegular, { size: 14 }) }))),
      prerequisite && detail?.run?.error !== prerequisite.code ? h('div', { className: 'ai-fetch-notice', role: 'status' }, h(IconWarningOutlineRegular, { size: 16 }), h('span', null, t(`error_${prerequisite.code}`) || t('analysisConfigHint'))) : null,
      h(Modal, { open: sourceOpen, onClose: () => { if (!busy) setSourceOpen(false) }, title: t('source'), closeLabel: t('close'), description: t('sourceReadOnly'), className: 'ai-modal ai-import-modal', contentClassName: 'ai-import-content',
        footer: h('div', { className: 'ai-actions ai-import-footer' }, button(t('close'), () => setSourceOpen(false), busy, { variant: 'ghost' }), button(t(busy ? 'importing' : 'import'), async () => {
          setImportError(''); setImportResult(null)
          try { const result = await store.mutate('import', { url, mapping }); if (result) { setImportResult(result); toast(t('saved'), 'success') } }
          catch (error) { setImportError(t(`error_${error.message}`) || t('error_operation-failed')) }
        }, !editable || !url.trim() || !mapping.link.trim(), { variant: 'primary' })) },
        h('fieldset', { className: 'ai-import-form', disabled: busy }, field(t('sheetUrl'), url, setUrl), h('div', { className: 'ai-mappings' }, ...Object.keys(mapping).map(key => field(t(`mapping_${key}`), mapping[key], value => setMapping(current => ({ ...current, [key]: value })))))) ,
        importError ? h('p', { className: 'ai-notice', role: 'alert' }, importError) : null,
        importResult ? h('div', { className: 'ai-import-report', role: 'status' }, h('p', null, t('importSummary').replace('{added}', String(importResult.added)).replace('{updated}', String(importResult.updated)).replace('{rejected}', String(importResult.rejectedCount))),
          ...importResult.rejected.map(row => h('span', { key: row.row, className: 'ai-row-error' }, `${t('row')} ${row.row}: ${t(`error_${row.code}`)}`))) : null),
      h('div', { className: 'ai-layout', 'data-collapsed': collapsed },
        h('aside', { className: 'ai-queue', 'aria-label': t('articles') },
          h('div', { className: 'ai-queue-header' }, h('h2', null, h(IconFlatListOutlineRegular, { size: 16 }), t('articles')), h('span', { className: 'ai-queue-count' }, h(Tag, { tone: 'neutral' }, String(page?.total ?? 0))),
            h(Tooltip, { label: t(collapsed ? 'expandQueue' : 'collapseQueue'), portal: true }, button('', () => setCollapsed(!collapsed), false, { variant: 'ghost', className: 'ai-icon-button ai-queue-toggle', 'aria-label': t(collapsed ? 'expandQueue' : 'collapseQueue'), 'aria-expanded': !collapsed, 'aria-controls': queueId, icon: h(IconPanelLeftOutlineRegular, { size: 16 }) }))),
          h('div', { className: 'ai-queue-content', id: queueId, inert: collapsed ? '' : undefined, 'aria-hidden': collapsed },
          h(Input, { className: 'ai-input ai-search', value: query, placeholder: t('searchPage'), 'aria-label': t('searchPage'), icon: h(IconSearchOutlineRegular, { size: 16 }), onChange: event => setQuery(event.target.value) }),
          h(Select, { label: t('category'), value: state.category, options: [{ value: '', label: t('allCategories') }, ...(page?.categories ?? []).filter(Boolean).map(category => ({ value: category, label: category }))], onChange: category => navigate(() => { setSelected([]); setQuery(''); store.filter(category) }) }),
          h('div', { className: 'ai-actions ai-selection-bar' }, h(Checkbox, { className: 'ai-checkbox', label: t('selectPage'), checked: visibleItems.length > 0 && visibleItems.every(item => selected.includes(item.id)), onChange: checked => setSelected(checked ? visibleItems.map(item => item.id) : []) }),
            button(t('fetchSelected') + (selected.length ? ` (${selected.length})` : ''), () => act('process', { ids: selected }), !editable || !selected.length)),
          h('div', { className: 'ai-list' }, !visibleItems.length && page?.total ? h('p', { className: 'ai-empty', role: 'status' }, t('noMatches')) : null, ...visibleItems.map(item => h('div', { key: item.id, className: 'ai-item', 'data-selected': state.selected === item.id },
            h(Checkbox, { className: 'ai-checkbox ai-select', checked: selected.includes(item.id), label: t('selectArticle').replace('{title}', displayTitle(item)), onChange: checked => setSelected(current => checked ? [...current, item.id] : current.filter(id => id !== item.id)) }),
            h('button', { type: 'button', className: 'ai-item-open', onClick: () => { if (item.id !== state.selected) navigate(() => store.select(item.id)) }, 'aria-pressed': state.selected === item.id, title: displayTitle(item) },
              h('span', { className: 'ai-item-title' }, displayTitle(item)),
              h('span', { className: 'ai-item-meta' }, h('span', { className: 'ai-item-domain' }, new URL(item.url).hostname.replace(/^www\d?\./, '')), h('span', { className: 'ai-item-category' }, item.category || t('uncategorized')))),
            h(Tooltip, { label: stateLabel(item.state), portal: true }, h('span', { className: 'ai-item-status', role: 'img', 'aria-label': stateLabel(item.state), 'data-tone': tone(item.state) }, item.state === 'failed' ? h(IconWarningOutlineRegular, { size: 14 }) : h(StateDot, { state: dotState(item.state), size: 12 })))))),
          page?.total ? h('nav', { className: 'ai-actions', 'aria-label': t('pagination') }, button(t('previous'), () => navigate(() => { setSelected([]); setQuery(''); store.page(page.previousOffset) }), !state.offset),
            h('small', null, `${state.offset + 1}–${state.offset + page.items.length} / ${page.total}`), button(t('next'), () => navigate(() => { setSelected([]); setQuery(''); store.page(page.nextOffset) }), page.nextOffset === null)) : h('p', { className: 'ai-empty' }, t('empty')))),
        h('section', { className: 'ai-detail', 'aria-label': t('articleDetail') }, detail ? h(React.Fragment, null,
          h('header', { className: 'ai-detail-header' }, h('div', { className: 'ai-detail-meta' }, h('div', { className: 'ai-meta' }, h(Tag, { tone: 'neutral' }, detail.category || t('uncategorized')), h(Tag, { tone: tone(detail.state) }, stateLabel(detail.state)),
            detail.article?.language ? h('span', { className: 'ai-language' }, detail.article.language) : null),
            h('a', { href: detail.url, target: '_blank', rel: 'noreferrer', className: 'ai-source-link', 'aria-label': t('openSource'), title: detail.url }, h(LinkIconMedium, { kind: 'url', href: detail.url, size: 14 }), new URL(detail.url).hostname.replace(/^www\d?\./, ''))),
            h('h2', { title: displayTitle(detail) }, displayTitle(detail))),
          h('div', { className: 'ai-content-toolbar' },
            h(SegmentedControl, { id: 'article-image-detail', className: 'ai-tabs', label: t('articleDetail'), value: tab, onChange: setTab, options: ['article', 'prompts', 'results', 'diagnostics'].map(value => ({ value, label: t(`tab_${value}`) })) }),
            h('div', { className: 'ai-actions ai-context-actions' },
              progress.canStop ? button(t('stop'), () => act('stop', { id: detail.run.id }), !editable) : progress.canResume ? button(t('resume'), () => navigate(() => act('resume', { id: detail.run.id })), !editable) : null,
              tab === 'article' ? h(React.Fragment, null,
              button(t(detail.snapshot ? 'reprocess' : 'fetch'), () => navigate(() => act('process', { ids: [detail.id], ...(detail.snapshot ? { reprocess: true } : {}) })), !editable || active, { variant: detail.article || detail.error ? 'outline' : 'primary', icon: h(IconRefreshOutlineRegular, { size: 14 }) }),
              button(t('manual'), openManual, !editable || active, { variant: 'ghost' })) : tab === 'prompts' ? button(t('reprocess'), () => navigate(() => act('process', { ids: [detail.id], reprocess: true })), !editable || active, { icon: h(IconSparkleRegular, { size: 14 }) }) : null,
              h(ActionsMenu, { label: t('articleActions'), items: [
                { id: 'manual', label: t('manual'), disabled: !editable || active, run: openManual },
                { id: 'skip', label: t('skip'), disabled: !editable || active, run: () => navigate(() => act('skip', { id: detail.id, revision: detail.revision })) },
              ] }))),
          detail.error ? h('div', { className: 'ai-fetch-notice', role: 'alert' }, h(IconWarningOutlineRegular, { size: 16 }), h('span', null, t(`error_${detail.error}`) || t('error_operation-failed'))) : null,
          detail.legacy ? h('p', { className: 'ai-fetch-notice' }, t('legacyNeedsRefetch')) : null,
          h(Modal, { open: manual, onClose: () => navigate(() => { setManual(false); setManualBody(''); setManualDirty(false) }), title: t('manual'), closeLabel: t('close'), description: t('manualHint'), className: 'ai-modal',
            footer: button(t('saveBody'), async () => { if (await act('manual', { id: detail.id, revision: detail.revision, title: manualTitle, text: manualBody, language: detail.language })) { setManual(false); setManualBody(''); setManualDirty(false) } }, !editable || !manualTitle.trim() || !manualBody.trim(), { variant: 'primary' }) },
            field(t('manualTitle'), manualTitle, value => { setManualTitle(value); setManualDirty(true) }), field(t('manualBody'), manualBody, value => { setManualBody(value); setManualDirty(true) }, true)),
          tab === 'article' ? h('div', { className: 'ai-body', role: 'tabpanel', id: 'article-image-detail-article-panel', 'aria-labelledby': 'article-image-detail-article', 'aria-busy': active && !detail.snapshot && !detail.article }, detail.snapshot ? h(React.Fragment, null,
            h(Quality, { snapshot: detail.snapshot, review: detail.sourceReview, evidence: sourceEvidence, onEvidence: setSourceEvidence, disabled: !editable || active, canReview: detail.state === 'needs-source-review', onReview: () => navigate(() => act('review-source', { id: detail.id, revision: detail.revision, evidence: sourceEvidence })) }),
            h('div', { className: 'ai-reading-meta' }, h('span', null, t('blockAndAssetCount').replace('{blocks}', String(detail.snapshot.blocks.length)).replace('{assets}', String(detail.snapshot.assets.length))), button(t('planStep'), () => setTab('prompts'), false, { variant: 'ghost' })),
            h(RichArticle, { snapshot: detail.snapshot, t, onInspectAsset: setInspectedAsset })) : detail.article ? h(React.Fragment, null,
            h('p', { className: 'ai-fetch-notice' }, t('legacyNeedsRefetch')),
            h('div', { className: 'ai-reading-meta' }, h('span', null, t(detail.article.basis === 'manual' ? 'manualBasis' : 'webBasis'), ' · ', t('paragraphCount').replace('{count}', String(detail.article.paragraphs.length))), button(t('planStep'), () => setTab('prompts'), false, { variant: 'ghost' })),
            ...detail.article.paragraphs.map(paragraph => h('p', { key: paragraph.id }, h('span', { className: 'ai-paragraph-id' }, String(paragraph.id)), paragraph.text))) : active ? h('div', { className: 'ai-empty-block ai-retrieving', role: 'status' }, h(Illustration, { animated: true }), h('h3', null, t('retrieving')), h('p', null, t('retrievingHint'))) : empty('article', t(detail.error ? 'fetchFailedTitle' : 'bodyEmptyTitle'), t(detail.error ? 'manualHint' : 'bodyEmpty'), detail.error ? button(t('manual'), openManual, !editable || active, { variant: 'primary' }) : null)) : null,
          tab === 'prompts' ? h('div', { className: 'ai-editor', role: 'tabpanel', id: 'article-image-detail-prompts-panel', 'aria-labelledby': 'article-image-detail-prompts' }, draft ? h(React.Fragment, null,
            dirty && detail.revision !== baseRevision ? h('p', { role: 'alert', className: 'ai-notice' }, t('staleDraft'), button(t('loadLatest'), () => navigate(() => { setDraft(detail.plan ? structuredClone(detail.plan) : null); setDraftOrigin(detail.plan ? structuredClone(detail.plan) : null); setBaseRevision(detail.revision); setSyncPromptShots([]); setDirty(false) }))) : null,
            h(Understanding, { value: detail.analysis?.understanding ?? draft.understanding, input: detail.analysis?.input, rulesOutdated: detail.rulesOutdated, onBlock: locateBlock, onAsset: inspectAsset }),
            h('section', { className: 'ai-brief' }, h('div', { className: 'ai-section-heading' }, h('h3', null, t('articleUnderstanding')), h(Tag, { tone: dirty ? 'warning' : 'quiet' }, t(dirty ? 'unsaved' : 'savedPlan'))),
              field(t('theme'), draft.brief.theme, value => updateBrief('theme', value)),
              h('div', { className: 'ai-brief-grid' }, ...['facts', 'subjects', 'scenes'].map(key => field(t(key), draft.brief[key].join('\n'), value => updateBrief(key, value.split('\n').filter(Boolean)), true)))),
            ...draft.shots.map((shot, index) => h('section', { className: 'ai-shot', key: index }, h('div', { className: 'ai-actions' }, h('h3', null, `${t(shot.purpose)} ${index + 1}`),
              shot.purpose === 'inline' ? button(t('removeShot'), () => { setDraft(current => ({ ...current, shots: current.shots.filter((_, offset) => offset !== index), ...(current.shortfall ? { shortfall: { ...current.shortfall, actual: current.shots.length - 1 } } : {}) })); setSyncPromptShots([]); setDirty(true) }, !editable || active) : null),
              shot.blockIds ? h(References, { blockIds: shot.blockIds, assetIds: shot.assetIds, onBlock: locateBlock, onAsset: inspectAsset }) : null,
              shot.informationGoal !== undefined ? field(t('informationGoal'), shot.informationGoal, value => updateShot(index, 'informationGoal', value)) : null,
              h('div', { className: 'ai-shot-meta' }, shot.blockIds ? field(t('sourceBlockIds'), shot.blockIds.join(', '), value => {
                const ids = value.split(',').map(part => part.trim()).filter(Boolean)
                setDraft(current => updatePlanShot(updatePlanShot(current, index, 'blockIds', ids), index, 'paragraphs', ids.map(id => Number(id.replace(/^b/, ''))))); setSyncPromptShots(current => current.filter(offset => offset !== index)); setDirty(true)
              }) : field(t('paragraphs'), shot.paragraphs.join(', '), value => updateShot(index, 'paragraphs', value.split(',').map(Number))),
                draft.inputHash ? h('div', { className: 'ai-field' }, h('span', null, t('ratio')), h('span', null, shot.ratio), h('small', { className: 'ai-subtle' }, t('frozenRatioHint'))) : h(Select, { label: t('ratio'), value: shot.ratio, options: ['16:9', '4:3', '3:2', '1:1', '9:16'].map(value => ({ value, label: value })), onChange: value => updateShot(index, 'ratio', value) })),
              shot.afterBlockId !== undefined ? h(Select, { label: t('insertAfterBlock'), value: shot.afterBlockId, disabled: !editable || active, options: (detail.snapshot?.blocks ?? []).map(block => ({ value: block.id, label: block.id })), onChange: value => updateShot(index, 'afterBlockId', value) }) : null,
              shot.visualMode !== undefined ? h(Select, { label: t('visualMode'), value: shot.visualMode, disabled: !editable || active, options: ['conceptual', 'source-grounded'].map(value => ({ value, label: t(`visualMode_${value}`) })), onChange: value => updateShot(index, 'visualMode', value) }) : null,
              field(t('rationale'), shot.rationale, value => updateShot(index, 'rationale', value)),
              field(t('prompt'), shot.prompt, value => updateShot(index, 'prompt', value), true),
              h(Disclosure, { title: t('sceneDetails'), className: 'ai-shot-details' }, h('div', { className: 'ai-scene-grid' }, ...['subject', 'action', 'environment', 'composition', 'lighting', 'colors', 'style', 'details', 'avoid'].map(key => field(t(key), shot[key], value => updateShot(index, key, value), ['avoid', 'details'].includes(key))))),
              pendingPrompts.includes(index) ? h('div', { className: 'ai-prompt-sync', role: 'status' }, h('p', null, t('promptNeedsSync')), button(t('confirmPromptSync'), () => { setSyncPromptShots(current => [...current.filter(offset => offset !== index), index]); setDirty(true) }, !editable || active)) : syncPromptShots.includes(index) ? h('p', { className: 'ai-subtle' }, t('promptSyncConfirmed')) : null)),
            draft.shortfall?.actual < draft.shortfall?.requested ? h('p', { className: 'ai-fetch-notice' }, t('shotShortfall').replace('{actual}', String(draft.shortfall.actual)).replace('{requested}', String(draft.shortfall.requested)), ' ', draft.shortfall.reason) : null,
            draft.shortfall?.actual < draft.shortfall?.requested ? field(t('shortfallReason'), draft.shortfall.reason, value => { setDraft(current => ({ ...current, shortfall: { ...current.shortfall, reason: value } })); setDirty(true) }, true) : null,
            h('div', { className: 'ai-actions ai-review-bar' }, button(t('addShot'), () => { setDraft(current => ({ ...current, shots: [...current.shots, { ...current.shots[current.shots.length - 1], purpose: 'inline' }], ...(current.shortfall ? { shortfall: { ...current.shortfall, actual: current.shots.length + 1, ...(current.shots.length + 1 === current.shortfall.requested ? { reason: '' } : {}) } } : {}) })); setDirty(true) }, !editable || active || draft.shots.length >= (draft.shortfall?.requested ?? 12), { icon: h(IconPlusOutlineRegular, { size: 14 }) }),
              button(t('savePlan'), async () => { if (await act('save-plan', { id: detail.id, revision: baseRevision, plan: draft, syncPromptShots })) setDirty(false) }, !editable || active || !dirty || baseRevision !== detail.revision || draft.shortfall?.actual < draft.shortfall?.requested && !draft.shortfall.reason.trim(), { variant: 'primary' }),
              button(t('approve'), () => act('approve', { id: detail.id, revision: detail.revision }), !editable || active || dirty || pendingPrompts.length > 0 || detail.state !== 'review', { variant: dirty ? 'outline' : 'primary' })),
            h('p', { className: 'ai-subtle' }, t('approvalHint'))) : active ? h('div', { className: 'ai-empty-block ai-retrieving', role: 'status' }, h(Illustration, { kind: 'prompts', animated: true }), h('h3', null, t(`stage_${progress.stage}`) || t('retrieving')), h('p', null, t(`activity_${progress.stage}`) || t('progressActivityHint'))) : h(React.Fragment, null, h(Understanding, { value: detail.analysis?.understanding, input: detail.analysis?.input, rulesOutdated: detail.rulesOutdated, onBlock: locateBlock, onAsset: inspectAsset }), empty('prompts', t('promptsEmptyTitle'), t('promptsEmpty'), button(t('fetch'), () => navigate(() => act('process', { ids: [detail.id] })), !editable || active, { variant: 'primary' })))) : null,
          tab === 'diagnostics' ? h('div', { className: 'ai-diagnostics-page', role: 'tabpanel', id: 'article-image-detail-diagnostics-panel', 'aria-labelledby': 'article-image-detail-diagnostics' }, detail.run ? h(Diagnostics, { key: detail.run.attemptId ?? detail.run.id, run: detail.run, clientError: state.error }) : empty('article', t('diagnosticsTitle'), t('diagnosticsNoRun'))) : null,
          tab === 'results' ? h('div', { className: 'ai-result-empty', role: 'tabpanel', id: 'article-image-detail-results-panel', 'aria-labelledby': 'article-image-detail-results' }, empty('results', t(reviewed ? 'reviewComplete' : 'reviewPending'), t(reviewed ? 'reviewCompleteHint' : 'reviewPendingHint'), button(t('reviewStep'), () => setTab('prompts'), !draft))) : null,
        ) : h('p', { className: 'ai-empty' }, t('chooseArticle'))),
      inspectedAsset ? h(ImageLightbox, { src: inspectedAsset.src, alt: inspectedAsset.alt ?? '', labels: { dialog: t('inspectOriginal'), close: t('close') }, onClose: closeAsset }) : null,
      h(Modal, { open: !!pendingNavigation, onClose: () => setPendingNavigation(null), title: t('unsavedTitle'), description: t('unsavedHint'), closeLabel: t('close'), footer: h('div', { className: 'ai-actions' },
        button(t('keepEditing'), () => setPendingNavigation(null)), button(t('discard'), () => { const proceed = pendingNavigation; store.clearEditorDraft(detail.id); setPendingNavigation(null); setDirty(false); setManualBody(''); setManualDirty(false); proceed() }, false, { variant: 'primary' })) })))
  }
}
