/** On-demand run diagnostics; exports contain only the Host's allowlisted fields.
 * @param {object} React Existing client runtime.
 * @param {object} UI Existing DSH buttons and status indicators.
 * @param {Function} t Locale lookup.
 * @param {object} store AFP authenticated action client.
 * @returns {Function} Collapsible diagnostics panel.
 */
export function createDiagnosticsPanel(React, UI, t, store) {
  const h = React.createElement, { Button, StateDot, Tag } = UI
  return function DiagnosticsPanel({ runId }) {
    const [open, setOpen] = React.useState(false), [data, setData] = React.useState(null)
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
    const request = React.useRef(0), mounted = React.useRef(false)
    React.useEffect(() => {
      mounted.current = true; setOpen(false); setData(null); setBusy(false); setError('')
      return () => { mounted.current = false; request.current++ }
    }, [runId])
    async function load() {
      const sequence = ++request.current
      setBusy(true); setError('')
      try {
        const result = await store.readDiagnostics(runId)
        if (mounted.current && sequence === request.current) setData(result)
      } catch (readError) { if (mounted.current && sequence === request.current) setError(t('diagnosticsReadFailed')) }
      finally { if (mounted.current && sequence === request.current) setBusy(false) }
    }
    function download() {
      if (!data || busy) return
      const { events, ...summary } = data
      const text = [{ event: 'summary', ...summary }, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'
      const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `afp-diagnostics-${data.runId}.jsonl`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return h('details', { className: 'afp-wb-diagnostics', open, 'data-afp-diagnostics': runId,
      onToggle: event => { const next = event.currentTarget.open; setOpen(next); if (next && !data && !busy) void load() } },
      h('summary', null, h('span', { className: 'afp-wb-disclosure-chevron', 'aria-hidden': true }),
        h('span', { className: 'afp-wb-diagnostics-title' }, t('diagnosticsTitle')),
        data ? h(Tag, { tone: data.failure ? 'warning' : 'quiet' }, t(data.debug ? 'diagnosticsDetailed' : 'diagnosticsSummary')) : null,
        data ? h('span', { className: 'afp-wb-subtle afp-wb-diagnostics-duration' }, `${(data.durationMs / 1000).toFixed(2)} s`) : null),
      h('div', { className: 'afp-wb-diagnostics-content', 'aria-busy': busy },
        h('div', { className: 'afp-wb-actions' },
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => { void load() },
            icon: busy ? h(StateDot, { state: 'ongoing', size: 14 }) : null }, t('reload')),
          h(Button, { variant: 'outline', size: 'sm', disabled: busy || !data, onClick: download }, t('diagnosticsExport'))),
        error ? h('p', { role: 'alert', className: 'afp-wb-error-row' }, error) : null,
        !data && !busy && !error ? h('p', { className: 'afp-wb-subtle' }, t('diagnosticsUnavailable')) : null,
        data ? h(React.Fragment, null,
          h('div', { className: 'afp-wb-diagnostics-overview' },
            h('div', null, h('span', { className: 'afp-wb-subtle' }, t('diagnosticsDuration')), h('strong', null, `${(data.durationMs / 1000).toFixed(2)} s`)),
            data.debug ? h(React.Fragment, null,
              h('div', null, h('span', { className: 'afp-wb-subtle' }, t('diagnosticsEvents')), h('strong', null, data.events.length)),
              h('div', null, h('span', { className: 'afp-wb-subtle' }, t('diagnosticsDropped')), h('strong', null, data.droppedEvents))) : null),
          data.storageIssue ? h('p', { role: 'alert' }, t('diagnosticsStorageIssue')) : null,
          data.failure ? h('div', { className: 'afp-wb-diagnostics-failure' },
            h(Tag, { tone: 'danger' }, `${t('diagnosticsFailure')}: ${t(`diagnosticsStage_${data.failure.stage}`)}`),
            ...[data.failure.code, data.failure.errorName, data.failure.systemCode].filter(Boolean).map((value, index) =>
              h(Tag, { key: index, tone: 'neutral' }, h('code', null, value)))) : null,
          h('details', { className: 'afp-wb-diagnostics-detail', 'data-afp-timings': true },
            h('summary', null, h('span', { className: 'afp-wb-disclosure-chevron', 'aria-hidden': true }), t('diagnosticsTimingDetails')),
            h('p', { className: 'afp-wb-subtle' }, t('diagnosticsTimingHelp')),
            h('div', { className: 'afp-wb-diagnostics-table-wrap', tabIndex: 0, 'aria-label': t('diagnosticsTimingDetails') }, h('table', null, h('thead', null, h('tr', null,
            ...['diagnosticsStage', 'diagnosticsCalls', 'diagnosticsFailures', 'diagnosticsDuration'].map(key => h('th', { key, scope: 'col' }, t(key))))),
            h('tbody', null, ...[...data.timings].sort((a, b) => b.durationMs - a.durationMs).map(row => h('tr', { key: row.stage, 'data-failed': row.failed > 0 },
              h('th', { scope: 'row' }, t(`diagnosticsStage_${row.stage}`)), h('td', null, row.count),
              h('td', null, row.failed ? h(Tag, { tone: 'danger' }, String(row.failed)) : h('span', { className: 'afp-wb-subtle' }, '0')),
              h('td', null, `${(row.durationMs / 1000).toFixed(2)} s`))))))),
          h('details', { className: 'afp-wb-diagnostics-detail', 'data-afp-diagnostic-metadata': true },
            h('summary', null, h('span', { className: 'afp-wb-disclosure-chevron', 'aria-hidden': true }), t('diagnosticsMetadata')),
            h('dl', { className: 'afp-wb-diagnostics-identities' },
              h('div', null, h('dt', null, t('diagnosticsRun')), h('dd', null, h('code', null, data.runId))),
              h('div', null, h('dt', null, t('diagnosticsJobId')), h('dd', null, h(Tag, { tone: 'info' }, h('code', null, data.jobId ?? '—'))))),
            data.failure?.frames.length ? h('section', { className: 'afp-wb-diagnostics-stack' }, h('h4', null, t('diagnosticsFrames')),
              h('ol', { className: 'afp-wb-diagnostics-frames' }, ...data.failure.frames.map((frame, index) =>
                h('li', { key: index }, h('span', { 'aria-hidden': true }, index + 1), h('code', null, frame))))) : null),
          h('p', { className: 'afp-wb-subtle' }, t('diagnosticsPrivacy'))) : null))
  }
}
