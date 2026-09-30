/** All entry positions subscribe to the same profile store; component unmount never controls task lifetime. */
export function createWorkbench(React, Switch, ctx, t, store) {
  const h = React.createElement
  return function AfpWorkbench() {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const active = state.status?.features ?? []
    const action = (operation, args = {}) => { void store.invoke(operation, args) }
    const button = (label, operation, args, disabled = false) => h('button', { type: 'button', className: 'afp-button', disabled: state.busy || disabled, onClick: () => action(operation, args) }, t(label))
    const selected = state.selected
    return h('section', { className: 'afp-workbench', 'aria-label': t('title') },
      h('header', { className: 'afp-header' }, h('div', null, h('h2', null, t('title')), h('p', { className: 'afp-muted' }, t('scope'))), button('reload', 'status')),
      state.error ? h('p', { role: 'alert', className: 'afp-error' }, `${t('error')}: ${state.error}`) : null,
      !state.status ? h('p', { role: 'status' }, t('loading')) : null,
      h('section', { className: 'afp-section' }, h('h3', null, t('credentials')),
        h('p', { className: 'afp-muted' }, t('credentialHelp')),
        h('div', { className: 'afp-lines' }, ...Object.entries(state.status?.credentials ?? {}).map(([key, value]) => h('div', { key, className: 'afp-line' }, h('span', null, t(key)), h('span', null, t(value ? 'configured' : 'missing')))),
          h('div', { className: 'afp-line' }, h('span', null, t('vision')), h('span', null, t(state.status?.visionConfigured ? 'configured' : 'missing'))))),
      h('section', { className: 'afp-section' }, h('h3', null, t('features')),
        ...['script', 'skill', 'ui'].map(kind => h('div', { key: kind }, h('h4', null, t(kind)),
          ...(state.features ?? []).filter(feature => feature.kind === kind).map(feature => h('div', { className: 'afp-line', key: feature.id },
            h('div', null, h('strong', null, ctx.locale.resolveText(feature.title)), h('p', { className: 'afp-muted' }, ctx.locale.resolveText(feature.description)),
              h('small', { className: 'afp-muted' }, `${t(feature.enabled ? 'selected' : 'unselected')} · ${t(feature.running ? 'running' : 'stopped')}`)),
            h(Switch, { checked: feature.enabled, label: ctx.locale.resolveText(feature.title), loading: state.saving.includes(feature.id), onChange: next => { void store.toggle(feature.id, next) } })))))),
      h('section', { className: 'afp-section' }, h('h3', null, t('curation')),
        h('div', { className: 'afp-categories' }, ...(state.status?.categories ?? []).map(category => h('label', { key: category },
          h('input', { type: 'checkbox', checked: selected.includes(category), onChange: event => store.set({ selected: event.target.checked ? [...selected, category] : selected.filter(key => key !== category) }) }), t(category)))),
        h('div', { className: 'afp-toolbar' }, h('input', { className: 'afp-input', value: state.query, placeholder: t('query'), 'aria-label': t('query'), onChange: event => store.set({ query: event.target.value }) }),
          button('search', 'search', { query: state.query }, !active.includes('read') || !state.query.trim()), button('collections', 'collections', {}, !active.includes('read'))),
        h('div', { className: 'afp-toolbar' }, button('refresh', 'refresh', { categories: selected }, !active.includes('refresh') || !selected.length),
          h('input', { className: 'afp-input', value: state.runId, placeholder: t('runId'), 'aria-label': t('runId'), onChange: event => store.set({ runId: event.target.value }) }),
          button('resume', 'refresh', { runId: state.runId }, !active.includes('refresh') || !state.runId)),
        h('div', { className: 'afp-toolbar' }, h('select', { className: 'afp-input', value: state.operation, 'aria-label': t('operation'), onChange: event => store.set({ operation: event.target.value }) }, ...['append', 'replace', 'clear'].map(operation => h('option', { key: operation, value: operation }, t(operation)))),
          button('preview', 'plan', { operation: state.operation, categories: selected, ...(state.operation === 'clear' ? {} : { runId: state.runId }) }, !active.includes('write') || !selected.length || state.operation !== 'clear' && !state.runId))),
      state.plan ? h('section', { className: 'afp-section afp-confirm', role: 'region', 'aria-label': t('confirmation') },
        h('h3', null, t('confirmation')), h('p', { className: 'afp-muted' }, t('writeWarning')),
        h('table', null, h('thead', null, h('tr', null, ...['target', 'remove', 'add'].map(key => h('th', { key }, t(key))))),
          h('tbody', null, ...state.plan.categories.map(item => h('tr', { key: item.category }, h('td', null, item.selectionName), h('td', null, item.remove), h('td', null, item.add))))),
        h('p', { className: 'afp-muted' }, `${t('expires')}: ${new Date(state.plan.expiresAt).toLocaleString()}`),
        h('div', { className: 'afp-toolbar' }, button('confirm', 'confirm', { planId: state.plan.planId, confirmation: state.plan.confirmation, confirmed: true }, !active.includes('write')), h('button', { className: 'afp-button', type: 'button', onClick: () => store.set({ plan: null }) }, t('dismiss')))) : null,
      h('section', { className: 'afp-section' }, h('h3', null, t('tasks')),
        ...(state.status?.tasks ?? []).map(task => h('div', { key: task.taskId, className: 'afp-line' }, h('div', null, h('code', null, task.taskId), task.progress ? h('pre', { className: 'afp-report', role: 'status' }, task.progress) : null), h('span', null, t(task.feature === 'write' ? 'write' : 'refresh')), button('cancel', 'cancel', { taskId: task.taskId }))),
        !(state.status?.tasks?.length) ? h('p', { className: 'afp-muted' }, t('noTasks')) : null,
        ...(state.status?.reports ?? []).map(report => h('details', { key: report.runId ?? report.planId }, h('summary', null, `${report.runId ?? report.planId} · ${report.status ?? report.state}`), h('pre', { className: 'afp-report' }, JSON.stringify(report, null, 2))))),
      state.result ? h('section', { className: 'afp-section' }, h('h3', null, t('result')), h('pre', { className: 'afp-report', role: 'status' }, JSON.stringify(state.result, null, 2))) : null,
    )
  }
}
