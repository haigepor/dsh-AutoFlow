import { createAfpGallery } from './afp-workbench-gallery.js'
import { createAfpTaskPanels } from './afp-workbench-tasks.js'
import { createAfpSelector } from './afp-selector.js'
import { createAfpDownloadDialog } from './afp-download-dialog.js'
import { createAfpSearchInput } from './afp-search-input.js'
import { createAfpAddFavoritesDialog } from './afp-add-favorites-dialog.js'

const tabs = ['search', 'collections', 'tasks', 'changes', 'account']

/** Shared AFP workbench tabs, profile metadata and account form.
 * @param {object} React React client runtime.
 * @param {object} UI Existing DSH primitives.
 * @param {object} ctx Client context for localized feature metadata.
 * @param {Function} t Locale lookup function.
 * @param {object} store Shared AFP workbench state and actions.
 * @param {Function} ConfigurationForm Existing account configuration editor.
 * @param {object} [icons] Optional exported DSH icon components.
 * @returns {Function} Workbench React component.
 */
export function createWorkbench(React, UI, ctx, t, store, ConfigurationForm, icons = {}) {
  const h = React.createElement
  const { Button, Input, Switch, Tag, Toast, StateDot, SegmentedControl, Tooltip, Modal, Checkbox, GlideHighlight } = UI
  const Selector = createAfpSelector(React, UI, icons.IconChevronDownOutlineRegular)
  const Gallery = createAfpGallery(React, UI, icons, t, store)
  const DownloadDialog = createAfpDownloadDialog(React, UI, icons, t, store, Gallery.ImagePreview)
  const SearchInput = createAfpSearchInput(React, UI, icons, t)
  const AddFavoritesDialog = createAfpAddFavoritesDialog(React, UI, icons, t, store, Gallery.ImagePreview)
  const TaskPanels = createAfpTaskPanels(React, UI, t, store, Gallery, Selector, icons)

  function handleTab(tab) {
    store.selectTab(tab)
    const state = store.getSnapshot()
    if (tab === 'collections' && !state.regions.collections.data && !state.regions.collections.loading) {
      void store.loadCollections().then(() => {
        const latest = store.getSnapshot(), first = latest.regions.collections.data?.items?.find(item => item.name?.trim())
        if (first && !latest.collectionId && !latest.regions.collection.loading) void store.openCollection(first.id)
      })
    }
    if (tab === 'tasks' && !state.regions.runs.data && !state.regions.runs.loading) void store.loadHistory('runs')
    if (tab === 'changes') {
      if (!state.regions.runs.data && !state.regions.runs.loading) void store.loadHistory('runs')
      if (!state.regions.plans.data && !state.regions.plans.loading) void store.loadHistory('plans')
    }
    if (tab === 'account' && !state.account && !state.regions.account.loading) void store.loadAccount()
  }

  function BrandGlyph() {
    return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
      h('rect', { x: 2.5, y: 3.5, width: 19, height: 17, rx: 4, stroke: 'currentColor', strokeWidth: 1.5 }),
      h('circle', { cx: 8, cy: 9, r: 1.5, fill: 'currentColor' }),
      h('path', { d: 'm5 17 4.5-4.5 3 3L16 11l3 6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
  }

  function ImageSkeleton() {
    return h('div', { className: 'afp-wb-gallery afp-wb-skeleton-grid', 'aria-hidden': true }, ...Array.from({ length: 6 }, (_, index) =>
      h(Gallery.PhotoSkeleton, { key: index })))
  }

  function SearchPanel({ state }) {
    const region = state.regions.search, data = region.data
    const loadingMore = region.loading && region.loadMode === 'more'
    const searching = region.loading && !loadingMore
    const credentials = state.account?.credentials
    const accountMissing = credentials && !credentials.accessTokenRef?.configured
      && !(credentials.usernameRef?.configured && credentials.passwordRef?.configured)
    const submit = event => { event.preventDefault(); void store.searchPhotos() }
    const count = Object.keys(state.selectedPhotos).length
    const canAdd = count > 0 && count <= 120 && !state.busy && !state.collectionSelecting
      && state.status?.features?.includes('read') && state.status?.features?.includes('write')
    const addButton = h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-collection-action', disabled: !canAdd,
      'aria-label': t('addFavorites'), onClick: () => store.openAddFavorites() },
      icons.IconFolderOpenOutlineRegular ? h(icons.IconFolderOpenOutlineRegular, { size: 17 }) : null)
    return h('div', { className: 'afp-wb-panel-content afp-wb-search-layout', 'aria-busy': region.loading },
      h('form', { className: 'afp-wb-search-toolbar', onSubmit: submit },
        h(SearchInput, { value: state.queryDraft, enabled: state.tab === 'search', onChange: queryDraft => store.set({ queryDraft }) }),
        h(Selector, { className: 'afp-wb-language', value: state.language, label: t('searchLanguage'),
          options: [{ value: '', label: t('deploymentDefault') }, ...['en', 'fr', 'es', 'ar', 'de', 'pt'].map(language => ({ value: language, label: t(`language_${language}`) }))],
          onChange: language => store.set({ language }) }),
        h(Button, { variant: 'primary', type: 'submit', 'aria-busy': searching,
          disabled: !state.queryDraft.trim() || searching || !state.status?.features?.includes('read'),
          icon: searching ? h(UI.StateDot, { state: 'ongoing', size: 14 }) : icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null }, t('search'))),
      data || Object.keys(state.selectedPhotos).length ? h('div', { className: 'afp-wb-result-bar' },
        h('p', null, data ? `${t('showingPhotos')} ${data.items.length}` : ''),
        h('div', { className: 'afp-wb-actions' },
          h(Button, { variant: state.selectionOpen ? 'outline' : 'ghost', size: 'sm', 'aria-expanded': state.selectionOpen,
            onClick: () => store.set({ selectionOpen: !state.selectionOpen }) }, t('selectionList'),
            h(Tag, { tone: 'quiet' }, String(count))),
          Tooltip ? h(Tooltip, { label: t(count > 120 ? 'favoritesSelectionLimit' : !state.status?.features?.includes('write') ? 'favoritesPermissionsRequired' : 'addFavorites'), side: 'top', portal: true }, addButton) : addButton)) : null,
      region.error && region.loadMode !== 'more' ? h('div', { className: 'afp-wb-error-row', role: 'alert' }, h('span', null, t('regionReadFailed')),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.searchPhotos() } }, t('retry'))) : null,
      !data && region.loading ? h(ImageSkeleton) : null,
      !data && !region.loading && !region.error && !state.selectionOpen ? h('div', { className: 'afp-wb-empty-block' },
        h('span', { className: 'afp-wb-empty-icon', 'aria-hidden': true }, h(BrandGlyph)),
        h('p', null, t(accountMissing ? 'accountRequired' : 'searchPrompt')),
        accountMissing || !state.status?.features?.includes('read') ? h(Button, { variant: 'outline', size: 'sm', onClick: () => handleTab('account') }, t('openAccountSettings')) : null) : null,
      data && !data.items.length && !region.loading && !region.error && !state.selectionOpen && !state.detail ? h('div', { className: 'afp-wb-empty-block', role: 'status' },
        h('span', { className: 'afp-wb-empty-icon', 'aria-hidden': true }, icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 24 }) : h(BrandGlyph)),
        h('p', null, t('noPhotos'))) : null,
      data || state.selectionOpen || state.detail ? h('div', { className: `afp-wb-gallery-layout${state.selectionOpen || state.detail ? ' is-with-aside' : ''}` },
        data ? h('div', { className: 'afp-wb-gallery-wrap' }, h(Gallery.PhotoGrid, { items: data.items, selectedPhotos: state.selectedPhotos, loading: loadingMore }),
          region.error && region.loadMode === 'more' ? h('div', { className: 'afp-wb-error-row', role: 'alert' }, h('span', null, t('loadMoreFailed')),
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.searchPhotos({ more: true }) } }, t('retry'))) : null,
          data.hasMore && !region.error ? h('div', { className: 'afp-wb-load-row' }, h(Button, { variant: 'outline', disabled: region.loading, 'aria-busy': region.loading,
            icon: region.loading ? h(UI.StateDot, { state: 'ongoing', size: 14 }) : null,
            onClick: () => { void store.searchPhotos({ more: true }) } }, t('loadMore'))) : null,
          loadingMore ? h('span', { className: 'afp-wb-visually-hidden', role: 'status' }, t('loading')) : null,
          data.paginationStopped ? h('p', { className: 'afp-wb-pagination-note', role: 'status' }, t('paginationPaused')) : null) : null,
        state.selectionOpen ? h(Gallery.SelectionPane, { photos: Object.values(state.selectedPhotos), onOpen: photo => { void store.openPhoto(photo); store.set({ selectionOpen: false }) } })
          : state.detail && state.tab === 'search' ? h(Gallery.DetailPane, { photo: state.detail, loading: state.regions.detail.loading, error: state.regions.detail.error, onClose: () => store.closePhoto() }) : null) : null)
  }

  function CollectionSelectionActions({ state }) {
    const selected = Object.values(state.selectedPhotos)
    const allSelected = store.isCollectionFullySelected()
    const bulkLabel = state.collectionSelecting ? 'cancelSelectAll' : allSelected ? 'deselectCollection' : 'selectAllCollection'
    const page = state.regions.collection
    const sources = state.photoSources ?? {}
    const collections = state.regions.collections.data?.items ?? []
    const writable = collections.filter(item => item.name?.trim() && !item.readOnly)
    const writeEnabled = state.status?.features?.includes('write')
    const canRemove = writeEnabled && selected.length > 0 && selected.every(photo => {
      const ids = sources[photo.id] ?? []
      return ids.length > 0 && ids.every(id => collections.some(item => item.id === id && !item.readOnly))
    })
    const canTransfer = writeEnabled && writable.length > 0 && selected.length > 0
    const canDownload = state.status?.features?.includes('read') && selected.length > 0 && selected.length <= 120
    const action = (key, iconName, enabled, value) => {
      const Icon = icons[iconName]
      const button = h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-collection-action', disabled: !enabled || state.collectionSelecting,
        'aria-label': t(key), onClick: () => store.set({ collectionAction: value }) }, Icon ? h(Icon, { size: 17 }) : null)
      return Tooltip ? h(Tooltip, { key, label: t(key === 'downloadSelection' && selected.length > 120 ? 'downloadSelectionLimit' : key), side: 'top', portal: true }, button) : button
    }
    return h('div', { className: 'afp-wb-collection-selection', role: 'group', 'aria-label': t('selectionList') },
      h(Button, { variant: allSelected ? 'outline' : 'ghost', size: 'sm', className: 'afp-wb-select-all',
        disabled: !state.status?.features?.includes('read') || !state.collectionId || page.loading || !page.data?.total || state.busy || Boolean(state.collectionAction),
        'aria-pressed': allSelected, 'aria-busy': state.collectionSelecting,
        icon: state.collectionSelecting ? h(StateDot, { state: 'ongoing', size: 14 }) : icons.IconCheckOutlineRegular ? h(icons.IconCheckOutlineRegular, { size: 14 }) : null,
        onClick: () => { void store.toggleCollectionSelection() } }, t(bulkLabel)),
      h(Button, { variant: 'outline', size: 'sm', className: 'afp-wb-selection-summary',
        'aria-label': `${t('selectionList')} · ${t('selectedPhotoCount').replace('{count}', String(selected.length))}`,
        'aria-expanded': state.selectionOpen, onClick: () => store.set({ selectionOpen: !state.selectionOpen }) },
        selected.length ? h('span', { className: 'afp-wb-selection-thumbnails', 'aria-hidden': true }, ...selected.slice(0, 3).map(photo =>
          h('span', { className: 'afp-wb-selection-thumbnail', key: photo.id }, h(Gallery.ImagePreview, { photo, retry: false }))),
          selected.length > 3 ? h('span', { className: 'afp-wb-selection-overflow' }, `+${selected.length - 3}`) : null) : null,
        h('span', { className: 'afp-wb-selection-label' }, t('selectionList')),
        h(Tag, { tone: selected.length ? 'info' : 'neutral', className: 'afp-wb-selection-count' }, String(selected.length)),
        icons.IconChevronDownOutlineRegular ? h(icons.IconChevronDownOutlineRegular, { size: 14, className: 'afp-wb-selection-chevron' }) : null),
      h('div', { className: 'afp-wb-collection-actions' },
        action('downloadSelection', 'IconDownloadOutlineRegular', canDownload, 'download'),
        action('removeSelection', 'IconTrashOutlineRegular', canRemove, 'remove'),
        action('transferSelection', 'IconFolderOpenOutlineRegular', canTransfer, 'transfer')))
  }

  function CollectionActionDialogs({ state }) {
    const [transferMode, setTransferMode] = React.useState('copy')
    const [targetCollectionId, setTargetCollectionId] = React.useState('')
    const action = state.collectionAction
    const photos = Object.values(state.selectedPhotos)
    const collections = state.regions.collections.data?.items ?? []
    const writable = collections.filter(item => item.name?.trim() && !item.readOnly)
    const sources = state.photoSources ?? {}
    const canMove = photos.length > 0 && photos.every(photo => {
      const ids = sources[photo.id] ?? []
      return ids.length > 0 && ids.every(id => collections.some(item => item.id === id && !item.readOnly))
    })
    const targets = writable.filter(item => transferMode === 'copy' || !photos.some(photo => (sources[photo.id] ?? []).includes(item.id)))
    React.useEffect(() => {
      if (action === 'transfer') { setTransferMode('copy'); setTargetCollectionId('') }
    }, [action])
    const close = () => store.set({ collectionAction: null, collectionActionResult: null, downloadError: '', downloadPlan: null, downloadQuoteChanged: false })
    const selectionRows = h('div', { className: 'afp-wb-action-summary' }, h('strong', null, t('selectedPhotoCount').replace('{count}', String(photos.length))))
    const footer = (...children) => h('div', { className: 'afp-wb-dialog-footer' }, ...children)
    const transferDisabled = state.busy || !targetCollectionId || transferMode === 'move' && !canMove
    const submitTransfer = () => { void store.submitCollectionOperation(transferMode, targetCollectionId) }
    const submitRemove = () => { void store.submitCollectionOperation('remove') }
    const removeBody = h('div', { className: 'afp-wb-operation-dialog' }, selectionRows,
      h('p', null, t('removeFavoritesWarning')),
      state.collectionActionResult ? h('div', { className: 'afp-wb-operation-result', role: 'status' },
        h('strong', null, t('operationResult').replace('{count}', String(state.collectionActionResult.completed ?? 0))),
        h('p', null, `${t('partial')}: ${state.collectionActionResult.partial ?? 0} · ${t('failed')}: ${state.collectionActionResult.failed ?? 0} · ${t('pending')}: ${state.collectionActionResult.pending ?? 0}`)) : null,
      state.downloadError ? h('p', { className: 'afp-wb-error-row', role: 'alert' }, t('collectionActionFailed')) : null)
    const transferBody = h('div', { className: 'afp-wb-operation-dialog' }, selectionRows,
      h('div', { className: 'afp-wb-transfer-mode' }, ...['copy', 'move'].map(mode => h(Button, { key: mode, variant: transferMode === mode ? 'primary' : 'outline', size: 'sm',
        disabled: mode === 'move' && !canMove || state.busy, onClick: () => { setTransferMode(mode); setTargetCollectionId('') } }, t(mode)))),
      transferMode === 'move' && !canMove ? h('p', { className: 'afp-wb-subtle' }, t('moveSourceRequired')) : null,
      h('div', { className: 'afp-wb-dialog-field' }, h('span', null, t('targetCollection')),
        h(Selector, { value: targetCollectionId, label: t('targetCollection'), disabled: !targets.length || state.busy,
          options: [{ value: '', label: t('chooseTarget'), disabled: true }, ...targets.map(item => ({ value: item.id, label: item.name }))],
          onChange: setTargetCollectionId })),
      state.collectionActionResult ? h('div', { className: 'afp-wb-operation-result', role: 'status' },
        h('strong', null, t('operationResult').replace('{count}', String(state.collectionActionResult.completed ?? 0))),
        h('p', null, `${t('partial')}: ${state.collectionActionResult.partial ?? 0} · ${t('failed')}: ${state.collectionActionResult.failed ?? 0} · ${t('pending')}: ${state.collectionActionResult.pending ?? 0}`)) : null,
      state.downloadError ? h('p', { className: 'afp-wb-error-row', role: 'alert' }, t('collectionActionFailed')) : null)
    return h(React.Fragment, null,
      h(DownloadDialog, { state, onAccount: () => handleTab('account'), onTasks: () => handleTab('tasks') }),
      Modal ? h(Modal, { open: action === 'remove', onClose: close, title: t('removeFavoritesTitle'), closeLabel: t('close'),
        className: 'afp-wb-action-modal afp-wb-operation-modal', contentClassName: 'afp-wb-action-modal-content',
        footer: footer(h(Button, { variant: 'ghost', onClick: close, disabled: state.busy }, t('cancel')),
          state.collectionActionResult ? h(Button, { variant: 'primary', onClick: close }, t('close')) : h(Button, { variant: 'primary', disabled: state.busy,
            onClick: submitRemove }, state.busy ? t('working') : t('removeFromFavorites'))) }, removeBody) : null,
      Modal ? h(Modal, { open: action === 'transfer', onClose: close, title: t('transferSelectionTitle'), closeLabel: t('close'),
        className: 'afp-wb-action-modal afp-wb-operation-modal', contentClassName: 'afp-wb-action-modal-content',
        footer: footer(h(Button, { variant: 'ghost', onClick: close, disabled: state.busy }, t('cancel')),
          state.collectionActionResult ? h(Button, { variant: 'primary', onClick: close }, t('close')) : h(Button, { variant: 'primary', disabled: transferDisabled,
            onClick: submitTransfer }, state.busy ? t('working') : t('confirmTransfer'))) }, transferBody) : null)
  }

  function CollectionsPanel({ state }) {
    const list = state.regions.collections, page = state.regions.collection
    const selected = page.data?.collection ?? list.data?.items?.find(item => item.id === state.collectionId)
    const [collapsed, setCollapsed] = React.useState(false)
    const [showTop, setShowTop] = React.useState(false)
    const scroller = React.useRef(null), toggle = React.useRef(null)
    const sidebarId = React.useId()
    const name = item => item?.name?.trim() || t('unnamedCollection')
    // 未归档项没有上游名称；目录和首次选取都只使用已命名收藏夹。
    const filtered = (list.data?.items ?? []).filter(item => item.name?.trim() && name(item).toLowerCase().includes(state.collectionFilter.toLowerCase()))
    const toggleButton = h(Button, { ref: toggle, variant: 'ghost', size: 'sm', className: 'afp-wb-sidebar-toggle',
      'aria-label': t(collapsed ? 'expandCollections' : 'collapseCollections'), 'aria-expanded': !collapsed, 'aria-controls': sidebarId,
      onClick: () => { toggle.current?.focus(); setCollapsed(value => !value) } },
      icons.IconPanelLeftOutlineRegular ? h(icons.IconPanelLeftOutlineRegular, { size: 18 }) :
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: 'currentColor', strokeWidth: 1.5 }),
          h('path', { d: 'M9 4v16', stroke: 'currentColor', strokeWidth: 1.5 })))
    React.useEffect(() => {
      if (scroller.current) scroller.current.scrollTop = 0
      setShowTop(false)
    }, [state.collectionId])
    const backToTop = () => {
      const target = scroller.current
      if (!target) return
      target.focus({ preventScroll: true })
      target.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    }
    return h('div', { className: 'afp-wb-collections-layout' + (collapsed ? ' is-sidebar-collapsed' : '') },
      h('div', { className: 'afp-wb-collection-controls' },
        h('div', { className: 'afp-wb-collection-filter-slot', inert: collapsed ? '' : undefined, 'aria-hidden': collapsed },
          h(Input, { className: 'afp-wb-input afp-wb-filter', value: state.collectionFilter, placeholder: t('filterCollections'), 'aria-label': t('filterCollections'),
            icon: icons.IconSearchOutlineRegular ? h(icons.IconSearchOutlineRegular, { size: 16 }) : null,
            onChange: event => store.set({ collectionFilter: event.target.value }) })),
        Tooltip ? h(Tooltip, { label: t(collapsed ? 'expandCollections' : 'collapseCollections'), side: 'top', portal: true }, toggleButton) : toggleButton),
      h('aside', { id: sidebarId, className: 'afp-wb-collection-sidebar', 'aria-label': t('tab_collections') },
        h('div', { className: 'afp-wb-collection-directory-heading' }, h('span', null, t('tab_collections')), h(Tag, { tone: 'quiet' }, String(filtered.length))),
        list.error ? h('div', { role: 'alert', className: 'afp-wb-error-row' }, t('regionReadFailed'), h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.loadCollections() } }, t('retry'))) : null,
        list.loading && !list.data ? h('div', { className: 'afp-wb-collection-skeleton', role: 'status', 'aria-label': t('loading') },
          ...Array.from({ length: 8 }, (_, index) => h('span', { key: index, className: 'afp-skeleton' }))) : null,
        h('nav', { className: 'afp-wb-collection-list', 'aria-label': t('tab_collections') },
          GlideHighlight ? h(GlideHighlight, { className: 'afp-wb-collection-glide', rowSelector: '.afp-wb-collection-item' }) : null,
          ...filtered.map(item => {
          const label = [name(item), t(item.readOnly ? item.isPrivate ? 'readOnly' : 'sharedReadOnly' : 'private'),
            item.count == null ? '' : `${t('documentCount')} ${item.count}`].filter(Boolean).join(' · ')
          const button = h(Button, { variant: 'ghost', size: 'sm', key: item.id,
          className: 'afp-wb-collection-item' + (state.collectionId === item.id ? ' is-selected' : ''),
          'aria-label': label,
          'aria-pressed': state.collectionId === item.id, onClick: () => { void store.openCollection(item.id) } },
          icons.IconFolderCloseRegular ? h(icons.IconFolderCloseRegular, { size: 16, 'aria-hidden': true }) : null,
          h('span', { className: 'afp-wb-collection-mark', 'aria-hidden': true }, Array.from(name(item))[0].toLocaleUpperCase()),
          h('span', { className: 'afp-wb-collection-selected-dot', 'aria-hidden': true }),
          h('span', { className: 'afp-wb-collection-name' }, name(item)),
          h('span', { className: 'afp-wb-collection-end' },
          item.readOnly ? h(Tag, { tone: 'quiet' }, t(item.isPrivate ? 'readOnly' : 'sharedReadOnly')) : null,
          item.count !== null && item.count !== undefined ? h('span', { className: 'afp-wb-collection-count', 'aria-hidden': true }, h(Tag, { tone: 'quiet' }, String(item.count))) : null))
          // 折叠时保留同一个按钮与完整可访问名称，简称只改变视觉呈现。
          return Tooltip ? h(Tooltip, { key: item.id, label, side: 'right', portal: true, maxWidth: 240 }, button) : button
          })),
        !list.loading && !list.error && list.data && !filtered.length ? h('p', { className: 'afp-wb-empty' }, t('noCollections')) : null),
      h('div', { className: 'afp-wb-collection-content' },
        h('div', { className: 'afp-wb-section-heading afp-wb-collection-heading' },
          h('div', { className: 'afp-wb-collection-heading-left' },
            h('div', null, h('h3', null, selected ? name(selected) : t('selectCollection')),
              selected ? h('p', { className: 'afp-wb-subtle' }, t(selected.readOnly ? selected.isPrivate ? 'readOnly' : 'sharedReadOnly' : 'private') +
                (page.data ? ' · ' + t('photoCount') + ': ' + page.data.total : '')) : null)),
          h(CollectionSelectionActions, { state })),
        state.collectionSelectionError ? h('div', { className: 'afp-wb-error-row', role: 'alert' }, t('selectAllFailed'),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.toggleCollectionSelection() } }, t('retry'))) : null,
        page.error ? h('div', { className: 'afp-wb-error-row', role: 'alert' }, t(page.loadMode === 'more' ? 'loadMoreFailed' : 'regionReadFailed'),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => { if (state.collectionId) void (page.loadMode === 'more' ? store.loadMoreCollection() : store.openCollection(state.collectionId)) } }, t('retry'))) : null,
        h('div', { className: 'afp-wb-collection-stage' },
          h('div', { className: 'afp-wb-gallery-layout' + (state.selectionOpen || state.detail ? ' is-with-aside' : '') },
            h('div', { ref: scroller, className: 'afp-wb-gallery-wrap afp-wb-collection-scroll', tabIndex: -1, role: 'region', 'aria-label': t('collectionPhotos'),
              'aria-busy': page.loading, onScroll: event => setShowTop(event.currentTarget.scrollTop > event.currentTarget.clientHeight / 2) },
              page.loading && !page.data ? h(ImageSkeleton) : null,
              page.data ? h(Gallery.PhotoGrid, { items: page.data.items, selectedPhotos: state.selectedPhotos, sourceCollectionId: state.collectionId, loading: page.loading && page.loadMode === 'more' }) : null,
              page.data?.hasMore && !page.error ? h('div', { className: 'afp-wb-load-row' }, h(Button, { variant: 'outline', disabled: page.loading, 'aria-busy': page.loading,
                icon: page.loading ? h(StateDot, { state: 'ongoing', size: 14 }) : null, onClick: () => { void store.loadMoreCollection() } }, t('loadMore'))) : null,
              page.data?.paginationStopped ? h('p', { className: 'afp-wb-pagination-note', role: 'status' }, t('paginationPaused')) : null,
              !page.data && !page.loading && !page.error && !list.error ? h('p', { className: 'afp-wb-empty' }, t('collectionPrompt')) : null),
          state.selectionOpen ? h(Gallery.SelectionPane, { photos: Object.values(state.selectedPhotos), onOpen: photo => { void store.openPhoto(photo); store.set({ selectionOpen: false }) } })
              : state.detail && state.tab === 'collections' ? h(Gallery.DetailPane, { photo: state.detail, loading: state.regions.detail.loading, error: state.regions.detail.error, sourceCollectionId: state.collectionId, onClose: () => store.closePhoto() }) : null),
          showTop ? h(Button, { variant: 'outline', size: 'sm', className: 'afp-wb-back-top', onClick: backToTop, 'aria-label': t('backToTop') },
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
              h('path', { d: 'm6 12 6-6 6 6M12 6v13', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))) : null),
      h(CollectionActionDialogs, { state })))
  }

  function AccountProfile({ state }) {
    const region = state.regions.profile, user = region.data
    const configured = state.account?.token?.configured
    const ready = configured && state.status?.features?.includes('read')
    const display = value => value || t('notAvailable')
    const field = (key, value) => h('div', { key }, h('dt', null, t(key)), h('dd', null, display(value)))
    return h('aside', { className: 'afp-wb-user-profile', 'aria-label': t('accountInformation'), 'aria-busy': region.loading },
      h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('accountInformation')),
        h(Tooltip, { label: t('refreshAccount'), portal: true, maxWidth: 180 },
          h(Button, { variant: 'ghost', size: 'sm', disabled: !ready || region.loading, 'aria-busy': region.loading,
            onClick: () => { void store.loadProfile() }, 'aria-label': t('refreshAccount') },
            region.loading ? h(UI.StateDot, { state: 'ongoing', size: 14 }) : icons.IconRefreshOutlineRegular ? h(icons.IconRefreshOutlineRegular, { size: 16 }) : t('refresh')))),
      region.loading && !user ? h('div', { className: 'afp-wb-profile-skeleton', role: 'status', 'aria-label': t('loading') },
        ...Array.from({ length: 5 }, (_, index) => h('span', { className: 'afp-skeleton', key: index }))) : null,
      region.error ? h('div', { className: 'afp-wb-profile-error', role: 'alert' }, h('p', null, t('accountReadFailed')),
        h(Button, { variant: 'outline', size: 'sm', disabled: !ready || region.loading, onClick: () => { void store.loadProfile() } }, t('retry'))) : null,
      user ? h(React.Fragment, null,
        h('div', { className: 'afp-wb-user-identity' }, h('span', { className: 'afp-wb-user-avatar', 'aria-hidden': true }, (user.firstName || user.login || 'A').slice(0, 1).toUpperCase()),
          h('div', null, h('h4', null, [user.firstName, user.lastName].filter(Boolean).join(' ') || display(user.login)), h('p', null, display(user.login)))),
        h('div', { className: 'afp-wb-user-credit' }, h('span', null, t('creditBalance')), h('strong', null, user.credit == null ? t('notAvailable') : String(user.credit))),
        h('dl', { className: 'afp-wb-user-fields' }, field('accountEmail', user.email), field('accountId', user.id), field('clientId', user.clientId)),
        user.subjectToCredit !== null ? h('p', { className: 'afp-wb-subtle' }, t(user.subjectToCredit ? 'creditBilling' : 'subscriptionBilling')) : null) : null,
      !user && !region.loading && !region.error ? h('p', { className: 'afp-wb-subtle' }, t(configured ? 'enableReadForAccount' : 'loginToViewAccount')) : null)
  }

  function FeatureTile({ feature, state }) {
    const [expanded, setExpanded] = React.useState(false)
    const [failedIcon, setFailedIcon] = React.useState('')
    const detailsId = React.useId()
    const title = ctx.locale.resolveText(feature.title)
    const status = feature.running ? 'running' : feature.enabled ? 'selected' : 'unselected'
    const Icon = icons[{ script: 'IconCodeOutlineRegular', skill: 'IconSkillOutlineRegular', ui: 'IconPanelLeftOutlineRegular' }[feature.kind]]
    const Chevron = icons.IconChevronDownOutlineRegular
    return h('div', { className: `afp-wb-feature-tile${expanded ? ' is-expanded' : ''}` },
      h('div', { className: 'afp-wb-feature-line' },
        h('span', { className: 'afp-wb-feature-icon', 'aria-hidden': true }, feature.icon && failedIcon !== feature.icon
          ? h('span', { className: 'afp-wb-feature-artwork', style: { maskImage: `url("${feature.icon}")`, WebkitMaskImage: `url("${feature.icon}")` } },
            h('img', { src: feature.icon, alt: '', onError: () => setFailedIcon(feature.icon) }))
          : Icon ? h(Icon, { size: 18 }) : null),
        h('div', { className: 'afp-wb-feature-identity' },
          h('button', { type: 'button', className: 'afp-wb-feature-title', 'aria-expanded': expanded, 'aria-controls': detailsId,
            onClick: () => setExpanded(current => !current) }, h('span', null, title), Chevron ? h(Chevron, { size: 12 }) : null),
          h('span', { className: 'afp-wb-feature-status', 'data-state': status }, h('span', { className: 'afp-wb-feature-dot', 'aria-hidden': true }), t(status))),
        h(Switch, { checked: state.pendingTargets[feature.id] ?? feature.enabled, label: title, loading: state.saving.includes(feature.id),
          onChange: next => { void store.toggle(feature.id, next) } })),
      h('div', { id: detailsId, className: 'afp-wb-feature-details', 'aria-hidden': !expanded },
        h('div', { className: 'afp-wb-feature-details-inner' }, h('p', null, ctx.locale.resolveText(feature.description)))))
  }

  function AccountPanel({ state }) {
    const account = state.account
    const [section, setSection] = React.useState('credentials')
    const sectionId = React.useId()
    const featureKinds = ['script', 'skill', 'ui']
    React.useEffect(() => {
      const region = state.regions.profile
      if (state.tab === 'account' && section === 'credentials' && state.account?.token?.configured
        && state.status?.features?.includes('read') && !region.data && !region.loading && !region.error) void store.loadProfile()
    }, [state.tab, section, state.account, state.status, state.regions.profile])
    const saveDone = () => { void store.resetAndReload() }
    const featureGroups = featureKinds.map(kind => {
      const features = (state.features ?? []).filter(feature => feature.kind === kind)
      if (!features.length) return null
      return h('section', { key: kind, className: 'afp-wb-feature-group' },
        h('div', { className: 'afp-wb-feature-group-heading' }, h('h4', null, t(kind)), h(Tag, { tone: 'quiet' }, String(features.length))),
        h('div', { className: 'afp-wb-feature-grid' }, ...features.map(feature => h(FeatureTile, { key: feature.id, feature, state }))))
    })
    return h('div', { className: 'afp-wb-account-layout' },
      h('div', { className: 'afp-wb-account-nav' },
        h(SegmentedControl, { id: sectionId, value: section, label: t('accountSections'), className: 'afp-wb-account-segments',
          options: ['credentials', 'vision', 'features'].map(value => ({ value, label: t(`accountSection_${value}`) })), onChange: setSection }),
        account?.profile ? h('span', { className: 'afp-wb-subtle afp-wb-account-profile' }, `${t('profile')} · ${account.profile}`) : null),
      state.regions.account.error ? h('div', { className: 'afp-wb-error-row', role: 'alert' }, t('regionReadFailed'), h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.loadAccount() } }, t('retry'))) : null,
      // 表单保持挂载；切换分区不会丢失尚未保存的账号、密钥或模型草稿。
      h('div', { hidden: section === 'features', className: 'afp-wb-account-body' + (section === 'credentials' ? ' is-credentials' : '') },
        h(ConfigurationForm, { view: 'page', className: 'afp-wb-config-form', section, sectionId, onSaved: saveDone }),
        h('div', { hidden: section !== 'credentials', className: 'afp-wb-profile-slot' }, h(AccountProfile, { state }))),
      h('section', { role: 'tabpanel', id: `${sectionId}-features-panel`, 'aria-labelledby': `${sectionId}-features`, hidden: section !== 'features', className: 'afp-wb-feature-section' },
        h('div', { className: 'afp-wb-feature-groups' }, ...featureGroups)))
  }

  return function AfpWorkbench() {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const id = React.useId()
    const keydown = (event, index) => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault()
      handleTab(tabs[next])
      const target = event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next]
      target?.focus()
      target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
    const renderTab = (tab, index) => {
      const selected = state.tab === tab
      const iconsByTab = { search: 'IconSearchOutlineRegular', collections: 'IconFolderCloseRegular', tasks: 'IconFlatListOutlineRegular', changes: 'IconRefreshOutlineRegular', account: 'IconSettingsOutlineRegular' }
      const Icon = icons[iconsByTab[tab]]
      return h('button', { type: 'button', role: 'tab', id: `${id}-tab-${tab}`, key: tab,
        'aria-selected': selected, 'aria-controls': `${id}-panel-${tab}`, tabIndex: selected ? 0 : -1,
        className: `afp-wb-tab${selected ? ' is-active' : ''}`, onClick: () => handleTab(tab), onKeyDown: event => keydown(event, index) },
        Icon ? h(Icon, { size: 16 }) : null, t(`tab_${tab}`))
    }
    const renderPanel = (tab, content) => h('section', { role: 'tabpanel', id: `${id}-panel-${tab}`, 'aria-labelledby': `${id}-tab-${tab}`,
      className: `afp-wb-tabpanel afp-wb-panel-${tab}`, hidden: state.tab !== tab, key: tab }, content)
    const tokenExpired = state.account?.token?.expiresAt != null && state.account.token.expiresAt <= Date.now()
    return h('main', { className: 'afp-workbench afp-wb-root', onKeyDown: event => {
      if (event.target.closest?.('[role="dialog"]') || event.key !== 'Escape' || !state.detail && !state.selectionOpen) return
      event.stopPropagation()
      store.closePhoto()
      store.set({ selectionOpen: false })
    } },
      h('header', { className: 'afp-wb-header' },
        h('div', { className: 'afp-wb-brand' }, h(BrandGlyph), h('h1', null, t('workbenchTitle'))),
        h('div', { className: 'afp-wb-header-actions' },
          state.account?.username ? h('span', { className: 'afp-wb-profile' }, state.account.username) : null,
          state.account ? h(Tag, { tone: tokenExpired ? 'warning' : state.account.token?.verifiedAt ? 'success' : 'neutral' }, t(tokenExpired ? 'tokenExpired' : state.account.token?.verifiedAt ? 'tokenVerified' : state.account.token?.configured ? 'tokenUnverified' : 'missing'))
            : state.regions.account.error ? h('span', { className: 'afp-wb-subtle' }, t('accountUnavailable')) : h('span', { className: 'afp-skeleton afp-skeleton-label', 'aria-label': t('loading') }))),
      state.error ? h('p', { className: 'afp-wb-global-error', role: 'alert' }, t('operationFailed')) : null,
      h('div', { className: 'afp-wb-tabstrip', role: 'tablist', 'aria-label': t('workbenchTabs') }, ...tabs.map(renderTab)),
      h('div', { className: `afp-wb-content afp-wb-content-${state.tab}` },
        renderPanel('search', h(SearchPanel, { state })),
        renderPanel('collections', h(CollectionsPanel, { state })),
        renderPanel('tasks', h(TaskPanels.TasksPanel, { state, onOpenAccount: () => handleTab('account'), onOpenChanges: runId => { store.set({ runId }); handleTab('changes'); void store.loadHistory('plans') } })),
        renderPanel('changes', h(TaskPanels.ChangesPanel, { state })),
        renderPanel('account', state.accountVisited ? h(AccountPanel, { state }) : null)),
      h(AddFavoritesDialog, { state }),
      Toast && state.toast ? h(Toast, { key: `${state.toast}:${state.result?.taskId ?? state.result?.runId ?? ''}`,
        text: t(state.toast), tone: 'success', holdMs: 4000, onDone: () => store.set({ toast: '' }) }) : null)
  }
}
