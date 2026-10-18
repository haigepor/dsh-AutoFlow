/** Localized progress and evidence views for persisted article analysis. */
import { runPresentation } from './workflow-view.js'

/** Compose shared-primitives panels without owning background tasks. @param {object} React React runtime. @param {object} ui Shared UI primitives. @param {Function} t Locale lookup. @returns {object} Workbench panels. */
export function createWorkflowPanels(React, ui, t) {
  const h = React.createElement, { Button, Tag, SegmentedControl } = ui
  const action = (label, onClick, disabled = false) => h(Button, { variant: 'outline', size: 'sm', onClick, disabled }, label)
  function References({ blockIds = [], assetIds = [], onBlock, onAsset }) {
    return h('div', { className: 'ai-evidence-links', 'aria-label': t('sourceReferences') }, ...blockIds.map(id => h(Button, { key: id, variant: 'ghost', size: 'sm', onClick: () => onBlock(id), 'aria-label': t('locateBlock').replace('{id}', id) }, id)),
      ...assetIds.map((id, index) => h(Button, { key: id, variant: 'ghost', size: 'sm', onClick: () => onAsset(id) }, t('originalReference').replace('{index}', String(index + 1)))))
  }
  function Elapsed({ run }) {
    const [currentTime, setCurrentTime] = React.useState(Date.now)
    const active = ['queued', 'running'].includes(run.status)
    React.useEffect(() => {
      if (!active) return
      setCurrentTime(Date.now())
      const timer = setInterval(() => setCurrentTime(Date.now()), 1000)
      return () => clearInterval(timer)
    }, [run.attemptId, active])
    const elapsed = runPresentation(run, currentTime).elapsedMs
    if (elapsed === null) return null
    const seconds = Math.floor(elapsed / 1000)
    return h('div', { className: 'ai-elapsed', 'aria-label': t('elapsedLabel') }, h('span', null, t('elapsedLabel')), h('time', { dateTime: `PT${seconds}S` }, `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`))
  }
  function Diagnostics({ run, clientError }) {
    const [copied, setCopied] = React.useState(''), [tab, setTab] = React.useState('logs'), tabsId = React.useId()
    React.useEffect(() => { setCopied('') }, [run.attemptId])
    const events = run.events ?? []
    const clientReadError = clientError ? (/^[a-z][a-z0-9-]{0,79}$/u.test(clientError) ? clientError : 'workbench-read-failed') : undefined
    const debug = JSON.stringify({ runId: run.id, attemptId: run.attemptId, stage: run.stage, status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt, error: run.error, clientReadError, counts: run.counts, eventsDropped: run.eventsDropped ?? 0, events }, null, 2)
    const copy = async () => { try { await navigator.clipboard.writeText(debug); setCopied('diagnosticsCopied') } catch { setCopied('diagnosticsCopyFailed') } }
    return h('section', { className: 'ai-run-diagnostics', 'aria-label': t('diagnosticsTitle') },
      h('header', { className: 'ai-diagnostics-heading' }, h('h3', null, t('diagnosticsTitle')), h('p', { className: 'ai-subtle' }, t('diagnosticsPageHint'))),
      h('div', { className: 'ai-reading-meta' }, h('span', null, t(`stage_${run.stage}`), ' · ', t(`state_${run.status}`)), h(Elapsed, { run })),
      h('dl', { className: 'ai-diagnostics-summary' }, h('div', null, h('dt', null, t('diagnosticsAttempt')), h('dd', null, h('code', { title: run.attemptId ?? run.id }, (run.attemptId ?? run.id).slice(0, 12)))),
        h('div', null, h('dt', null, t('startedAt')), h('dd', null, run.startedAt ? new Date(run.startedAt).toLocaleString() : '—')),
        h('div', null, h('dt', null, t('diagnostic_code')), h('dd', null, run.error ?? t('diagnosticsNoError')))),
      h('div', { className: 'ai-diagnostics-toolbar' }, h(SegmentedControl, { id: tabsId, className: 'ai-diagnostics-tabs', label: t('diagnosticsTitle'), value: tab, onChange: setTab, options: ['logs', 'debug'].map(value => ({ value, label: t(`diagnosticsTab_${value}`) })) }),
        h('span', { className: 'ai-subtle ai-diagnostics-count' }, events.length ? t('diagnosticsCount').replace('{count}', String(events.length)) : t('diagnosticsEmptyLabel')), action(t('copyDiagnostics'), copy)),
      h('div', { className: 'ai-diagnostics-body' }, h('p', { className: 'ai-subtle ai-diagnostics-privacy' }, t('diagnosticsPrivacy')),
        copied ? h('p', { role: 'status', className: 'ai-subtle' }, t(copied)) : null,
        h('div', { id: `${tabsId}-logs-panel`, role: 'tabpanel', 'aria-labelledby': `${tabsId}-logs`, hidden: tab !== 'logs', tabIndex: 0 },
          events.length ? h('ol', { className: 'ai-run-events', 'aria-label': t('diagnosticsTab_logs') }, ...events.map(event => h('li', { key: event.seq, 'data-error': Boolean(event.details.code || event.details.statusCode >= 400) },
          h('time', { dateTime: event.at }, new Date(event.at).toLocaleTimeString()), h('div', null, h('span', null, t(`event_${event.event}`) || t(`stage_${event.stage}`) || event.event),
            Object.keys(event.details).length ? h('code', null, Object.entries(event.details).map(([key, value]) => `${t(`diagnostic_${key}`) || key}: ${Array.isArray(value) ? value.join(', ') : value}`).join(' · ')) : null)))) : h('p', { className: 'ai-subtle' }, t('diagnosticsEmpty')),
          run.eventsDropped ? h('p', { className: 'ai-subtle' }, t('diagnosticsDropped').replace('{count}', String(run.eventsDropped))) : null),
        h('div', { className: 'ai-debug-data', id: `${tabsId}-debug-panel`, role: 'tabpanel', 'aria-labelledby': `${tabsId}-debug`, hidden: tab !== 'debug', tabIndex: 0 }, h('pre', null, debug))))
  }
  function Quality({ snapshot, review, evidence, onEvidence, onReview, disabled, canReview }) {
    const quality = snapshot.quality, verified = Boolean(review) && review.sourceHash === snapshot.sourceHash
    return h('section', { className: 'ai-source-quality', 'aria-label': t('sourceQuality') }, h('div', { className: 'ai-section-heading' }, h('h3', null, t('sourceQuality')), h(Tag, { tone: quality.status === 'passed' ? 'success' : 'warning' }, t(`quality_${quality.status}`))),
      h('p', { className: 'ai-subtle' }, t('qualityScopeHint')),
      quality.reasons.length ? h('ul', { className: 'ai-quality-reasons' }, ...quality.reasons.map((reason, index) => h('li', { key: index }, t(`qualityReason_${reason}`) || t(`error_${reason}`) || t('qualityUnknownIssue')))) : null,
      verified ? h('p', { className: 'ai-subtle' }, t('sourceVerified'), ' ', review.evidence) : quality.status === 'needs-review' ? h('div', { className: 'ai-quality-review' }, h('label', { className: 'ai-field' }, h('span', null, t('sourceReviewEvidence')), h('textarea', { value: evidence, onChange: event => onEvidence(event.target.value), rows: 2, maxLength: 4000, 'aria-label': t('sourceReviewEvidence') })),
        action(t('reviewAndAnalyze'), onReview, disabled || !canReview || !evidence.trim())) : quality.status !== 'passed' ? h('p', { className: 'ai-subtle' }, t('knownMissingHint')) : null)
  }
  function Understanding({ value, input, rulesOutdated, onBlock, onAsset }) {
    if (!value) return null
    const values = [['articleType', value.articleType], ['audience', value.audience], ['articlePurpose', value.purpose], ['theme', value.theme]]
    return h('section', { className: 'ai-understanding', 'aria-label': t('analysisEvidence') }, h('div', { className: 'ai-section-heading' }, h('h3', null, t('analysisEvidence')), h(Tag, { tone: 'quiet' }, t('requiresSemanticReview'))),
      h('dl', { className: 'ai-understanding-summary' }, ...values.flatMap(([key, text]) => [h('dt', { key: key + '-label' }, t(key)), h('dd', { key }, text)])),
      h('h4', null, t('articleStructure')), h('ol', null, ...value.sections.map((section, index) => h('li', { key: index }, h('h4', null, section.title), h('p', null, section.summary), h(References, { blockIds: section.blockIds, onBlock, onAsset })))),
      h('h4', null, t('groundedFacts')), h('ul', null, ...value.facts.map(fact => h('li', { key: fact.id }, h(Tag, { tone: 'quiet' }, t(`factKind_${fact.kind}`)), h('p', null, fact.claim), h(References, { ...fact.evidence, onBlock, onAsset })))),
      value.limitations.length ? h(React.Fragment, null, h('h4', null, t('limitations')), h('ul', null, ...value.limitations.map((text, index) => h('li', { key: index }, text)))) : null,
      value.questions.length ? h(React.Fragment, null, h('h4', null, t('openQuestions')), h('ul', null, ...value.questions.map((text, index) => h('li', { key: index }, text)))) : null,
      value.images.length ? h(React.Fragment, null, h('h4', null, t('imageRelationships')), ...value.images.map(image => h('section', { key: image.assetId, className: 'ai-image-evidence' }, h('p', null, image.observations), h('p', null, image.relationship), h(References, { blockIds: image.blockIds, assetIds: [image.assetId], onBlock, onAsset })))) : null,
      h('p', { className: 'ai-subtle' }, t('inputCoverage').replace('{blocks}', String(value.coverage.blockIds.length)).replace('{assets}', String(value.coverage.assetIds.length))),
      input?.rules?.rulesHash ? h('p', { className: 'ai-subtle' }, t('rulesVersion'), ' ', h('code', { title: input.rules.rulesHash }, input.rules.rulesHash.slice(0, 12)), input.model ? ` · ${input.model.provider} / ${input.model.model}` : '') : null,
      rulesOutdated ? h('p', { className: 'ai-subtle', role: 'status' }, t('rulesOutdated')) : null)
  }
  return { Diagnostics, Quality, Understanding, References }
}
