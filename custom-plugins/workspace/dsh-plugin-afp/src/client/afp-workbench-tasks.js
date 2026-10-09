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
  const { Button, Checkbox, Input, Tag, StateDot, Tooltip } = UI
  const categoryKeys = ['animals', 'food', 'landscape', 'movie-poster', 'celestial-body-wallpaper']
  const DiagnosticsPanel = createDiagnosticsPanel(React, UI, t, store)

  function HistorySkeleton() {
    return h('div', { className: 'afp-wb-history-skeleton', role: 'status', 'aria-label': t('loading') },
      ...Array.from({ length: 3 }, (_, index) => h('div', { key: index, 'aria-hidden': true },
        h('span', { className: 'afp-skeleton' }), h('span', { className: 'afp-skeleton' }), h('span', { className: 'afp-skeleton' }))))
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
    return h('section', { className: 'afp-wb-section afp-wb-history-section' }, h('div', { className: 'afp-wb-section-heading' },
      h('div', { className: 'afp-wb-heading-group' }, h('h3', null, t('runHistory')), h(Tag, { tone: 'quiet' }, String(region.data?.total ?? rows.length))),
      h(ReloadButton, { loading: region.loading, onClick: () => { void store.loadHistory('runs') } })),
      error({ ...region, retry: () => store.loadHistory('runs') }),
      !rows.length && !region.loading && !region.error ? h('p', { className: 'afp-wb-empty' }, t('noRunHistory')) : null,
      !rows.length && region.loading ? h(HistorySkeleton) : null,
      h('div', { className: 'afp-wb-history-list' }, ...rows.map(item => h('button', { type: 'button', className: 'afp-wb-history-row', key: item.id,
        onClick: () => { void store.openRun(item.id) } },
        h('span', { className: 'afp-wb-history-main' },
          h('span', { className: 'afp-wb-history-title' }, (item.run?.categories ?? []).map(row => t(row.category)).join(' · ')),
          h('time', { className: 'afp-wb-subtle' }, item.createdAt ? new Date(item.createdAt).toLocaleString() : t('dateUnknown'))),
        h('span', { className: 'afp-wb-history-counts' }, (item.run?.categories ?? []).map(row => `${t('filter_kept')} ${row.kept}/${row.target}`).join(' · ')),
        h(Tag, { tone: item.status === 'ready' || item.status === 'paused' ? 'success' : item.status === 'failed' ? 'warning' : 'neutral' }, t(`runStatus_${item.status}`)),
        icons.IconChevronDownOutlineRegular ? h(icons.IconChevronDownOutlineRegular, { size: 14, className: 'afp-wb-history-chevron' }) : null))),
      region.data?.hasMore ? h(Button, { variant: 'outline', size: 'sm', disabled: region.loading, onClick: () => { void store.loadHistory('runs', { more: true }) } }, t('loadMore')) : null)
  }

  function LiveTasks({ state }) {
    const tasks = state.status?.tasks ?? []
    const downloads = state.status?.downloads ?? []
    const activeTaskIds = new Set(tasks.map(task => task.taskId))
    const downloadRows = downloads.map(record => h('details', { className: 'afp-wb-download-task', key: record.id },
      h('summary', null,
        h('span', { className: 'afp-wb-download-task-title' }, t('downloadTask')),
        h(Tag, { tone: record.status === 'completed' ? 'success' : ['failed', 'interrupted', 'partial'].includes(record.status) ? 'warning' : 'neutral' }, t(`downloadStatus_${record.status}`)),
        h('span', { className: 'afp-wb-subtle' }, `${record.completed}/${record.total} · ${t('failedCount')} ${record.failed} · ${t('pendingCount')} ${record.pending}`)),
      record.updatedAt ? h('p', { className: 'afp-wb-subtle' }, new Date(record.updatedAt).toLocaleString()) : null,
      h('div', { className: 'afp-wb-download-task-files' }, ...(record.items ?? []).slice(0, 8).map(item => h('p', { key: item.photoId },
        h('span', null, item.fileName || item.title || item.photoId),
        h(Tag, { tone: item.status === 'completed' ? 'success' : ['failed', 'pending'].includes(item.status) ? 'warning' : 'neutral' }, t(`downloadStatus_${item.status}`)),
        item.errorCode === 'purchase-pending' ? h('span', { className: 'afp-wb-subtle' }, t('purchasePending'))
          : item.errorCode === 'host-stopped' ? h('span', { className: 'afp-wb-subtle' }, t('hostStopped')) : null))),
      record.taskId && activeTaskIds.has(record.taskId) ? h(Button, { variant: 'ghost', size: 'sm', disabled: state.busy,
        onClick: () => { void store.invoke('cancel', { taskId: record.taskId }) } }, t('cancel')) : null))
    return h('section', { className: 'afp-wb-section afp-wb-live-section', 'data-active': tasks.length > 0 || downloads.length > 0 }, h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('liveTasks')),
      h(Tag, { tone: 'neutral' }, String(tasks.length))),
      tasks.length ? h('div', { className: 'afp-wb-live-list' }, ...tasks.map(task => {
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
      downloads.length ? h('div', { className: 'afp-wb-download-tasks' }, h('h4', null, t('downloadTasks')), ...downloadRows) : null,
      !tasks.length && !downloads.length ? h('p', { className: 'afp-wb-subtle' }, t('noLiveTasks')) : null)
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
    const setCategories = category => store.set({ selected: state.selected.includes(category)
      ? state.selected.filter(item => item !== category) : [...state.selected, category] })
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
        h('fieldset', { disabled: !ready || state.busy }, h('legend', null, t('categories')),
          h('div', { className: 'afp-wb-categories' }, ...categoryKeys.map(category => h('div', { key: category, className: 'afp-wb-category-option', 'data-selected': state.selected.includes(category) },
            h(Checkbox, { checked: state.selected.includes(category), label: t(category), onChange: () => setCategories(category) })))),
          h('div', { className: 'afp-wb-number-fields' },
            h('label', null, t('targetPerCategory'), h(Input, { className: 'afp-wb-input', type: 'number', min: 1, max: 1000, step: 1,
              'aria-label': t('targetPerCategory'), 'aria-describedby': ready && !validNumbers ? validationId : undefined,
              'aria-invalid': ready && (!Number.isInteger(state.targetPerCategory) || state.targetPerCategory < 1 || state.targetPerCategory > 1000),
              value: state.targetPerCategory ?? '', onChange: event => store.set({ targetPerCategory: Number(event.target.value) }) })),
            h('label', null, t('threshold'), h(Input, { className: 'afp-wb-input', type: 'number', min: .8, max: 1, step: .01,
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

  function ReportPanel({ state, onOpenChanges }) {
    const region = state.regions.run, report = region.data, items = report?.items ?? []
    const runSummary = report?.run
    const noReviewed = runSummary?.categories.every(row => row.reviewed === 0)
    const empty = !items.length || noReviewed && !items.some(item => item.requestFailed)
    const canPlan = ['ready', 'paused'].includes(runSummary?.status) && !runSummary?.pendingBatch
    const selection = Object.values(state.selectedPhotos)
    const canAdd = selection.length > 0 && selection.length <= 120 && !state.busy && !state.collectionSelecting
      && state.status?.features?.includes('read') && state.status?.features?.includes('write')
    return h('section', { className: 'afp-wb-section afp-wb-report' },
      h('div', { className: 'afp-wb-section-heading' }, h('div', { className: 'afp-wb-heading-group' }, h('h3', null, t('runReport')),
        runSummary ? h(Tag, { tone: runSummary.status === 'failed' ? 'warning' : runSummary.status === 'ready' ? 'success' : 'neutral' }, t(`runStatus_${runSummary.status}`)) : null),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => store.set({ runId: '', regions: { ...state.regions, run: { data: null, loading: false, error: '' } } }) }, t('closeReport'))),
      runSummary ? h('div', { className: 'afp-wb-report-summary' }, ...runSummary.categories.map(row => {
        const reviewed = row.pixelReviewed ?? Math.max(0, row.reviewed - (row.requestFailures ?? 0))
        return h('article', { key: row.category, className: 'afp-wb-report-category' },
          h('div', { className: 'afp-wb-report-category-heading' }, h('strong', null, t(row.category)),
            h('span', { className: 'afp-wb-subtle' }, t('reportTarget').replace('{count}', String(row.target)))),
          h('dl', { className: 'afp-wb-report-metrics' }, ...[
            ['reviewedCount', reviewed, 'neutral'], ['filter_kept', row.kept, 'success'],
            ['filter_rejected', Math.max(0, reviewed - row.kept), 'neutral'], ['requestFailures', row.requestFailures ?? 0, 'warning'],
          ].map(([key, count, tone]) => h('div', { key, 'data-tone': count > 0 ? tone : 'neutral' }, h('dt', null, t(key)), h('dd', null, count)))))
      })) : null,
      h('div', { className: 'afp-wb-toolbar' },
        h('div', { className: 'afp-wb-field' }, h('span', null, t('categoryFilter')),
          h(Selector, { value: state.reportCategory, label: t('categoryFilter'),
            options: [{ value: '', label: t('allCategories') }, ...categoryKeys.filter(category => runSummary?.categories.some(row => row.category === category)).map(value => ({ value, label: t(value) }))],
            onChange: category => { void store.openRun(state.runId, { category, decision: state.reportFilter }) } })),
        h('div', { className: 'afp-wb-field' }, h('span', null, t('decisionFilter')),
          h(Selector, { value: state.reportFilter, label: t('decisionFilter'), options: ['all', 'kept', 'rejected', 'failed'].map(value => ({ value, label: t(`filter_${value}`) })),
            onChange: decision => { void store.openRun(state.runId, { category: state.reportCategory, decision }) } })),
        h('div', { className: 'afp-wb-actions afp-wb-report-actions' },
          h(Button, { variant: state.selectionOpen ? 'outline' : 'ghost', size: 'sm', 'aria-expanded': state.selectionOpen,
            onClick: () => store.set({ selectionOpen: !state.selectionOpen }) }, t('selectionList'), h(Tag, { tone: 'quiet' }, String(selection.length))),
          h(Button, { variant: 'outline', size: 'sm', disabled: !canAdd, onClick: () => store.openAddFavorites() }, t('addFavorites')))),
      region.error ? h('div', { role: 'alert', className: 'afp-wb-error-row' }, t('regionReadFailed'),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter }) } }, t('retry'))) : null,
      h('div', { className: `afp-wb-gallery-layout${state.detail || state.selectionOpen ? ' is-with-aside' : ''}` },
          h('div', { className: 'afp-wb-gallery-wrap' }, empty ? h('div', { className: 'afp-wb-report-empty', role: 'status' },
            h('p', null, t(noReviewed ? 'noReviewedItems' : 'reportNoMatches')),
            noReviewed ? h('p', { className: 'afp-wb-subtle' }, t('reportEmptyHelp')) : null)
            : h(gallery.ReportGallery, { items, selectedPhotos: state.selectedPhotos }),
            !empty && region.data?.hasMore ? h(Button, { variant: 'outline', disabled: region.loading, onClick: () => { void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter, more: true }) } }, t('loadMore')) : null),
          state.detail && state.tab === 'tasks' ? h(gallery.DetailPane, { photo: state.detail, report: true, loading: state.regions.detail.loading, error: state.regions.detail.error, onClose: () => store.closePhoto() })
            : state.selectionOpen ? h(gallery.SelectionPane, { photos: selection, onOpen: photo => { void store.openPhoto(photo) } }) : null),
      h(DiagnosticsPanel, { key: state.runId, runId: state.runId }),
      canPlan ? h(Button, { variant: 'primary', disabled: !state.status?.features?.includes('write'), onClick: () => onOpenChanges(runSummary.runId) }, t('previewWrite')) : null)
  }

  function TasksPanel({ state, onOpenAccount, onOpenChanges }) {
    const report = state.regions.run
    const pendingReport = state.runId && !report.data && (report.loading || report.error)
    return h('div', { className: 'afp-wb-panel-content afp-wb-task-layout' },
      h(RefreshForm, { state, onOpenAccount }),
      h('div', { className: 'afp-wb-task-results' }, h(LiveTasks, { state }),
      state.runId && state.regions.run.data ? h(ReportPanel, { state, onOpenChanges }) : null,
      pendingReport ? h('section', { className: 'afp-wb-section', 'aria-busy': report.loading },
        h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('runReport')),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => store.set({ runId: '', regions: { ...state.regions, run: { data: null, loading: false, error: '' } } }) }, t('closeReport'))),
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
        h('fieldset', { disabled: !writeEnabled || state.busy }, h('legend', null, t('categories')),
          h('div', { className: 'afp-wb-categories' }, ...categoryKeys.map(category => h('div', { key: category, className: 'afp-wb-category-option', 'data-selected': state.selected.includes(category) },
            h(Checkbox, { checked: state.selected.includes(category), label: t(category), onChange: () => store.set({ selected: state.selected.includes(category) ? state.selected.filter(item => item !== category) : [...state.selected, category] }) })))),
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

  return { TasksPanel, ChangesPanel }
}
