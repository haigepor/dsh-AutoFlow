import { feedbackStages } from './afp-conversation-feedback.js'
import { createDiagnosticsPanel } from './afp-diagnostics-panel.js'

/** Local task controls and protected remote-write previews for the AFP profile.
 * @param {object} React React client runtime.
 * @param {object} UI Existing DSH primitives.
 * @param {Function} t Locale lookup function.
 * @param {object} store Shared task state and actions.
 * @param {object} gallery Shared gallery component factories.
 * @param {Function} Selector Project Menu choice composition.
 * @param {object} [icons] Project disclosure icons.
 * @returns {object} Task and change panel components.
 */
export function createAfpTaskPanels(React, UI, t, store, gallery, Selector, icons = {}) {
  const h = React.createElement
  const { Button, Checkbox, Input, Tag, StateDot, Tooltip, Modal, Menu } = UI
  const categoryKeys = ['animals', 'food', 'landscape', 'movie-poster', 'celestial-body-wallpaper']
  const DiagnosticsPanel = createDiagnosticsPanel(React, UI, t, store)

  function ReportBack() {
    return h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-report-back',
      onClick: () => store.set({ runId: '', regions: { ...store.getSnapshot().regions, run: { data: null, loading: false, error: '' } } }) },
    icons.IconChevronLeftOutlineRegular ? h(icons.IconChevronLeftOutlineRegular, { size: 16, 'aria-hidden': true }) : null, t('back'))
  }

  function ReportMetricIcon({ kind }) {
    const paths = {
      category: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
      reviewedCount: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z',
      filter_kept: 'm8 12 3 3 5-6', filter_rejected: 'M8 12h8', requestFailures: 'M12 8v5m0 3v.1',
    }
    return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    kind === 'filter_kept' || kind === 'filter_rejected' ? h('circle', { cx: 12, cy: 12, r: 9 }) : null,
    kind === 'requestFailures' ? h('path', { d: 'm10.3 3.9-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z' }) : null,
    h('path', { d: paths[kind] }), kind === 'reviewedCount' ? h('circle', { cx: 12, cy: 12, r: 3 }) : null)
  }

  function HistorySkeleton() {
    return h('div', { className: 'afp-wb-history-skeleton', role: 'status', 'aria-label': t('loading') },
      ...Array.from({ length: 3 }, (_, index) => h('div', { key: index, 'aria-hidden': true },
        h('span', { className: 'afp-skeleton' }), h('span', { className: 'afp-skeleton' }), h('span', { className: 'afp-skeleton' }))))
  }
  function MoreMenu({ label, items, onSelect, disabled = false, className = '' }) {
    const [open, setOpen] = React.useState(false), trigger = React.useRef(null)
    return h(Menu, { open: open && !disabled, onClose: () => setOpen(false), portal: true, compact: true, autoFocus: true,
      getAnchorRect: () => trigger.current?.getBoundingClientRect() ?? null, items,
      onSelect: id => { setOpen(false); onSelect(id) },
      anchor: h(Button, { ref: trigger, variant: 'ghost', size: 'sm', disabled, className,
        'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open && !disabled,
        onClick: () => setOpen(value => !value) }, icons.IconEllipsisOutlineRegular ? h(icons.IconEllipsisOutlineRegular, { size: 16, 'aria-hidden': true }) : h('span', { 'aria-hidden': true }, '⋯')) })
  }

  function CategoryChoices({ state, disabled = false }) {
    return h('div', { className: 'afp-wb-categories' }, ...categoryKeys.map(category => h('div', {
      key: category, className: 'afp-wb-category-option', 'data-selected': state.selected.includes(category) },
    h(Checkbox, { disabled, checked: state.selected.includes(category), label: t(category),
      onChange: () => store.set({ selected: state.selected.includes(category) ? state.selected.filter(value => value !== category) : [...state.selected, category] }) }),
    h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-category-more', disabled: !state.status?.features?.includes('read'),
      'aria-label': `${t('manageCategoryBinding')} · ${t(category)}`, 'aria-haspopup': 'dialog',
      onClick: () => { void store.openBinding(category) } }, icons.IconEllipsisOutlineRegular ? h(icons.IconEllipsisOutlineRegular, { size: 16, 'aria-hidden': true }) : h('span', { 'aria-hidden': true }, '⋯')))))
  }

  function BindingDialog({ state }) {
    const category = state.bindingCategory, region = state.regions.collections
    const binding = region.data?.bindings?.find(item => item.category === category)
    const [chosen, setChosen] = React.useState('')
    React.useEffect(() => setChosen(binding?.id ?? ''), [category, binding?.id])
    const targets = (region.data?.items ?? []).filter(item => item.name?.trim() && !item.readOnly && (!item.category || item.category === category))
    const close = () => { if (!state.bindingBusy) store.set({ bindingCategory: '', bindingError: '' }) }
    return Modal ? h(Modal, { open: Boolean(category), onClose: close,
      title: `${t('manageCategoryBinding')} · ${category ? t(category) : ''}`, closeLabel: t('close'),
      className: 'afp-wb-action-modal', contentClassName: 'afp-wb-action-modal-content',
      footer: h('div', { className: 'afp-wb-actions' }, h(Button, { variant: 'ghost', disabled: state.bindingBusy, onClick: close }, t('cancel')),
        h(Button, { variant: 'outline', disabled: state.busy || state.bindingBusy || region.loading || !binding?.id,
          onClick: () => { void store.saveBinding(category, null) } }, t('deleteBinding')),
        h(Button, { variant: 'primary', disabled: state.busy || state.bindingBusy || region.loading || !chosen,
          onClick: () => { void store.saveBinding(category, chosen) } }, t(binding?.id ? 'editBinding' : 'addBinding'))) },
    h('p', { className: 'afp-wb-subtle' }, t('bindingHint')),
    region.loading ? h(StateDot, { state: 'ongoing' }) : h(Selector, { value: chosen, label: t('targetCollection'), options: [{ value: '', label: t('chooseCollection') },
      ...targets.map(item => ({ value: item.id, label: item.name }))], onChange: setChosen, disabled: state.bindingBusy }),
    !targets.length && !region.loading ? h('p', { className: 'afp-wb-subtle' }, t('noPrivateCollections')) : null,
    region.error ? error({ ...region, retry: () => store.loadCollections() }) : null,
    state.bindingError ? h('p', { className: 'afp-wb-field-error', role: 'alert' }, t(state.bindingError)) : null) : null
  }
  function ReloadButton({ loading, onClick }) {
    const Icon = icons.IconRefreshOutlineRegular
    const button = h(Button, { variant: 'ghost', size: 'sm', disabled: loading, 'aria-busy': loading,
      'aria-label': t('reload'), onClick, className: 'afp-wb-icon-action' },
      loading ? h(StateDot, { state: 'ongoing', size: 14 }) : Icon ? h(Icon, { size: 16 }) : t('reload'))
    return Tooltip ? h(Tooltip, { label: t('reload'), portal: true, maxWidth: 180 }, button) : button
  }

  function error(region) {
    return region?.error ? h('div', { className: 'afp-wb-error-row', role: 'alert' }, h('span', null, t('regionReadFailed')),
      h(Button, { variant: 'ghost', size: 'sm', onClick: region.retry }, t('retry'))) : null
  }
  function RunHistory({ state }) {
    const region = state.regions.runs, rows = region.data?.items ?? []
    const manual = region.loading && region.loadMode === 'manual'
    const active = id => (state.status?.tasks ?? []).find(task => task.runId === id && task.feature === 'refresh')
    const pauseEnabled = id => Boolean(active(id) && state.status?.features?.includes('refresh'))
    const selected = state.selectedRuns ?? []
    const scroller = React.useRef(null), measured = React.useRef([])
    React.useLayoutEffect(() => {
      if (!manual && scroller.current) measured.current = Array.from(scroller.current.children).map(row => row.getBoundingClientRect().height)
    }, [manual, rows])
    const actions = ids => [
      { id: 'pause-run', label: t(ids.some(pauseEnabled) ? 'pauseReport' : 'pauseReportUnavailable'), disabled: state.busy || !ids.some(pauseEnabled) },
      { id: 'delete-run', label: t(ids.some(id => !active(id) && rows.find(row => row.id === id)?.status !== 'running') ? 'deleteReport' : 'deleteReportUnavailable'),
        disabled: state.busy || !ids.some(id => !active(id) && rows.find(row => row.id === id)?.status !== 'running') },
    ]
    const request = (operation, ids) => {
      const eligible = ids.filter(id => operation === 'pause-run' ? pauseEnabled(id) : !active(id) && rows.find(row => row.id === id)?.status !== 'running')
      if (eligible.length) store.set({ runAction: { operation, ids: eligible, skipped: ids.length - eligible.length } })
    }
    return h('section', { className: 'afp-wb-section afp-wb-history-section' }, h('div', { className: 'afp-wb-section-heading' },
      h('div', { className: 'afp-wb-heading-group' }, h('h3', null, t('runHistory')), h(Tag, { tone: 'quiet' }, String(region.data?.total ?? rows.length))),
      h('div', { className: 'afp-wb-actions' }, h(MoreMenu, { label: t('batchReports'), disabled: state.busy || manual || !rows.length,
        items: [{ id: 'select', label: t('selectLoadedReports') }, { id: 'clear', label: t('clearReportSelection'), disabled: !selected.length }, ...actions(selected)],
        onSelect: id => id === 'select' ? store.selectLoadedRuns() : id === 'clear' ? store.set({ selectedRuns: [] }) : request(id, selected) }),
      h(ReloadButton, { loading: region.loading && region.loadMode !== 'auto', onClick: () => { void store.loadHistory('runs', { mode: 'manual' }) } }))),
      error({ ...region, retry: () => store.loadHistory('runs') }),
      selected.length ? h('p', { className: 'afp-wb-subtle', role: 'status' }, t('reportsSelected').replace('{count}', String(selected.length))) : null,
      state.runActionResult ? h('p', { role: 'status', className: 'afp-wb-subtle' },
        t('reportsActionResult').replace('{done}', String(state.runActionResult.outcomes.filter(row => row.ok).length))
          .replace('{failed}', String(state.runActionResult.outcomes.filter(row => !row.ok).length))) : null,
      !rows.length && !region.loading && !region.error ? h('p', { className: 'afp-wb-empty' }, t('noRunHistory')) : null,
      !rows.length && region.loading ? h(HistorySkeleton) : null,
      h('div', { ref: scroller, className: 'afp-wb-history-list', 'aria-busy': manual, 'aria-label': manual ? t('loading') : t('runHistory') },
      ...rows.map((item, index) => h('div', { className: `afp-wb-history-row${manual ? ' is-skeleton' : ''}`, key: item.id,
        style: manual && measured.current[index] ? { minHeight: measured.current[index] } : undefined,
        'aria-hidden': manual ? true : undefined, 'data-selected': selected.includes(item.id) },
        h(Checkbox, { checked: selected.includes(item.id), disabled: manual || state.busy,
          label: `${t('selectReport')} · ${item.id.slice(0, 8)}`, onChange: () => store.toggleRun(item.id), className: 'afp-wb-history-select' }),
        h('button', { type: 'button', className: 'afp-wb-history-open', disabled: manual, onClick: () => { void store.openRun(item.id) } },
        h('span', { className: 'afp-wb-history-main' },
          h('span', { className: 'afp-wb-history-title' }, (item.run?.categories ?? []).map(row => t(row.category)).join(' · ')),
          h('time', { className: 'afp-wb-subtle' }, item.createdAt ? new Date(item.createdAt).toLocaleString() : t('dateUnknown'))),
        h('span', { className: 'afp-wb-history-counts' }, (item.run?.categories ?? []).map(row => `${t('filter_kept')} ${row.kept}/${row.target}`).join(' · ')),
        h(Tag, { tone: item.status === 'ready' ? 'success' : item.status === 'failed' ? 'warning' : 'neutral' }, t(`runStatus_${item.status}`)),
        icons.IconChevronDownOutlineRegular ? h(icons.IconChevronDownOutlineRegular, { size: 14, className: 'afp-wb-history-chevron' }) : null),
        h(MoreMenu, { label: `${t('reportMore')} · ${item.id.slice(0, 8)}`, disabled: manual || state.busy,
          items: actions([item.id]), onSelect: id => request(id, [item.id]) })))),
      state.runAction && Modal ? h(Modal, { open: true, title: t(state.runAction.operation === 'pause-run' ? 'pauseReport' : 'deleteReport'),
        closeLabel: t('close'), onClose: () => { if (!state.busy) store.set({ runAction: null }) }, className: 'afp-wb-action-modal',
        footer: h('div', { className: 'afp-wb-actions' }, h(Button, { variant: 'ghost', disabled: state.busy, onClick: () => store.set({ runAction: null }) }, t('cancel')),
          h(Button, { variant: 'primary', disabled: state.busy, onClick: () => { void store.manageRuns(state.runAction.operation, state.runAction.ids) } }, t('confirmLocalAction'))) },
      h('p', null, t(state.runAction.operation === 'pause-run' ? 'pauseReportsHint' : 'deleteReportsHint').replace('{count}', String(state.runAction.ids.length))),
      state.runAction.skipped ? h('p', { className: 'afp-wb-subtle' }, t('reportsSkipped').replace('{count}', String(state.runAction.skipped))) : null) : null,
      region.data?.hasMore ? h(Button, { variant: 'outline', size: 'sm', disabled: region.loading, onClick: () => { void store.loadHistory('runs', { more: true }) } }, t('loadMore')) : null)
  }

  function LiveTasks({ state }) {
    const tasks = state.status?.tasks ?? []
    const downloads = state.status?.downloads ?? []
    const [section, setSection] = React.useState(tasks.length || !downloads.length ? 'tasks' : 'downloads')
    const panelId = React.useId()
    const activeTaskIds = new Set(tasks.map(task => task.taskId))
    const downloadRows = downloads.map(record => {
      const processed = Math.min(record.total, record.completed + record.failed + record.pending + (record.cancelled ?? 0))
      return h('details', { className: 'afp-wb-download-task', key: record.id },
      h('summary', null,
        h('span', { className: 'afp-wb-download-task-icon', 'aria-hidden': true }, icons.IconDownloadOutlineRegular ? h(icons.IconDownloadOutlineRegular, { size: 20 }) : null),
        h('span', { className: 'afp-wb-download-task-title' }, h('strong', null, t('downloadTask')),
          h('time', null, record.updatedAt ? new Date(record.updatedAt).toLocaleString() : t('dateUnknown'))),
        h(Tag, { tone: record.status === 'completed' ? 'success' : ['failed', 'interrupted', 'partial'].includes(record.status) ? 'warning' : 'neutral' }, t(`downloadStatus_${record.status}`)),
        h('svg', { className: 'afp-wb-download-task-chevron', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'm9 5 7 7-7 7', strokeLinecap: 'round', strokeLinejoin: 'round' })),
        h('span', { className: 'afp-wb-download-task-counts' },
          h('span', null, t('completed'), h('strong', null, `${record.completed}/${record.total}`)),
          h('span', null, t('failedCount'), h('strong', null, record.failed)),
          h('span', null, t('pendingCount'), h('strong', null, record.pending)),
          record.cancelled ? h('span', null, t('downloadStatus_cancelled'), h('strong', null, record.cancelled)) : null),
        h('progress', { max: Math.max(1, record.total), value: processed,
          'aria-label': t('downloadProcessed').replace('{count}', String(processed)).replace('{total}', String(record.total)) })),
      h('div', { className: 'afp-wb-download-task-files' }, ...(record.items ?? []).map(item => h('p', { key: item.photoId },
        h('span', null, item.fileName || item.title || item.photoId),
        h(Tag, { tone: item.status === 'completed' ? 'success' : ['failed', 'pending'].includes(item.status) ? 'warning' : 'neutral' }, t(`downloadStatus_${item.status}`)),
        item.errorCode === 'purchase-pending' ? h('span', { className: 'afp-wb-subtle' }, t('purchasePending'))
          : item.errorCode === 'host-stopped' ? h('span', { className: 'afp-wb-subtle' }, t('hostStopped')) : null))),
      record.taskId && activeTaskIds.has(record.taskId) ? h(Button, { variant: 'ghost', size: 'sm', disabled: state.busy,
        onClick: () => { void store.cancelDownload(record.taskId) } }, t('cancel')) : null)
    })
    return h('section', { className: 'afp-wb-section afp-wb-live-section' },
      h('div', { className: 'afp-wb-activity-tabs', role: 'tablist', 'aria-label': t('taskActivity') },
        ...[['tasks', 'liveTasks', tasks.length], ['downloads', 'downloadTasks', downloads.length]].map(([key, label, count]) => h(Button, {
          key, id: `${panelId}-${key}`, variant: 'ghost', role: 'tab', 'aria-selected': section === key,
          'aria-controls': `${panelId}-panel`, tabIndex: section === key ? 0 : -1, onClick: () => setSection(key),
          onKeyDown: event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'tasks' : event.key === 'End' ? 'downloads' : section === 'tasks' ? 'downloads' : 'tasks'
            setSection(next); event.currentTarget.parentElement.querySelector(`[id="${panelId}-${next}"]`)?.focus()
          },
        }, t(label), h('span', { className: 'afp-wb-activity-count' }, count)))),
      h('div', { id: `${panelId}-panel`, role: 'tabpanel', 'aria-labelledby': `${panelId}-${section}`, className: 'afp-wb-activity-body' },
      section === 'tasks' && tasks.length ? h('div', { className: 'afp-wb-live-list' }, ...tasks.map(task => {
        let progress = null
        try { progress = task.progress ? JSON.parse(task.progress) : null } catch (error) { /* 隐藏不符合已知进度字段的内容，不显示原始输出。 */ }
        return h('article', { className: 'afp-wb-live-row', key: task.taskId },
          h(StateDot, { state: 'ongoing', size: 16 }),
          h('div', null, h('p', { className: 'afp-wb-history-title' }, t(task.feature === 'write' ? 'writeTask' : 'refreshTask')),
            progress?.stage && feedbackStages[progress.stage] ? h('p', { className: 'afp-wb-subtle' }, t(feedbackStages[progress.stage])) : null,
            progress && typeof progress.category === 'string' ? h('p', { className: 'afp-wb-subtle' }, `${t(progress.category)} · ${t('keptCount')} ${progress.kept}/${progress.target}`) : null,
            progress?.previewed !== undefined ? h('p', { className: 'afp-wb-subtle' }, t('feedbackPreviewCount').replace('{count}', String(progress.previewed))) : null,
            progress?.pixelReviewed !== undefined ? h('p', { className: 'afp-wb-subtle' }, t('feedbackJudgedCount').replace('{count}', String(progress.pixelReviewed))) : null,
            progress?.requestFailures ? h('p', { className: 'afp-wb-subtle' }, t('feedbackRequestFailures').replace('{count}', String(progress.requestFailures))) : null),
          h(Button, { variant: 'ghost', size: 'sm', disabled: state.busy, onClick: () => { void store.invoke('cancel', { taskId: task.taskId }) } }, t('cancel')))
      })) : null,
      section === 'downloads' && downloads.length ? h('div', { className: 'afp-wb-download-tasks' }, ...downloadRows) : null,
      section === 'tasks' && !tasks.length || section === 'downloads' && !downloads.length
        ? h('div', { className: 'afp-wb-activity-empty', role: 'status' },
          h('span', { 'aria-hidden': true }, icons.IconDownloadOutlineRegular ? h(icons.IconDownloadOutlineRegular, { size: 24 }) : null),
          h('p', null, t(section === 'tasks' ? 'noLiveTasks' : 'noDownloadTasks'))) : null))
  }

  function RefreshForm({ state, onOpenAccount }) {
    const active = state.status?.features?.includes('refresh')
    const credentials = state.account?.credentials ?? {}
    const credentialsReady = Boolean(credentials.accessTokenRef?.configured
      || credentials.usernameRef?.configured && credentials.passwordRef?.configured)
    const visionReady = Boolean(state.account?.visionConfigured && credentials.visionKeyRef?.configured)
    const ready = active && credentialsReady && visionReady
    const validNumbers = Number.isInteger(state.targetPerCategory) && state.targetPerCategory >= 1 && state.targetPerCategory <= 1000
      && Number.isFinite(state.threshold) && state.threshold >= .8 && state.threshold <= 1
    const validationId = React.useId()
    const submit = event => {
      event.preventDefault()
      if (!ready || state.busy || !state.selected.length || !validNumbers) return
      void store.invoke('refresh', { categories: state.selected, targetPerCategory: state.targetPerCategory, threshold: state.threshold })
    }
    return h('section', { className: 'afp-wb-section afp-wb-task-setup' },
      h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('newRefresh')),
        h(Tag, { tone: 'quiet' }, String(state.selected.length))),
      !ready ? h('div', { className: 'afp-wb-prerequisite' }, h('p', null, t('refreshPrerequisite')),
        h(Button, { variant: 'outline', size: 'sm', onClick: onOpenAccount }, t('openAccountSettings'))) : null,
      h('form', { className: 'afp-wb-refresh-form', onSubmit: submit },
        h('fieldset', null, h('legend', null, t('categories')),
          h(CategoryChoices, { state, disabled: !ready || state.busy }),
          h('div', { className: 'afp-wb-number-fields' },
            h('label', null, t('targetPerCategory'), h(Input, { className: 'afp-wb-input', disabled: !ready || state.busy, type: 'number', min: 1, max: 1000, step: 1,
              'aria-label': t('targetPerCategory'), 'aria-describedby': ready && !validNumbers ? validationId : undefined,
              'aria-invalid': ready && (!Number.isInteger(state.targetPerCategory) || state.targetPerCategory < 1 || state.targetPerCategory > 1000),
              value: state.targetPerCategory ?? '', onChange: event => store.set({ targetPerCategory: Number(event.target.value) }) })),
            h('label', null, t('threshold'), h(Input, { className: 'afp-wb-input', disabled: !ready || state.busy, type: 'number', min: .8, max: 1, step: .01,
              'aria-label': t('threshold'), 'aria-describedby': ready && !validNumbers ? validationId : undefined,
              'aria-invalid': ready && (!Number.isFinite(state.threshold) || state.threshold < .8 || state.threshold > 1),
              value: state.threshold ?? '', onChange: event => store.set({ threshold: Number(event.target.value) }) }))),
          ready && !validNumbers ? h('p', { id: validationId, className: 'afp-wb-field-error', role: 'status' }, t('refreshInvalidValues')) : null,
          h(Button, { variant: 'primary', type: 'submit', 'aria-busy': state.busy,
            disabled: !ready || state.busy || !state.selected.length || !validNumbers,
            icon: state.busy ? h(StateDot, { state: 'ongoing', size: 14 }) : null }, t('startRefresh')))),
      h('details', { className: 'afp-wb-resume' }, h('summary', null, t('resumeRun')),
        h('div', { className: 'afp-wb-resume-row' },
        h(Input, { className: 'afp-wb-input', value: state.runId, 'aria-label': t('resumeRunId'), placeholder: t('resumeRunId'), onChange: event => store.set({ runId: event.target.value }) }),
        h(Button, { variant: 'outline', disabled: !active || !state.runId.trim() || state.busy, onClick: () => { void store.invoke('refresh', { runId: state.runId.trim() }) } }, t('resumeRun')))))
  }

  function ReportPanel({ state }) {
    const region = state.regions.run, report = region.data, items = report?.items ?? []
    const scroller = React.useRef(null), lastAside = React.useRef(null)
    const [showTop, setShowTop] = React.useState(false)
    const runSummary = report?.run
    const noReviewed = runSummary?.categories.every(row => row.reviewed === 0)
    const empty = !items.length || noReviewed && !items.some(item => item.requestFailed)
    const selection = Object.values(state.selectedPhotos)
    const asideOpen = Boolean(state.detail || state.selectionOpen)
    if (state.detail && state.tab === 'tasks') lastAside.current = { kind: 'detail', props: { photo: state.detail,
      report: true, loading: state.regions.detail.loading, error: state.regions.detail.error, onClose: () => store.closePhoto() } }
    else if (state.selectionOpen) lastAside.current = { kind: 'selection', props: { photos: selection, onOpen: photo => { void store.openPhoto(photo) } } }
    // 收起期间保留最后一个面板，让内容淡出与列宽过渡完成；隐藏面板不接受输入。
    const aside = lastAside.current
    const canAdd = selection.length > 0 && selection.length <= 120 && !state.busy && !state.collectionSelecting
      && state.status?.features?.includes('read') && state.status?.features?.includes('write')
    return h('section', { className: `afp-wb-section afp-wb-report${state.detail || state.selectionOpen ? ' is-with-aside' : ''}` },
      h('div', { className: 'afp-wb-report-main' },
      h('div', { className: 'afp-wb-section-heading' }, h('div', { className: 'afp-wb-heading-group' },
        h(ReportBack), h('h3', null, t('runReport')),
        runSummary ? h(Tag, { tone: runSummary.status === 'failed' ? 'warning' : runSummary.status === 'ready' ? 'success' : 'neutral' }, t(`runStatus_${runSummary.status}`)) : null)),
      h('div', { ref: scroller, className: 'afp-wb-gallery-wrap', tabIndex: -1,
        onScroll: event => setShowTop(event.currentTarget.scrollTop > event.currentTarget.clientHeight / 2) },
      runSummary ? h('div', { className: 'afp-wb-report-summary' }, ...runSummary.categories.map(row => {
        const reviewed = row.pixelReviewed ?? Math.max(0, row.reviewed - (row.requestFailures ?? 0))
        const metrics = [
          ['reviewedCount', reviewed, 'neutral'], ['filter_kept', row.kept, 'success'],
          ['filter_rejected', Math.max(0, reviewed - row.kept), 'neutral'], ['requestFailures', row.requestFailures ?? 0, 'warning'],
        ]
        const outcomes = metrics.slice(1).filter(([, count]) => count > 0)
        return h('article', { key: row.category, className: 'afp-wb-report-category' },
          h('div', { className: 'afp-wb-report-category-heading' },
            h('span', { className: 'afp-wb-report-category-icon', 'aria-hidden': true }, h(ReportMetricIcon, { kind: 'category' })),
            h('strong', null, t(row.category)),
            h('span', { className: 'afp-wb-report-target' }, t('reportTarget').replace('{count}', String(row.target))),
            outcomes.length ? h('div', { className: 'afp-wb-report-distribution', role: 'img',
              'aria-label': metrics.slice(1).map(([key, count]) => `${t(key)} ${count}`).join(' · ') },
            ...outcomes.map(([key, count, tone]) => h('span', { key, 'data-tone': tone, style: { flexGrow: count } }))) : null),
          h('dl', { className: 'afp-wb-report-metrics' }, ...metrics.map(([key, count, tone]) => h('div', { key, 'data-metric': key, 'data-tone': count > 0 ? tone : 'neutral' },
            h('dt', null, h('span', { className: 'afp-wb-report-metric-icon', 'aria-hidden': true }, h(ReportMetricIcon, { kind: key })), t(key)),
            h('dd', null, count)))))
      })) : null,
      h('div', { className: 'afp-wb-toolbar afp-wb-report-toolbar' },
        h('div', { className: 'afp-wb-field' }, h('span', { className: 'afp-wb-sr-only' }, t('categoryFilter')),
          h(Selector, { value: state.reportCategory, label: t('categoryFilter'),
            options: [{ value: '', label: t('allCategories') }, ...categoryKeys.filter(category => runSummary?.categories.some(row => row.category === category)).map(value => ({ value, label: t(value) }))],
            onChange: category => { void store.openRun(state.runId, { category, decision: state.reportFilter }) } })),
        h('div', { className: 'afp-wb-field' }, h('span', { className: 'afp-wb-sr-only' }, t('decisionFilter')),
          h('div', { className: 'afp-wb-result-filters', role: 'group', 'aria-label': t('decisionFilter') },
            ...['all', 'kept', 'rejected', 'failed'].map(decision => h(Button, { key: decision, size: 'sm',
              variant: state.reportFilter === decision ? 'outline' : 'ghost', 'aria-pressed': state.reportFilter === decision,
              onClick: () => { void store.openRun(state.runId, { category: state.reportCategory, decision }) } }, t(`filter_${decision}`))))),
        h('div', { className: 'afp-wb-actions afp-wb-report-actions' },
          h(Button, { variant: state.selectionOpen ? 'outline' : 'ghost', size: 'sm', className: 'afp-wb-report-selection', 'aria-expanded': state.selectionOpen,
            onClick: () => store.set({ selectionOpen: !state.selectionOpen }) },
            icons.IconFlatListOutlineRegular ? h(icons.IconFlatListOutlineRegular, { size: 14, 'aria-hidden': true }) : null,
            t('selectionList'), h(Tag, { tone: selection.length ? 'info' : 'quiet' }, String(selection.length))),
          h(Button, { variant: canAdd ? 'primary' : 'outline', size: 'sm', disabled: !canAdd, onClick: () => store.openAddFavorites() },
            icons.IconFolderCloseRegular ? h(icons.IconFolderCloseRegular, { size: 14, 'aria-hidden': true }) : null, t('addFavorites')))),
      region.error ? h('div', { role: 'alert', className: 'afp-wb-error-row' }, t('regionReadFailed'),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter }) } }, t('retry'))) : null,
          h('div', { className: 'afp-wb-report-images', 'aria-busy': region.loading }, empty && region.loading && region.loadMode === 'filter'
            ? h('div', { className: 'afp-wb-gallery' }, ...Array.from({ length: 6 }, (_, key) => h(gallery.PhotoSkeleton, { key, imageOnly: true })))
            : empty ? h('div', { className: 'afp-wb-report-empty', role: 'status' },
            h('p', null, t(noReviewed ? 'noReviewedItems' : 'reportNoMatches')),
            noReviewed ? h('p', { className: 'afp-wb-subtle' }, t('reportEmptyHelp')) : null)
            : h(gallery.ReportGallery, { items, selectedPhotos: state.selectedPhotos }),
            !empty && region.data?.hasMore ? h(Button, { variant: 'outline', disabled: region.loading, onClick: () => { void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter, more: true }) } }, t('loadMore')) : null)),
      showTop ? h(Button, { variant: 'outline', size: 'sm', className: 'afp-wb-back-top', 'aria-label': t('backToTop'), onClick: () => {
        scroller.current?.focus({ preventScroll: true })
        scroller.current?.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      } }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('path', { d: 'm6 12 6-6 6 6M12 6v13', strokeLinecap: 'round', strokeLinejoin: 'round' }))) : null),
      h('aside', { className: `afp-wb-report-aside${asideOpen ? ' is-open' : ''}`, inert: asideOpen ? undefined : '', 'aria-hidden': !asideOpen },
        h('div', { className: 'afp-wb-report-aside-content' }, aside ? h(aside.kind === 'detail' ? gallery.DetailPane : gallery.SelectionPane, aside.props) : null)))
  }

  function TasksPanel({ state, onOpenAccount }) {
    const report = state.regions.run
    const pendingReport = state.runId && !report.data && (report.loading || report.error)
    const collapsed = Boolean(state.tasksSidebarCollapsed), sidebarId = React.useId()
    const toggleLabel = t(collapsed ? 'expandTaskSetup' : 'collapseTaskSetup')
    const toggle = h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-sidebar-toggle afp-wb-task-setup-toggle',
      'aria-label': toggleLabel, 'aria-expanded': !collapsed, 'aria-controls': sidebarId,
      onClick: () => store.set({ tasksSidebarCollapsed: !collapsed }) },
      icons.IconPanelLeftOutlineRegular ? h(icons.IconPanelLeftOutlineRegular, { size: 18 }) :
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: 'currentColor', strokeWidth: 1.5 }),
          h('path', { d: 'M9 4v16', stroke: 'currentColor', strokeWidth: 1.5 })))
    return h('div', { className: `afp-wb-panel-content afp-wb-task-layout${collapsed ? ' is-sidebar-collapsed' : ''}` },
      h('aside', { className: 'afp-wb-task-sidebar', 'aria-label': t('taskSetup') },
        h('div', { className: 'afp-wb-task-sidebar-heading' }, h('h3', { 'aria-hidden': collapsed }, t('taskSetup')),
          Tooltip ? h(Tooltip, { label: toggleLabel, portal: true, side: 'right' }, toggle) : toggle),
      // 保持表单挂载；收起只隐藏设置区，保留输入和当前审阅状态。
        h('div', { id: sidebarId, className: 'afp-wb-task-sidebar-content', inert: collapsed ? '' : undefined, 'aria-hidden': collapsed },
          h(RefreshForm, { state, onOpenAccount })),
        h('nav', { className: 'afp-wb-task-compact', inert: collapsed ? undefined : '', 'aria-hidden': !collapsed, 'aria-label': t('categoryFilter') },
          ...categoryKeys.map(category => {
            const button = h(Button, { variant: 'ghost', size: 'sm', key: category, 'aria-label': t(category),
              'aria-pressed': state.selected.includes(category), onClick: () => store.set({ selected: state.selected.includes(category)
                ? state.selected.filter(value => value !== category) : [...state.selected, category] }) },
            h('span', { 'aria-hidden': true }, Array.from(t(category))[0]))
            return h('div', { key: category, className: 'afp-wb-compact-category' },
              Tooltip ? h(Tooltip, { label: t(category), side: 'right', portal: true }, button) : button,
              h(Button, { variant: 'ghost', size: 'sm', className: 'afp-wb-category-more', disabled: !state.status?.features?.includes('read'),
                'aria-label': `${t('manageCategoryBinding')} · ${t(category)}`, onClick: () => { void store.openBinding(category) } },
              icons.IconEllipsisOutlineRegular ? h(icons.IconEllipsisOutlineRegular, { size: 14, 'aria-hidden': true }) : '⋯'))
          }))),
      h('div', { className: 'afp-wb-task-results' },
      state.runId && state.regions.run.data ? h(ReportPanel, { state }) : null,
      pendingReport ? h('section', { className: 'afp-wb-section', 'aria-busy': report.loading },
        h('div', { className: 'afp-wb-section-heading' }, h('div', { className: 'afp-wb-heading-group' }, h(ReportBack), h('h3', null, t('runReport')))),
        report.loading ? h(HistorySkeleton) : error({ ...report, retry: () => store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter }) })) : null,
      !report.data && !pendingReport ? h(RunHistory, { state }) : null))
  }

  function PlanCard({ state }) {
    const plan = state.plan
    if (!plan) return null
    const expired = !Number.isFinite(plan.expiresAt) || plan.expiresAt <= Date.now()
    return h('section', { className: 'afp-wb-section afp-wb-plan', 'aria-label': t('confirmation') },
      h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('writePreview')),
        h(Tag, { tone: expired ? 'warning' : 'neutral' }, expired ? t('expired') : t('previewReady'))),
      h('p', { className: 'afp-wb-warning' }, t('writeWarning')),
      h('div', { className: 'afp-wb-plan-list' }, ...plan.categories.map(item => h('div', { className: 'afp-wb-plan-row', key: item.category },
        h('strong', null, t(item.category)), h('span', null, item.selectionName), h('span', null, `${t('existingCount')}: ${item.existing ?? '—'}`),
        h('span', null, `${t('remove')}: ${item.remove}`), h('span', null, `${t('add')}: ${item.add}`), item.create ? h(Tag, { tone: 'neutral' }, t('createTarget')) : null))),
      plan.expiresAt ? h('p', { className: 'afp-wb-subtle' }, `${t('expires')}: ${new Date(plan.expiresAt).toLocaleString()}`) : null,
      h(Checkbox, { checked: state.confirmChecked, label: t('confirmRead'), disabled: expired || state.busy, onChange: checked => store.set({ confirmChecked: checked }) }),
      h('div', { className: 'afp-wb-actions' },
        h(Button, { variant: 'primary', disabled: expired || state.busy || !state.confirmChecked || !state.status?.features?.includes('write'), onClick: () => { void store.confirmPlan() } }, t('confirm')),
        h(Button, { variant: 'ghost', disabled: state.busy, onClick: () => store.set({ plan: null, planFingerprint: '', confirmChecked: false }) }, t('dismiss'))))
  }

  function changeTotal(plan, key) {
    const counts = plan.targets.map(target => plan.result
      ? plan.result.categories.find(row => row.category === target.category)?.[key === 'add' ? 'added' : 'removed'] : target[key])
    // 未返回的实际结果显示未知，不能把计划数量或缺失值当作已执行数量。
    return counts.some(count => count === undefined) ? '—' : counts.reduce((sum, count) => sum + count, 0)
  }
  function ChangesPanel({ state }) {
    const runs = state.regions.runs.data?.items?.filter(item => item.kind === 'run') ?? []
    const plans = state.regions.plans.data?.items ?? []
    const writeEnabled = state.status?.features?.includes('write')
    const selectedRun = runs.find(item => item.id === state.runId)
    const settled = selectedRun && ['ready', 'paused'].includes(selectedRun.status) && !selectedRun.run?.pendingBatch
    const eligible = state.operation === 'clear' || settled
    const generate = () => { void store.previewPlan() }
    const planRows = plans.map(item => h('details', { className: 'afp-wb-plan-history', key: item.id },
      h('summary', null,
        icons.IconChevronDownOutlineRegular ? h(icons.IconChevronDownOutlineRegular, { size: 14, className: 'afp-wb-plan-chevron' }) : null,
        h('span', { className: 'afp-wb-plan-history-main' },
          h('span', { className: 'afp-wb-history-title' }, t(item.plan.operation), ' · ', item.plan.targets.map(target => target.name || t(target.category)).join('、')),
          h('time', { className: 'afp-wb-subtle afp-wb-plan-date' }, item.createdAt ? new Date(item.createdAt).toLocaleString() : t('dateUnknown'))),
        h('span', { className: 'afp-wb-plan-totals' },
          `${t(item.plan.result ? 'addedCount' : 'plannedAddedCount')} ${changeTotal(item.plan, 'add')} · ${t(item.plan.result ? 'removedCount' : 'plannedRemovedCount')} ${changeTotal(item.plan, 'remove')}`),
        h(Tag, { tone: item.status === 'completed' ? 'success' : item.status === 'failed' ? 'warning' : 'neutral' }, t(`planStatus_${item.status}`))),
      h('p', { className: 'afp-wb-subtle' }, `${t('changeId')} · ${item.id}`),
      h('ul', { className: 'afp-wb-plan-results' }, ...item.plan.targets.map(target => {
        const actual = item.plan.result?.categories?.find(row => row.category === target.category)
        return h('li', { key: target.category }, h('div', null, h('strong', null, target.name || t(target.category)), h('span', { className: 'afp-wb-subtle' }, t(target.category))),
          h('span', null, `${t(item.plan.result ? 'addedCount' : 'plannedAddedCount')} ${item.plan.result ? actual?.added ?? '—' : target.add}`),
          h('span', null, `${t(item.plan.result ? 'removedCount' : 'plannedRemovedCount')} ${item.plan.result ? actual?.removed ?? '—' : target.remove}`),
          h(Tag, { tone: actual?.status === 'completed' ? 'success' : ['failed', 'partial'].includes(actual?.status) ? 'warning' : 'neutral' }, t(`planStatus_${actual?.status ?? item.status}`)))
      }))))
    return h('div', { className: 'afp-wb-panel-content afp-wb-change-layout' },
      h('section', { className: 'afp-wb-section afp-wb-change-form' }, h('h3', null, t('changePreview')),
        !writeEnabled ? h('p', { className: 'afp-wb-subtle' }, t('writeDisabled')) : null,
        h('div', { className: 'afp-wb-change-fields' },
          h('div', { className: 'afp-wb-field' }, h('span', null, t('sourceReport')),
            h(Selector, { value: state.runId, label: t('sourceReport'), disabled: state.busy || state.operation === 'clear',
              options: [{ value: '', label: t('chooseReport') }, ...runs.map(item => ({ value: item.id,
                label: `${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : t('dateUnknown')} · ${t(`runStatus_${item.status}`)} · ${item.id.slice(0, 8)}` }))],
              onChange: runId => store.set({ runId }) })),
          h('div', { className: 'afp-wb-field' }, h('span', null, t('operation')),
            h(Selector, { value: state.operation, label: t('operation'), disabled: !writeEnabled || state.busy,
              options: ['append', 'replace', 'clear'].map(value => ({ value, label: t(value) })), onChange: operation => store.set({ operation }) }))),
        h('fieldset', null, h('legend', null, t('categories')),
          h(CategoryChoices, { state, disabled: !writeEnabled || state.busy }),
          h('div', { className: 'afp-wb-change-footer' },
            h('p', { className: 'afp-wb-subtle' }, t(state.operation === 'clear' ? 'clearPreviewHint' : !settled ? 'settledRunRequired' : 'previewOnlyHint')),
            h(Button, { variant: 'primary', 'aria-busy': state.busy,
              icon: state.busy ? h(StateDot, { state: 'ongoing', size: 14 }) : null,
              disabled: !writeEnabled || !eligible || !state.selected.length || state.operation !== 'clear' && !state.runId || state.busy, onClick: generate }, t('previewWrite'))))),
      h('div', { className: 'afp-wb-change-results' }, h(PlanCard, { state }),
      h('section', { className: 'afp-wb-section afp-wb-change-history' },
        h('div', { className: 'afp-wb-section-heading' }, h('div', { className: 'afp-wb-heading-group' }, h('h3', null, t('planHistory')),
          h(Tag, { tone: 'quiet' }, String(state.regions.plans.data?.total ?? plans.length))),
          h(ReloadButton, { loading: state.regions.plans.loading, onClick: () => { void store.loadHistory('plans') } })),
        state.regions.plans.error ? error({ ...state.regions.plans, retry: () => store.loadHistory('plans') }) : null,
        !plans.length && state.regions.plans.loading ? h(HistorySkeleton) : null,
        !plans.length && !state.regions.plans.loading && !state.regions.plans.error ? h('p', { className: 'afp-wb-empty' }, t('noPlanHistory')) : null,
        ...planRows,
        state.regions.plans.data?.hasMore ? h(Button, { variant: 'outline', size: 'sm', disabled: state.regions.plans.loading, onClick: () => { void store.loadHistory('plans', { more: true }) } }, t('loadMore')) : null)))
  }

  function TaskUtilities({ state }) {
    const [mode, setMode] = React.useState('')
    React.useEffect(() => setMode(''), [state.tab])
    // 变更弹窗内切换报告保留表单；诊断仅对应打开时的运行。
    React.useEffect(() => setMode(value => value === 'diagnostics' ? '' : value), [state.runId])
    if (state.tab !== 'tasks') return null
    const entries = [
      ['diagnostics', 'diagnosticsTitle', 'IconCodeOutlineRegular', !state.runId],
      ['activity', 'taskActivity', 'IconDownloadOutlineRegular', false],
      ['preview', 'previewWrite', 'IconFolderOpenOutlineRegular', !state.status?.features?.includes('write')],
    ]
    const label = entries.find(([value]) => value === mode)?.[1]
    return h(React.Fragment, null,
      h('div', { className: 'afp-wb-tab-tools', role: 'group', 'aria-label': t('taskActivity') },
        ...entries.map(([value, key, icon, disabled]) => {
          const button = h(Button, { key: value, variant: 'ghost', size: 'sm', className: 'afp-wb-tab-tool', disabled,
            'aria-label': t(key), 'aria-haspopup': 'dialog', onClick: () => {
              setMode(value)
              if (value === 'preview') void store.loadHistory('plans')
            } }, icons[icon] ? h(icons[icon], { size: 16, 'aria-hidden': true }) : h('span', null, t(key)))
          return Tooltip ? h(Tooltip, { key: value, label: t(key), side: 'bottom', portal: true }, button) : button
        })),
      Modal ? h(Modal, { open: Boolean(mode), title: label ? t(label) : '', closeLabel: t('close'),
        onClose: () => setMode(''), className: 'afp-wb-task-dialog', contentClassName: 'afp-wb-task-dialog-content' },
      mode === 'diagnostics' ? h(DiagnosticsPanel, { runId: state.runId, initiallyOpen: true, standalone: true })
        : mode === 'activity' ? h(LiveTasks, { state }) : mode === 'preview' ? h(ChangesPanel, { state }) : null) : null)
  }

  return { TasksPanel, ChangesPanel, TaskUtilities, BindingDialog }
}
