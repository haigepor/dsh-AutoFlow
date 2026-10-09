import { afpReportFeedback, feedbackStages, useAfpFeedbackProgress } from './afp-conversation-feedback.js'
import { createReviewedPreviews, reviewedImageRows } from './afp-conversation-reviewed-images.js'

const names = {
  afp_status: 'agentCheckStatus', afp_search_plan: 'agentPlanSearch', afp_collections: 'agentReadTargets',
  afp_collection_list: 'agentReadCollections', afp_collection_items: 'collectionPhotos', afp_report: 'agentReadReport',
  afp_refresh: 'agentVisualReview', afp_photo_selection: 'agentSelectFinal', afp_result_page: 'agentReadSavedResults',
  afp_photo_search_start: 'agentSearchPhotos', afp_photo_search: 'agentSearchPhotos', afp_photo_details: 'agentReadPhotoDetails',
}

function decoded(block) {
  if (block.meta?.afp?.version === 1) return block.meta.afp.result
  const text = (block.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n').replace(/^Error: /u, '')
  try { return JSON.parse(text) } catch (error) {
    const resultRef = text.match(/^\{"resultRef":"([a-f0-9-]{36})"/u)?.[1]
    return resultRef && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(resultRef) ? { resultRef } : null
  }
}
/** Find a native or nested call’s owning Turn. @param {object} snapshot Chat snapshot. @param {string} callId Tool identity. @returns {object|null} Turn and its tool roots. */
export function afpTurnRows(snapshot, callId) {
  const contains = block => block.callId === callId || (block.subCalls ?? []).some(contains)
  for (const node of snapshot.nodes.values()) {
    if (node.kind !== 'tool-call' || !contains(node.data.root)) continue
    const turn = node.location.kind === 'step' || node.location.kind === 'turn' ? node.location.turn : null
    if (turn) return { turn, rows: snapshot.nodes.turnDataSource(turn.turn, 'tool-call').getSnapshot() }
  }
  return null
}
/** Apply resolved metadata to copied tool roots. @param {Array} rows Persisted roots. @param {object} resolved Result reference map. @returns {Array} Derived roots; source nodes remain unchanged. */
export function hydrateAfpRows(rows, resolved) {
  const visit = block => {
    const value = decoded(block), result = value?.resultRef && resolved[value.resultRef]
    return { ...block, ...(result ? { meta: { afp: { version: 1, complete: true, result } } } : {}), subCalls: (block.subCalls ?? []).map(visit) }
  }
  return rows.map(row => ({ ...row, root: visit(row.root) }))
}
/** Collect successful references still requiring local hydration. @param {Array} rows Tool roots. @returns {Array<string>} Unique opaque references. */
export function afpResultRefs(rows) {
  const refs = new Set()
  function visit(block) {
    if (!block.isError && block.kind === 'tool-result' && block.call?.name?.startsWith('afp_') && block.meta?.afp?.complete !== true) {
      const ref = decoded(block)?.resultRef
      if (typeof ref === 'string' && /^[a-f0-9-]{36}$/u.test(ref)) refs.add(ref)
    }
    for (const child of block.subCalls ?? []) visit(child)
  }
  for (const row of rows) visit(row.root)
  return [...refs]
}
/** Resolve complete nested results through the authenticated profile endpoint; no AFP network read. */
export function useAfpResolvedResults(React, store, sessionId, turn, rows) {
  const [cache, setCache] = React.useState({ owner: '', results: {} })
  const owner = JSON.stringify([sessionId, turn]), resolved = cache.owner === owner ? cache.results : {}
  const refs = afpResultRefs(rows), key = refs.join('|')
  React.useEffect(() => {
    const controller = new AbortController()
    // 翻页时保留已读取的本轮结果，避免候选数量归零闪烁或重复读取完整记录。
    if (cache.owner !== owner) setCache({ owner, results: {} })
    if (!sessionId || !turn) return () => controller.abort()
    for (const resultRef of refs.filter(ref => !resolved[ref])) store.conversationData('conversation-result', { sessionId, turn, resultRef }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setCache(previous => ({ owner, results: { ...(previous.owner === owner ? previous.results : {}), [resultRef]: result } })) })
      .catch(error => { /* 取消或记录不可用时保留紧凑结果，不推断最终图片。 */ })
    return () => controller.abort()
  }, [owner, key])
  return hydrateAfpRows(rows, resolved)
}

/** Localized AFP atomic rows keep raw call material in the trajectory inspector. */
export function createAfpToolRow(React, UI, t, store) {
  const { ReviewedPreviews, PreviewModal } = createReviewedPreviews(React, UI, t, store)
  return function AfpToolRow(props) {
    const value = props.phase === 'result' ? decoded(props.block) : null
    const error = props.block.isError ? value : null
    const [open, setOpen] = React.useState(false)
    const [zoomPhoto, setZoomPhoto] = React.useState(null)
    const report = !error && props.toolName === 'afp_report' ? afpReportFeedback(value) : null
    const repeat = props.useChat ? props.useChat(snapshot => {
      const owner = afpTurnRows(snapshot, props.callId)
      let first, count = 0
      function visit(block) {
        const same = block.call?.name === props.toolName && argumentKey(block.call?.argsRaw) === argumentKey(props.block.call?.argsRaw)
        if (same && (error && block.isError && decoded(block)?.code === error.code
          || report && !block.isError && block.kind === 'tool-result' && JSON.stringify(afpReportFeedback(decoded(block))) === JSON.stringify(report))) { first ??= block.callId; count++ }
        for (const child of block.subCalls ?? []) visit(child)
      }
      for (const row of owner?.rows ?? []) visit(row.root)
      return { hidden: Boolean((error || report) && first && first !== props.callId), count, turn: owner?.turn.turn, status: owner?.turn.status }
    }) : null
    const refresh = !error && props.toolName === 'afp_refresh' && value?.runId
    const activity = useAfpFeedbackProgress(React, store, props, repeat, refresh)
    if (repeat?.hidden) return null
    const format = (key, counts) => Object.entries(counts).reduce((text, [name, count]) => text.replace('{' + name + '}', String(count)), t(key))
    const live = activity.live
    const feedbackRunning = Boolean(refresh && live?.state === 'running' && !activity.disconnected)
    const livePhase = t(activity.disconnected ? 'agentProgressDisconnected' : live ? feedbackStages[live.stage] ?? 'feedbackVision'
      : repeat?.status === 'open' ? 'feedbackStarted' : 'feedbackLaunchRecord')
    const pendingPreviews = refresh ? reviewedImageRows(live?.reviewedPhotos, live?.previewPhotoIds).filter(photo => photo.status === 'unknown').length : 0
    const liveStageLine = [livePhase, live?.stage === 'collections' && live.collectionTotal !== undefined
      ? format('feedbackCollectionCount', { count: live.collectionCompleted ?? 0, total: live.collectionTotal }) : '',
      pendingPreviews ? format('feedbackPhotosPending', { count: pendingPreviews }) : ''].filter(Boolean).join(' · ')
    const liveCounts = live ? [
      live.previewed !== undefined ? format('feedbackPreviewCount', { count: live.previewed }) : '',
      live.pixelReviewed !== undefined ? format('feedbackJudgedCount', { count: live.pixelReviewed }) : '',
      live.requestFailures ? format('feedbackRequestFailures', { count: live.requestFailures }) : '',
    ].filter(Boolean).join(' · ') : ''
    const savedStage = { connection: 'agentStageConnection', collections: 'feedbackCollectionStage', visual: 'feedbackVisualStage' }
    const reportPhase = report ? [t('feedbackSavedStatus_' + report.status), savedStage[report.stage] && t(savedStage[report.stage])].filter(Boolean).join(' · ') : ''
    const compactCounts = live?.previewed !== undefined && live.pixelReviewed !== undefined ? [
      format('feedbackLiveInline', live),
      live.requestFailures ? format('feedbackFailureInline', { count: live.requestFailures }) : '',
    ].filter(Boolean).join(' · ') : liveCounts
    const inlineSummary = report ? [
      ['failed', 'cancelled', 'created', 'running'].includes(report.status) ? reportPhase : '', format('feedbackReportInline', report),
    ].filter(Boolean).join(' · ') : refresh ? [compactCounts, open ? '' : liveStageLine].filter(Boolean).join(' · ') : ''
    const summaryHint = report ? [inlineSummary, reportPhase, ...report.categories.map(row => t(row.category) + ' · ' + format('feedbackCategorySummary', row)), t('feedbackReportHelp')].join('\n') : [compactCounts, liveStageLine].filter(Boolean).join(' · ')
    const previews = React.createElement(ReviewedPreviews, { open, liveIds: refresh ? live?.previewPhotoIds ?? [] : undefined,
      livePhotos: refresh ? live?.reviewedPhotos ?? [] : undefined,
      resultRef: report ? value?.resultRef : undefined, sessionId: props.sessionId, turn: repeat?.turn, callId: props.callId, onOpen: setZoomPhoto })
    const feedback = report ? React.createElement('div', { className: 'afp-chat-feedback', 'data-afp-feedback': 'report' },
      previews) : refresh ?
      React.createElement('div', { className: 'afp-chat-feedback', 'data-afp-feedback': 'task' },
        React.createElement('p', { className: 'afp-chat-feedback-status', role: 'status', 'aria-live': 'polite', 'data-failed': activity.disconnected || ['failed', 'stopped'].includes(live?.state) || undefined },
          React.createElement(UI.TextShimmer, { active: open && feedbackRunning }, liveStageLine)),
        previews,
        !live || activity.disconnected || ['failed', 'stopped'].includes(live.state) ? React.createElement('p', { className: 'afp-chat-help' }, t(live?.state === 'failed' || live?.state === 'stopped' ? 'feedbackResumeHelp' : 'feedbackTaskHelp')) : null) : null
    const status = props.phase !== 'result' ? 'agentWorking' : error ? 'agentOperationFailed' : 'agentOperationDone'
    return React.createElement('div', { className: 'afp-agent-tool-row', 'data-state': error ? 'failed' : props.phase === 'result' ? 'completed' : 'running', 'data-feedback': feedback ? true : undefined },
      React.createElement(UI.DisclosureRow, { title: t(feedback ? 'feedbackRowTitle' : names[props.toolName] ?? 'agentOperation') + (report?.categories.length === 1 ? ' · ' + t(report.categories[0].category) : refresh && live?.category ? ' · ' + t(live.category) : ''), open: Boolean(feedback && open), expandable: Boolean(feedback), expandOnRowClick: true, keepContentWhenOpen: Boolean(feedback),
        onToggle: () => { setZoomPhoto(null); setOpen(previous => !previous) },
        icon: feedback ? React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
          React.createElement('rect', { x: 6, y: 6, width: 15, height: 15, rx: 3 }), React.createElement('path', { d: 'M3 15V5a2 2 0 0 1 2-2h10M6 17l4-4 4 4 3-3 4 4M11 10h.01', strokeLinecap: 'round', strokeLinejoin: 'round' })) : React.createElement(UI.ToolIcon, { size: 14 }), titleClassName: 'afp-agent-tool-title', contentLayoutClassName: 'afp-agent-tool-line',
        // 展开后仅阶段行显示流光，避免标题与正文同时闪动。
        running: props.phase !== 'result' || feedbackRunning && !open,
        collapsedContent: feedback ? React.createElement('span', { className: 'afp-agent-tool-summary', title: summaryHint, role: refresh ? 'status' : undefined },
          React.createElement('span', { 'aria-hidden': true }, '·'), ' ', inlineSummary) : props.phase === 'result' && !error ? null : React.createElement('span', { role: error ? 'alert' : 'status' },
          React.createElement(UI.Tag, { tone: error ? 'danger' : props.phase === 'result' ? 'neutral' : 'info' }, t(status)), repeat?.count > 1 ? ' · ' + repeat.count : '') }, feedback),
      error ? React.createElement('p', { className: 'afp-chat-help' }, t('agentError_' + error.code) === 'agentError_' + error.code ? t('agentFailureAdvice') : t('agentError_' + error.code)) : null,
      props.inspect ? React.createElement(UI.Button, { variant: 'ghost', size: 'sm', className: 'afp-agent-inspect', onClick: props.inspect }, t('agentInspectRecord')) : null,
      React.createElement(PreviewModal, { photo: open ? zoomPhoto : null, onClose: () => setZoomPhoto(null) }))
  }
}

/** Derive real AFP task states from this Turn's calls and live profile progress.
 * @param {Array} rows Successful and running tool roots.
 * @param {object} turn Owning timeline Turn.
 * @param {Array} live Authenticated current-call progress.
 * @returns {object} Steps, counts and operation history without estimated percentages.
 */
export function afpProgressModel(rows, turn, live) {
  const calls = []
  const visit = block => { if ((block.call?.name ?? block.name)?.startsWith('afp_')) calls.push(block); for (const sub of block.subCalls ?? []) visit(sub) }
  for (const row of rows) visit(row.root)
  const photos = new Set(), searches = [], remoteReads = new Set(['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_collections', 'afp_collection_list'])
  for (const call of calls) {
    if (call.isError || call.kind !== 'tool-result') continue
    const name = call.call?.name, result = decoded(call)
    if (['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_result_page', 'afp_report', 'afp_photo_selection'].includes(name)) {
      for (const photo of result?.found ? [result.photo] : result?.items ?? []) if (photo?.id) photos.add(photo.id)
    }
    if (['afp_photo_search_start', 'afp_photo_search'].includes(name)) searches.push(call)
  }
  const closed = turn.status === 'closed', turnStopped = ['aborted', 'interrupted'].includes(turn.end?.data.reason.kind)
  const refresh = calls.findLast(call => (call.call?.name ?? call.name) === 'afp_refresh')
  const selection = calls.findLast(call => call.kind === 'tool-result' && call.call?.name === 'afp_photo_selection' && !call.isError)
  // 新启动或后续成功选图覆盖旧任务终态；没有本轮启动记录的轮询不能决定任务状态。
  const selectionAfterRefresh = Boolean(selection && (!refresh || calls.indexOf(selection) > calls.indexOf(refresh)))
  const visualProgress = refresh?.kind === 'tool-result' && !refresh.isError && !selectionAfterRefresh
    ? live.findLast(item => item.name === 'afp_refresh' && item.callId === refresh.callId) : undefined
  const settled = new Set(calls.filter(call => call.kind === 'tool-result').map(call => call.callId))
  // 视觉启动结果只返回任务句柄；同步调用结果和已闭合轮次覆盖残留运行状态。
  const active = closed || turnStopped ? undefined : live.findLast(item => item.state === 'running'
    && (item.name !== 'afp_refresh' || item.callId === refresh?.callId && !refresh.isError && !selectionAfterRefresh)
    && (!settled.has(item.callId) || item === visualProgress))
  const pending = calls.findLast(call => call.kind !== 'tool-result')
  const stopped = turnStopped || !active && visualProgress?.state === 'stopped'
  const failed = !stopped && (!active && visualProgress?.state === 'failed'
    || closed && (turn.end?.data.reason.kind === 'error' || !selection && calls.some(call => call.isError)))
  const complete = closed && !stopped && !failed && Boolean(selection)
  const operation = active?.name ?? pending?.call?.name ?? pending?.name
  const waiting = !closed && !operation && !stopped && !failed
  const stage = complete ? 4 : ['selection', 'visual'].includes(active?.stage) || operation === 'afp_photo_selection' || operation === 'afp_refresh' || visualProgress ? 3
    : active?.stage === 'search' || ['afp_photo_search_start', 'afp_photo_search', 'afp_result_page'].includes(operation) ? 1 : selection ? 4 : searches.length ? 3 : 0
  // 状态检查只确认本地配置；实际读取成功后才显示远端连接已确认。
  const connectionRead = calls.some(call => call.kind === 'tool-result' && !call.isError && remoteReads.has(call.call?.name))
  const setupChecked = calls.some(call => call.kind === 'tool-result' && !call.isError && call.call?.name === 'afp_status')
  const states = [
    connectionRead || setupChecked ? 'done' : !closed && stage === 0 ? 'running' : 'pending',
    !closed && stage === 1 ? 'running' : searches.length ? 'done' : 'pending',
    photos.size || searches.length ? 'done' : 'pending',
    selectionAfterRefresh ? 'done' : stopped ? 'stopped' : failed ? 'failed' : !closed && stage === 3 ? 'running' : 'pending',
    complete ? 'done' : stopped ? 'stopped' : failed ? 'failed' : !closed && stage === 4 ? 'running' : 'pending',
  ]
  return { calls, active, visualProgress, closed, stopped, failed, complete, waiting, connectionRead, selectionSaved: Boolean(selection), stage, states, pages: searches.length, count: photos.size,
    selectedCount: selection ? decoded(selection)?.items?.length ?? null : null,
    status: stopped ? 'agentStopped' : failed ? 'agentOperationFailed' : complete ? 'agentOperationDone' : closed ? 'agentNoFinalSelection' : waiting ? 'agentWaiting' : 'agentWorking',
    operation: closed || stopped || failed ? null : operation ? names[operation] ?? 'agentOperation' : selection ? 'agentWritingSummary' : searches.length || visualProgress ? 'agentWaitingModel' : 'agentWaitingNextStep',
  }
}

/** Render a session-owned live capsule above the composer, with expandable task rows.
 * @param {object} React Client runtime.
 * @param {object} UI Existing Pills, Tags, dismissal and animated disclosure primitives.
 * @param {Function} t Plugin translator.
 * @param {object} store Authenticated AFP progress access.
 * @returns {Function} Session dock contribution; reads only its newest Turn.
 */
export function createAfpProgressDock(React, UI, t, store) {
  const h = React.createElement
  // 阶段图标沿用统一描边；状态由独立标记表达，避免完成后所有步骤变成相同图标。
  const paths = {
    connection: ['M8 3v4m8-4v4M6 7h12v3a6 6 0 0 1-12 0V7Z', 'M12 16v5'],
    search: ['M16.5 16.5 21 21'],
    merge: ['M5 4h10a2 2 0 0 1 2 2v2', 'M9 8h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z', 'M4 17H3a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2', 'M11 14h6m-3-3v6'],
    selection: ['M4 6h16M4 12h16M4 18h16', 'M8 4v4m8 2v4m-7 2v4'],
    complete: ['M10 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5', 'M3 16l5-5 4 4 3-3', 'm14 18 3 3 5-6'],
    check: ['m5 12 4 4L19 6'], pause: ['M9 6v12M15 6v12'], error: ['M12 7v6', 'M12 17h.01'],
  }
  function glyph(kind, className) {
    return h('svg', { className, width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      ...(paths[kind] ?? []).map((d, index) => h('path', { key: index, d })),
      kind === 'search' ? h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }) : null)
  }
  function TurnProgress({ turn, sessionId, useChat }) {
    const rawRows = useChat(snapshot => snapshot.nodes.turnDataSource(turn.turn, 'tool-call').getSnapshot())
    const rows = useAfpResolvedResults(React, store, sessionId, turn.turn, rawRows)
    const [live, setLive] = React.useState([]), [now, setNow] = React.useState(Date.now()), [open, setOpen] = React.useState(false)
    const [disconnected, setDisconnected] = React.useState(false), [traceOpen, setTraceOpen] = React.useState(false)
    const root = React.useRef(null), panelId = React.useId()
    const focusTrigger = () => root.current?.querySelector('.afp-progress-pill')?.focus()
    const model = afpProgressModel(rows, turn, live), activeCalls = model.calls.length > 0
    UI.useDismissOnOutsidePointer(root, open, setOpen)
    React.useEffect(() => {
      if (model.closed || !activeCalls) {
        // 闭合后停止订阅，但保留已经收到的后台终态；残留运行记录不能继续加载。
        setLive(previous => model.closed ? previous.filter(item => ['completed', 'failed', 'stopped'].includes(item.state)) : [])
        return
      }
      const controller = new AbortController(); let timer
      setLive([]); setDisconnected(false)
      const interval = store.getSnapshot().status?.pollIntervalMs ?? 2000
      const clock = setInterval(() => setNow(Date.now()), interval)
      const poll = async () => {
        try {
          const result = await store.conversationData('conversation-progress', { sessionId, turn: turn.turn }, controller.signal)
          if (!controller.signal.aborted) { setLive(result); setDisconnected(false); setNow(Date.now()) }
        } catch (error) { if (!controller.signal.aborted) { setLive([]); setDisconnected(true) } }
        if (!controller.signal.aborted) timer = setTimeout(poll, store.getSnapshot().status?.pollIntervalMs ?? 2000)
      }
      void poll()
      return () => { controller.abort(); clearTimeout(timer); clearInterval(clock) }
    }, [sessionId, turn.turn, model.closed, activeCalls])
    if (!activeCalls) return null
    const labels = ['agentStageConnection', 'agentStageSearch', 'agentStageMerge', 'agentStageSelection', 'agentStageDelivery']
    const seconds = Math.max(0, Math.floor((((model.closed ? turn.end?.time : now) ?? now) - (turn.start?.time ?? live[0]?.startedAt ?? now)) / 1000))
    const operation = t(disconnected && !model.closed ? 'agentProgressDisconnected' : model.active?.name === 'afp_refresh' ? feedbackStages[model.active.stage] ?? model.operation : model.operation ?? model.status)
    const statusTone = model.failed ? 'danger' : model.stopped || model.closed && !model.complete ? 'warning' : model.complete ? 'neutral' : 'info'
    const reconnecting = disconnected && !model.closed && !model.failed && !model.stopped
    const activity = reconnecting || model.failed || model.stopped ? 'paused' : model.waiting ? 'waiting' : 'running'
    const stateLabel = state => t({ done: 'agentOperationDone', running: activity === 'paused' ? 'agentReconnecting' : activity === 'waiting' ? 'agentWaiting' : 'agentWorking', failed: 'agentFailedShort', stopped: 'agentStoppedShort', pending: model.closed ? 'agentIncomplete' : 'agentPending' }[state])
    const operationRows = model.calls.map(call => {
      const name = call.call?.name ?? call.name, value = decoded(call)
      const visualState = call.callId === model.visualProgress?.callId ? model.visualProgress.state : undefined
      const state = call.isError ? 'failed' : visualState ? visualState === 'completed' ? 'done' : visualState : call.kind === 'tool-result' ? 'done' : 'running'
      let query
      try { const args = typeof call.call?.argsRaw === 'string' ? JSON.parse(call.call.argsRaw) : call.call?.argsRaw; query = args?.query } catch (error) { /* 流式参数未完成时不展示半段 JSON。 */ }
      return h('li', { key: call.callId, className: 'afp-task-trace', 'data-state': state },
        h('span', { className: 'afp-task-trace-dot', 'aria-hidden': true }),
        h('div', { className: 'afp-task-trace-copy' }, h('span', null, t(names[name] ?? 'agentOperation')), typeof query === 'string' ? h('small', { title: query }, query) : null,
          call.isError ? h('small', null, t('agentError_' + value?.code) === 'agentError_' + value?.code ? t('agentFailureAdvice') : t('agentError_' + value?.code)) : null),
        h(UI.Tag, { tone: state === 'failed' ? 'danger' : state === 'stopped' ? 'warning' : state === 'running' ? 'info' : 'neutral' }, stateLabel(state)))
    })
    const elapsed = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
    const stageKinds = ['connection', 'search', 'merge', 'selection', 'complete']
    const stepNotes = [t(model.connectionRead ? 'agentConnectionReady' : 'agentConnectionChecked'), t('agentPagesRead').replace('{count}', String(model.pages)),
      t('agentCandidatesMerged').replace('{count}', String(model.count)), model.selectedCount === null ? t('agentResultsSaved') : t('agentPhotosSelected').replace('{count}', String(model.selectedCount)), t('agentResultsSaved')]
    const steps = h('ol', { className: 'afp-task-steps' }, ...labels.map((label, index) => {
      const state = model.states[index]
      const detail = state === 'running' ? activity === 'waiting' && index === 3 && model.count > 0 ? t('agentWaitingSelectionHelp') : operation : state === 'done' ? stepNotes[index] : null
      return h('li', { key: label, 'data-state': state, 'data-activity': state === 'running' ? activity : undefined, style: { '--afp-step-index': index }, 'aria-current': state === 'running' ? 'step' : undefined },
        h('span', { className: 'afp-agent-stage-dot', 'aria-hidden': true }, glyph(stageKinds[index])),
        h('div', { className: 'afp-task-step-copy' }, h('span', null, t(label)),
          detail ? h('small', null, detail) : null),
        state === 'done' ? h('span', { className: 'afp-task-state-check', 'aria-label': stateLabel(state) }, glyph('check'))
          : state === 'running' ? h('span', { className: 'afp-task-state-activity' },
            activity === 'paused' ? glyph('pause') : h('span', { className: 'afp-task-loading-dots', 'aria-hidden': true }, ...[0, 1, 2].map(index => h('i', { key: index }))),
            h('span', null, stateLabel(state)))
            : h('span', { className: 'afp-task-state-label' }, stateLabel(state)))
    }))
    const metrics = h('div', { className: 'afp-agent-metrics' },
      ...[[model.pages, 'agentMetricPages'], [model.count, 'agentMetricCandidates'], [elapsed, 'agentMetricElapsed']].map(([value, label]) =>
        h('div', { key: label }, h('strong', null, value), h('span', null, t(label)))))
    const header = h('div', { className: 'afp-task-panel-header' },
      h('span', { className: 'afp-task-panel-glyph' }, glyph(stageKinds[model.stage])),
      h('div', { className: 'afp-task-panel-heading' }, h('strong', null, t('agentProgress')),
        h('span', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, model.closed ? operation : activity === 'paused' ? operation : t('agentCurrentStep').replace('{step}', t(labels[model.stage])))),
      h(UI.Button, { variant: 'ghost', size: 'sm', onClick: () => { setOpen(false); focusTrigger() }, 'aria-label': t('close') }, h(UI.CloseIcon, { size: 14 })))
    const trace = h('div', { className: 'afp-task-traces' },
      h('button', { type: 'button', className: 'afp-task-trace-toggle', onClick: () => setTraceOpen(value => !value), 'aria-expanded': traceOpen, 'aria-controls': panelId + '-trace' },
        h(UI.ChevronIcon, { size: 12 }), h('span', null, t('agentTaskTrace')), h('span', { className: 'afp-task-trace-count' }, model.calls.length)),
      h(UI.AnimatedCollapse, { open: traceOpen, id: panelId + '-trace' }, h('ol', null, ...operationRows)))
    const progress = model.active ?? model.visualProgress
    const body = h('div', { className: 'afp-task-panel-body' }, metrics, steps,
      model.closed && !model.selectionSaved ? h('p', { className: 'afp-task-note' }, t('agentIncompleteHelp')) : null,
      progress?.retryCount ? h('p', { className: 'afp-task-note', role: 'status' }, t('agentRetryCount').replace('{count}', String(progress.retryCount))) : null,
      progress?.total ? h('p', { className: 'afp-task-note', role: 'status' }, t('agentCheckedCount').replace('{count}', String(progress.completed ?? 0)).replace('{total}', String(progress.total))) : null, trace)
    const panel = h('div', { className: 'afp-progress-popover' }, h(UI.AnimatedCollapse, { open, id: panelId, className: 'afp-progress-reveal' },
      h('section', { className: 'afp-task-panel', 'aria-label': t('agentProgress') }, header, body)))
    // 完成状态只出现一次；胶囊的正文保留任务名称或当前操作。
    const pillOperation = model.closed ? t('agentCapsuleTask') : operation
    const pill = h(UI.Pill, { active: open, className: 'afp-progress-pill', onClick: () => setOpen(value => !value), 'aria-expanded': open, 'aria-controls': panelId, 'aria-label': t('agentProgress') + ' · ' + operation },
      h('span', { className: 'afp-progress-pill-dot', 'aria-hidden': true }), h('span', { className: 'afp-progress-pill-name' }, 'AFP'),
      h('span', { className: 'afp-progress-pill-operation' }, pillOperation), h(UI.Tag, { tone: reconnecting ? 'warning' : statusTone }, t(reconnecting ? 'agentReconnecting' : model.status)),
      h('span', { className: 'afp-progress-pill-time', 'aria-label': t('agentElapsed').replace('{seconds}', String(seconds)) }, elapsed),
      h(UI.ChevronIcon, { size: 12, className: 'afp-progress-chevron' }))
    return h('div', { ref: root, className: 'afp-progress-dock', 'data-open': open, 'data-state': model.failed ? 'failed' : model.stopped ? 'stopped' : model.closed ? 'closed' : activity,
      onKeyDownCapture: event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); focusTrigger() } } }, panel, pill)
  }
  return function AfpProgressDock({ sessionId, useChat }) {
    const timeline = useChat(snapshot => snapshot.timeline), turn = timeline.turns.get(timeline.turnOrder.at(-1))
    return turn ? h(TurnProgress, { key: sessionId + ':' + turn.turn, turn, sessionId, useChat }) : null
  }
}

/** Register inline AFP feedback; task planning uses the native todo dock.
 * @param {object} ctx Slot context.
 * @param {Function} ToolRow Atomic tool row component.
 * @param {string} locale Locale namespace.
 * @returns {void} Contributions follow plugin disposal.
 */
export function registerAfpProgress(ctx, ToolRow, locale) {
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of Object.keys(names).filter(key => !['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_result_page'].includes(key))) yield ctx.slots.register({ name: 'tool.call.toolview', key, locale }, ToolRow)
  })
}

/** Stable parsed input identity groups equivalent failed JSON calls. */
function argumentKey(raw) {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
  try { return JSON.stringify(sorted(typeof raw === 'string' ? JSON.parse(raw) : raw)) }
  catch (error) { return String(raw) }
}
