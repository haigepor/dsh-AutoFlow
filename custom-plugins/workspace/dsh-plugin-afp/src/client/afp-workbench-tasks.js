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
    return h('section', { className: 'afp-wb-section' }, h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('runHistory')),
      h(ReloadButton, { loading: region.loading, onClick: () => { void store.loadHistory('runs') } })),
      error({ ...region, retry: () => store.loadHistory('runs') }),
      !rows.length && !region.loading && !region.error ? h('p', { className: 'afp-wb-empty' }, t('noRunHistory')) : null,
      !rows.length && region.loading ? h(HistorySkeleton) : null,
      h('div', { className: 'afp-wb-history-list' }, ...rows.map(item => h('button', { type: 'button', className: 'afp-wb-history-row', key: item.id,
        onClick: () => { void store.openRun(item.id) } },
        h('span', { className: 'afp-wb-history-title' }, item.createdAt ? new Date(item.createdAt).toLocaleString() : t('dateUnknown')),
        h(Tag, { tone: item.status === 'ready' || item.status === 'paused' ? 'success' : item.status === 'failed' ? 'warning' : 'neutral' }, t(`runStatus_${item.status}`)),
        h('span', { className: 'afp-wb-subtle' }, (item.run?.categories ?? []).map(row => `${t(row.category)} ${row.kept}/${row.target}`).join(' · '))))),
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
    return h('section', { className: 'afp-wb-section' }, h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('liveTasks')),
      h(Tag, { tone: 'neutral' }, String(tasks.length))),
      tasks.length ? h('div', { className: 'afp-wb-live-list' }, ...tasks.map(task => {
        let progress = null
        try { progress = task.progress ? JSON.parse(task.progress) : null } catch (error) { /* 隐藏不符合已知进度字段的内容，不显示原始输出。 */ }
        return h('article', { className: 'afp-wb-live-row', key: task.taskId },
          h('div', null, h('p', { className: 'afp-wb-history-title' }, t(task.feature === 'write' ? 'writeTask' : 'refreshTask')),
            progress && typeof progress.category === 'string' ? h('p', { className: 'afp-wb-subtle' }, `${t(progress.category)} · ${t('keptCount')} ${progress.kept}/${progress.target} · ${t('batch')} ${progress.batch}`) : null),
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
    const canPlan = ['ready', 'paused'].includes(runSummary?.status) && !runSummary?.pendingBatch
    return h('section', { className: 'afp-wb-section afp-wb-report' },
      h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('runReport')),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => store.set({ runId: '', regions: { ...state.regions, run: { data: null, loading: false, error: '' } } }) }, t('closeReport'))),
      runSummary ? h('div', { className: 'afp-wb-report-summary' }, ...runSummary.categories.map(row => h('p', { key: row.category },
        `${t(row.category)} · ${t('reviewedCount')} ${row.reviewed} · ${t('keptCount')} ${row.kept}/${row.target} · ${t('requestFailures')}: ${row.requestFailures}`))) : null,
      h('div', { className: 'afp-wb-toolbar' },
        h('div', { className: 'afp-wb-field' }, h('span', null, t('categoryFilter')),
          h(Selector, { value: state.reportCategory, label: t('categoryFilter'),
            options: [{ value: '', label: t('allCategories') }, ...categoryKeys.filter(category => runSummary?.categories.some(row => row.category === category)).map(value => ({ value, label: t(value) }))],
            onChange: category => { void store.openRun(state.runId, { category, decision: state.reportFilter }) } })),
        h('div', { className: 'afp-wb-field' }, h('span', null, t('decisionFilter')),
          h(Selector, { value: state.reportFilter, label: t('decisionFilter'), options: ['all', 'kept', 'rejected', 'failed'].map(value => ({ value, label: t(`filter_${value}`) })),
            onChange: decision => { void store.openRun(state.runId, { category: state.reportCategory, decision }) } }))),
      region.error ? h('div', { role: 'alert', className: 'afp-wb-error-row' }, t('regionReadFailed'),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter }) } }, t('retry'))) : null,
      runSummary?.categories.every(row => row.reviewed === 0) ? h('p', { className: 'afp-wb-empty' }, t('noReviewedItems'))
        : h('div', { className: `afp-wb-gallery-layout${state.detail ? ' is-with-aside' : ''}` },
          h('div', { className: 'afp-wb-gallery-wrap' }, h(gallery.PhotoGrid, { items, report: true }),
            region.data?.hasMore ? h(Button, { variant: 'outline', disabled: region.loading, onClick: () => { void store.openRun(state.runId, { category: state.reportCategory, decision: state.reportFilter, more: true }) } }, t('loadMore')) : null),
          state.detail && state.tab === 'tasks' ? h(gallery.DetailPane, { photo: state.detail, loading: state.regions.detail.loading, error: state.regions.detail.error, onClose: () => store.closePhoto() }) : null),
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
        h('span', { className: 'afp-wb-history-title' }, t(item.plan.operation)),
        h('span', { className: 'afp-wb-subtle afp-wb-plan-date' }, item.createdAt ? new Date(item.createdAt).toLocaleString() : t('dateUnknown')),
        h(Tag, { tone: item.status === 'completed' ? 'success' : item.status === 'failed' ? 'warning' : 'neutral' }, t(`planStatus_${item.status}`))),
      h('p', { className: 'afp-wb-subtle' }, `${t('changeId')} · ${item.id}`),
      h('ul', { className: 'afp-wb-plan-results' }, ...item.plan.targets.map(target => {
        const actual = item.plan.result?.categories?.find(row => row.category === target.category)
            return h('li', { key: target.category }, `${t(target.category)} · ${t('removedCount')} ${actual?.removed ?? '—'} · ${t('addedCount')} ${actual?.added ?? '—'} · ${t(`planStatus_${actual?.status ?? item.status}`)}`)
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
      h('section', { className: 'afp-wb-section' },
        h('div', { className: 'afp-wb-section-heading' }, h('h3', null, t('planHistory')),
          h(ReloadButton, { loading: state.regions.plans.loading, onClick: () => { void store.loadHistory('plans') } })),
        state.regions.plans.error ? error({ ...state.regions.plans, retry: () => store.loadHistory('plans') }) : null,
        !plans.length && state.regions.plans.loading ? h(HistorySkeleton) : null,
        !plans.length && !state.regions.plans.loading && !state.regions.plans.error ? h('p', { className: 'afp-wb-empty' }, t('noPlanHistory')) : null,
        ...planRows,
        state.regions.plans.data?.hasMore ? h(Button, { variant: 'outline', size: 'sm', disabled: state.regions.plans.loading, onClick: () => { void store.loadHistory('plans', { more: true }) } }, t('loadMore')) : null)))
  }

  return { TasksPanel, ChangesPanel }
}
