import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { afpReportFeedback, useAfpFeedbackProgress } from '../src/client/afp-conversation-feedback.js'
import { createAfpToolRow } from '../src/client/afp-conversation-progress.js'
import { summary, reviewedPhotoResults } from '../src/host/afp-refresh-workflow.js'
import { createReviewedPreviews, reviewedPreviewPhotos, reviewedImageRows } from '../src/client/afp-conversation-reviewed-images.js'
import { createAfpGallery } from '../src/client/afp-workbench-gallery.js'
import { renderPhotoResult } from '../src/host/afp-conversation-records.js'

const report = { runId: 'run', status: 'paused', stage: 'visual', categories: [
  { category: 'landscape', reviewed: 5, kept: 1, target: 10, requestFailures: 2 },
] }

test('historical reports count failed requests separately from completed pixel decisions', () => {
  const result = afpReportFeedback(report)
  assert.equal(result.pixelReviewed, 3); assert.equal(result.kept, 1); assert.equal(result.rejected, 2)
  assert.equal(result.requestFailures, 2); assert.equal(result.target, 10)
  assert.equal(afpReportFeedback({ planId: 'plan' }), null)
})

test('saved report summaries expose fixed rejection types without raw provider text', () => {
  const value = summary({ id: 'run', status: 'paused', settings: { targetPerCategory: 10 }, categories: ['food'], groups: {}, pending: null,
    decisions: [{ category: 'food', keep: true }, { category: 'food', keep: false, reason: 'preview or vision request failed' },
      { category: 'food', keep: false, reason: 'https://provider.example/?token=secret' },
      { category: 'food', keep: false, reason: 'category limit reached' }] })
  const row = value.categories[0]
  assert.equal(row.pixelReviewed, 3); assert.equal(row.requestFailures, 1); assert.equal(row.rejected, 2)
  assert.deepEqual(row.rejectionReasons, [{ code: 'visual-rule', count: 1 }, { code: 'duplicate-or-limit', count: 1 }])
  assert.doesNotMatch(JSON.stringify(value), /secret|provider/)
})

test('viewed-image identities use protected paths and remain out of the model output budget', () => {
  assert.deepEqual(reviewedPreviewPhotos(['one', 'one', 'opaque/id?', '', '\u0000']), [
    { id: 'one', previewPath: 'api/afp/preview?photoId=one' }, { id: 'opaque/id?', previewPath: 'api/afp/preview?photoId=opaque%2Fid%3F' },
  ])
  assert.deepEqual(reviewedPreviewPhotos('not-an-array'), [])
  const output = renderPhotoResult(JSON.stringify({ resultRef: 'ref', runId: 'run', pixelReviewed: 100,
    reviewedPhotoIds: Array.from({ length: 100 }, (_, index) => 'private-id-' + index + '-'.repeat(200)),
    reviewedPhotos: [{ id: 'private-id', keep: true }] }), 100)
  assert.equal(JSON.parse(output[0].text).pixelReviewed, 100)
  assert.doesNotMatch(output[0].text, /reviewedPhotoIds|reviewedPhotos|private-id/)
  assert.deepEqual(JSON.parse(renderPhotoResult(JSON.stringify({ pixelReviewed: 1, reviewedPhotoIds: ['private-id'], reviewedPhotos: [{ id: 'private-id' }] }), 100)[0].text), { pixelReviewed: 1 })
})

test('saved image outcomes preserve category verdicts and never classify failed requests as rejected', () => {
  const run = { groups: { landscape: { candidates: [{ id: 'one', title: '山谷' }, { id: 'two' }, { id: 'three' }] } }, decisions: [
    { id: 'one', category: 'landscape', keep: true },
    { id: 'one', category: 'travel', keep: false, reason: 'category limit reached' },
    { id: 'two', category: 'landscape', keep: false, confidence: 0.1, appliedThreshold: 0.9, reason: 'private provider text' },
    { id: 'three', category: 'landscape', keep: false, reason: 'preview or vision request failed' },
  ] }
  const saved = reviewedPhotoResults(run)
  assert.deepEqual(saved.map(photo => photo.reasonCode), [null, 'duplicate-or-limit', 'confidence', null])
  assert.doesNotMatch(JSON.stringify(saved), /private|provider/)
  const rows = reviewedImageRows(saved, ['one', 'two', 'three', 'pending'])
  assert.deepEqual(rows.map(photo => photo.status), ['passed', 'rejected', 'rejected', 'incomplete', 'unknown'])
  assert.equal(rows[0].title, '山谷')
  assert.deepEqual(reviewedImageRows(null, ['historical']).map(photo => photo.status), ['unknown'])
  assert.deepEqual(reviewedImageRows([{ id: '\u0000', keep: true }]), [])
  assert.equal(reviewedImageRows([{ id: 'safe', keep: false, previewPath: 'https://external/', reasonCode: 'private' }])[0].reasonCode, null)
})

test('chat and Workbench share the same large-image modal and image retry behavior', () => {
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => [initial, () => {}], useEffect() {} }
  const UI = { Modal() {}, Button() {} }, store = { getSnapshot: () => ({ selectedPhotos: {} }) }
  const gallery = createAfpGallery(React, UI, {}, key => key, store)
  const photo = { id: 'one', title: '山谷' }
  const pane = gallery.DetailPane({ photo })
  assert.equal(pane.children.at(-1).type, gallery.PreviewModal)
  const { PreviewModal } = createReviewedPreviews(React, UI, key => key, store)
  const modal = PreviewModal({ photo, onClose() {} })
  assert.equal(modal.type, UI.Modal)
  assert.equal(modal.props.className, 'afp-wb-preview-modal')
  assert.equal(modal.props.contentClassName, 'afp-wb-preview-modal-content')
  assert.equal(modal.children[0].props.large, true)
  assert.equal(modal.children[0].props.retry, true)
  assert.equal(PreviewModal({ photo: null }).props.open, false)
})

test('shared previews navigate the supplied review list without wrapping or consuming input arrows', () => {
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const UI = { Modal() {}, Button() {} }, gallery = createAfpGallery(React, UI, {}, key => key, {})
  const items = [{ id: 'one', category: 'landscape' }, { id: 'two', category: 'landscape' }]
  let changed
  const render = photo => gallery.PreviewModal({ photo, items, onChange: next => { changed = next }, onClose() {} })
  const first = render(items[0]), navigation = first.props.footer
  assert.equal(navigation.children[0].props.disabled, true)
  assert.equal(navigation.children[2].props.disabled, false)
  assert.equal(navigation.children[1].children[0], '1 / 2')
  navigation.children[2].props.onClick(); assert.equal(changed, items[1])
  const last = render(items[1])
  assert.equal(last.props.footer.children[2].props.disabled, true)
  const event = { key: 'ArrowRight', preventDefault() {}, stopPropagation() {}, target: { closest: () => null } }
  changed = null; last.props.onKeyDownCapture(event); assert.equal(changed, null)
  last.props.onKeyDownCapture({ ...event, key: 'ArrowLeft' }); assert.equal(changed, items[0])
  changed = null
  last.props.onKeyDownCapture({ ...event, key: 'ArrowLeft', ctrlKey: true })
  last.props.onKeyDownCapture({ ...event, key: 'ArrowLeft', target: { closest: () => ({}) } })
  assert.equal(changed, null)
  assert.equal(gallery.PreviewModal({ photo: items[0], items: [items[0]], onChange() {} }).props.footer, undefined)
})

test('legacy image identities do not become zero-count verdicts when the original record lacks outcomes', () => {
  const owner = JSON.stringify(['session', 1, 'call', 'ref'])
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {},
    useState: initial => [Object.hasOwn(initial, 'owner') ? { owner, ids: ['legacy'], photos: [], unavailable: false } : initial, () => {}] }
  const { ReviewedPreviews } = createReviewedPreviews(React, { DisclosureRow() {} }, key => key, {})
  const tree = ReviewedPreviews({ open: true, sessionId: 'session', turn: 1, callId: 'call', resultRef: 'ref' })
  assert.match(JSON.stringify(tree), /feedbackPhotoStatusUnknown/)
  assert.doesNotMatch(JSON.stringify(tree), /feedbackPhotosPassed|feedbackPhotosRejected|afp-reviewed-thumbnail/)
})

test('identical report rows consolidate while changed results and original records remain', async () => {
  const locale = JSON.parse(await readFile(new URL('../src/client/locales/zh.json', import.meta.url), 'utf8'))
  const React = { createElement: (type, props, ...children) => ({ type: typeof type === 'function' ? type.name : type, props, children }),
    useState: initial => [initial, () => {}], useEffect() {} }
  const UI = { DisclosureRow() {}, ToolIcon() {}, ChevronIcon() {}, Tag() {}, Button() {} }
  const Row = createAfpToolRow(React, UI, key => locale[key] ?? key)
  const block = (callId, value) => ({ callId, kind: 'tool-result', call: { name: 'afp_report', argsRaw: '{"kind":"run","id":"run"}' }, meta: { afp: { version: 1, result: value } } })
  const blocks = [block('first', report), block('same', report), block('changed', { ...report, status: 'ready' })]
  const source = { nodes: { values: () => blocks.map(root => ({ kind: 'tool-call', data: { root }, location: { kind: 'turn', turn: { turn: 1, status: 'closed' } } })),
    turnDataSource: () => ({ getSnapshot: () => blocks.map(root => ({ root })) }) } }
  const render = block => Row({ phase: 'result', block, callId: block.callId, toolName: 'afp_report', useChat: select => select(source) })
  const rendered = render(blocks[0]), disclosure = rendered.children[0]
  assert.equal(disclosure.props.title, '视觉校验 · 风景')
  assert.equal(disclosure.props.open, false); assert.equal(disclosure.props.expandable, true)
  assert.equal(disclosure.props.expandOnRowClick, true)
  assert.equal(disclosure.props.keepContentWhenOpen, true)
  assert.match(JSON.stringify(disclosure.props.collapsedContent), /已判断 3 张 · 保留 1 张 · 请求失败 2 张/)
  assert.equal(JSON.stringify(rendered).match(/"type":"DisclosureRow"/gu)?.length, 1)
  assert.equal(disclosure.children[0].children[0].type, 'ReviewedPreviews')
  const contentText = node => node === null || node === undefined ? '' : typeof node === 'object'
    ? (Array.isArray(node) ? node : node.children ?? []).map(contentText).join('') : String(node)
  assert.match(disclosure.props.collapsedContent.props.title, /保留 1 \/ 10 张/)
  assert.doesNotMatch(JSON.stringify(disclosure.children[0]), /afp-chat-feedback-counts|afp-chat-feedback-notice|feedbackScopeHelp/)
  assert.equal(contentText(disclosure.children[0]), '')
  assert.match(JSON.stringify(render(block('failed', { ...report, status: 'failed' })).children[0].props.collapsedContent), /检查失败/)
  assert.equal(render(blocks[1]), null); assert.notEqual(render(blocks[2]), null)
  assert.equal(blocks.length, 3)
})

function progressHooks() {
  let state, prior, cleanup
  const React = {
    useState(initial) { state ??= initial; return [state, next => { state = typeof next === 'function' ? next(state) : next }] },
    useEffect(effect, dependencies) {
      if (prior && dependencies.every((value, index) => value === prior[index])) return
      cleanup?.(); prior = dependencies; cleanup = effect()
    },
  }
  return { React, dispose: () => cleanup?.() }
}

function refreshFeedbackFixture(blocks, live = null) {
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {},
    useState(initial) { return [initial === false ? true : initial?.key === '' ? {
      key: JSON.stringify(['session', 1, 'launch']), live, disconnected: false,
    } : initial, () => {}] } }
  const UI = { DisclosureRow() {}, TextShimmer() {}, ToolIcon() {}, Tag() {}, Button() {} }
  const Row = createAfpToolRow(React, UI, key => key, {})
  const source = { nodes: { values: () => blocks.map(root => ({ kind: 'tool-call', data: { root },
    location: { kind: 'turn', turn: { turn: 1, status: live ? 'open' : 'closed' } } })),
    turnDataSource: () => ({ getSnapshot: () => blocks.map(root => ({ root })) }) } }
  const tree = Row({ phase: 'result', block: blocks.find(block => block.callId === 'launch'), callId: 'launch',
    toolName: 'afp_refresh', sessionId: 'session', useChat: select => select(source) })
  return tree.children[0].children[0]
}

const feedbackBlock = (name, callId, value, isError = false) => ({ callId, kind: 'tool-result', isError,
  call: { name, argsRaw: '{}' }, meta: { afp: { version: 1, result: value } } })

test('closed launch cards recover the latest matching saved report and its original call identity', () => {
  const saved = { ...report, status: 'ready', resultRef: 'saved-ref' }
  const blocks = [feedbackBlock('afp_report', 'before', { ...saved, resultRef: 'before-ref' }),
    feedbackBlock('afp_refresh', 'launch', { runId: 'run' }),
    { callId: 'nested', subCalls: [feedbackBlock('afp_report', 'original-report', saved)] },
    feedbackBlock('afp_report', 'foreign', { ...saved, runId: 'other', resultRef: 'foreign-ref' }),
    feedbackBlock('afp_report', 'failed', { ...saved, resultRef: 'failed-ref' }, true)]
  const feedback = refreshFeedbackFixture(blocks)
  assert.equal(feedback.props['data-afp-feedback'], 'report')
  const previews = feedback.children[0]
  assert.equal(previews.props.resultRef, 'saved-ref')
  assert.equal(previews.props.callId, 'original-report')
  assert.equal(previews.props.turn, 1)
  assert.equal(previews.props.liveIds, undefined)
  assert.equal(previews.props.livePhotos, undefined)
  assert.doesNotMatch(JSON.stringify(feedback), /feedbackLaunchRecord|feedbackTaskHelp/)
  blocks.push(feedbackBlock('afp_report', 'latest', { ...saved, resultRef: 'latest-ref' }))
  assert.equal(refreshFeedbackFixture(blocks).children[0].props.resultRef, 'latest-ref')
  blocks.push(feedbackBlock('afp_refresh', 'resume', { runId: 'run' }),
    feedbackBlock('afp_report', 'resumed-report', { ...saved, resultRef: 'resumed-ref' }))
  assert.equal(refreshFeedbackFixture(blocks).children[0].props.resultRef, 'latest-ref')
})

test('launch cards without a saved report show unavailable details instead of zero verdicts', () => {
  const feedback = refreshFeedbackFixture([feedbackBlock('afp_refresh', 'launch', { runId: 'run' })])
  assert.match(JSON.stringify(feedback), /feedbackPreviewRecordUnavailable/)
  assert.doesNotMatch(JSON.stringify(feedback), /ReviewedPreviews|feedbackPhotosPassed|feedbackPhotosRejected/)
})

test('running launch cards retain current pixels instead of replacing them with an earlier report', () => {
  const feedback = refreshFeedbackFixture([feedbackBlock('afp_refresh', 'launch', { runId: 'run' }),
    feedbackBlock('afp_report', 'report', { ...report, resultRef: 'ref' })],
  { state: 'running', stage: 'vision', reviewedPhotos: [{ id: 'new', keep: true }], previewPhotoIds: ['new'] })
  assert.equal(feedback.props['data-afp-feedback'], 'task')
  assert.deepEqual(feedback.children[1].props.livePhotos, [{ id: 'new', keep: true }])
  assert.equal(feedback.children[1].props.resultRef, undefined)
})

test('expanded visual phase shimmers only while its owning task is running and connected', async () => {
  const locale = JSON.parse(await readFile(new URL('../src/client/locales/zh.json', import.meta.url), 'utf8'))
  let open = true, disconnected = false, state = 'running', ownerStatus = 'open', hasPending = true
  const React = { createElement: (type, props, ...children) => ({ type: typeof type === 'function' ? type.name : type, props, children }), useEffect() {},
    useState(initial) { return [initial === false ? open : initial?.key === '' ? { key: JSON.stringify(['session', 1, 'live']), disconnected,
      live: { state, stage: state === 'running' ? 'vision' : state, category: 'landscape', previewed: 10, pixelReviewed: 8, requestFailures: 1,
        previewPhotoIds: hasPending ? ['checked', 'failed', 'pending', 'pending'] : ['checked', 'failed'], reviewedPhotos: [{ id: 'checked', keep: true }, { id: 'failed', keep: false, requestFailed: true }] } } : initial, () => {}] } }
  const UI = { DisclosureRow() {}, TextShimmer() {}, ToolIcon() {}, Tag() {}, Button() {} }
  const Row = createAfpToolRow(React, UI, key => locale[key] ?? key)
  const block = { callId: 'live', kind: 'tool-result', call: { name: 'afp_refresh', argsRaw: '{}' }, meta: { afp: { version: 1, result: { runId: 'run' } } } }
  const source = { nodes: { values: () => [{ kind: 'tool-call', data: { root: block }, location: { kind: 'turn', turn: { turn: 1, status: ownerStatus } } }],
    turnDataSource: () => ({ getSnapshot: () => [{ root: block }] }) } }
  const render = () => Row({ phase: 'result', block, callId: 'live', toolName: 'afp_refresh', sessionId: 'session', useChat: select => select(source) })
  const phase = tree => tree.children[0].children[0].children[0].children[0]
  const running = render()
  assert.equal(running.children[0].props.title, '视觉校验 · 风景')
  assert.equal(running.children[0].props.running, false)
  assert.equal(phase(running).type, 'TextShimmer'); assert.equal(phase(running).props.active, true)
  assert.equal(phase(running).children[0], '正在检查图片画面 · 1 张图片等待判断')
  assert.doesNotMatch(JSON.stringify(running.children[0].props.collapsedContent.children), /正在检查图片画面/)
  assert.match(JSON.stringify(running.children[0].props.collapsedContent.children), /本批预览 10 张/)
  hasPending = false
  assert.equal(phase(render()).children[0], '正在检查图片画面')
  hasPending = true
  open = false
  assert.equal(phase(render()).props.active, false)
  assert.equal(render().children[0].props.running, true)
  assert.match(JSON.stringify(render().children[0].props.collapsedContent.children), /正在检查图片画面/)
  open = true; disconnected = true
  assert.equal(phase(render()).props.active, false)
  disconnected = false
  for (state of ['completed', 'failed', 'stopped']) assert.equal(phase(render()).props.active, false)
  state = 'running'; ownerStatus = 'closed'
  assert.equal(phase(render()).props.active, false)
})

test('historical previews read the original result on expansion and ignore stale Session responses', async t => {
  const states = [], effects = []; let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type: typeof type === 'function' ? type.name : type, props, children }),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }] },
    useEffect(effect, dependencies) { const index = cursor++, prior = effects[index]
      if (prior && dependencies.every((value, position) => value === prior.dependencies[position])) return
      prior?.cleanup?.(); effects[index] = { dependencies, cleanup: effect() } },
  }
  t.after(() => effects.forEach(effect => effect?.cleanup?.()))
  const requests = [], store = { conversationData(method, context, signal) { return new Promise((resolve, reject) => requests.push({ method, context, signal, resolve, reject })) } }
  const { ReviewedPreviews } = createReviewedPreviews(React, { Button() {}, DisclosureRow() {} }, key => key, store)
  let zoom, zoomItems
  const render = (open, sessionId = 'old') => { cursor = 0; return ReviewedPreviews({ open, sessionId, turn: 1, callId: 'call', resultRef: 'ref', onOpen(photo, items) { zoom = photo; zoomItems = items } }) }
  assert.equal(render(false), null); assert.equal(requests.length, 0)
  render(true); assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].context, { sessionId: 'old', turn: 1, callId: 'call', resultRef: 'ref' })
  render(true, 'new'); assert.equal(requests[0].signal.aborted, true)
  requests[0].resolve({ reviewedPhotoIds: ['stale'] }); requests[1].resolve({ reviewedPhotoIds: ['first', 'second'], reviewedPhotos: [
    { id: 'first', keep: true }, { id: 'second', keep: false }, { id: 'failed', keep: false, requestFailed: true },
  ] })
  await new Promise(resolve => setImmediate(resolve))
  const disclosure = render(true, 'new').children[0].children[0]
  assert.equal(disclosure.props.open, false); assert.equal(disclosure.children[0], null)
  disclosure.props.onToggle()
  const tree = render(true, 'new'), result = tree.children[0].children[0].children[0], preview = result.children[0].children[0]
  assert.equal(preview.props.photo.id, 'first')
  assert.equal(result.children.length, 1)
  assert.equal(tree.children[1].children[0].props.open, false)
  tree.children[1].children[0].props.onToggle()
  const both = render(true, 'new')
  assert.equal(both.children[0].children[0].props.open, true)
  assert.equal(both.children[1].children[0].props.open, true)
  assert.equal(both.children[1].children[0].children[0].children.length, 1)
  both.children[1].children[0].children[0].children[0].children[0].props.open()
  assert.equal(zoom.id, 'second')
  assert.deepEqual(zoomItems.map(photo => photo.id), ['second'])
  both.children[0].children[0].props.onToggle()
  assert.equal(render(true, 'new').children[1].children[0].props.open, true)
  render(false, 'new'); render(true, 'new'); assert.equal(requests.length, 2)
})

test('live feedback keeps matching counters across disconnects and stops at the task terminal state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hooks = progressHooks(); t.after(hooks.dispose)
  let calls = 0
  const store = { getSnapshot: () => ({ status: { pollIntervalMs: 10 } }), async conversationData(_method, context) {
    assert.deepEqual(context, { sessionId: 'session', turn: 1, callId: 'call' }); calls++
    if (calls === 2) return []
    if (calls === 3) throw new Error('offline')
    return [{ callId: 'other', runId: 'run', pixelReviewed: 99 },
      { callId: 'call', runId: 'other', pixelReviewed: 99 },
      { callId: 'call', runId: 'run', state: calls === 4 ? 'completed' : 'running', previewed: 10, pixelReviewed: 8 }]
  } }
  const render = (status = 'open') => useAfpFeedbackProgress(hooks.React, store, { sessionId: 'session', callId: 'call' }, { turn: 1, status }, 'run')
  const flush = () => new Promise(resolve => setImmediate(resolve))
  render(); await flush()
  assert.equal(render().live.pixelReviewed, 8)
  t.mock.timers.tick(10); await flush()
  assert.equal(render().disconnected, true); assert.equal(render().live.previewed, 10)
  t.mock.timers.tick(10); await flush()
  assert.equal(render().disconnected, true); assert.equal(render().live.pixelReviewed, 8)
  t.mock.timers.tick(10); await flush()
  assert.equal(render().live.state, 'completed')
  t.mock.timers.tick(100); await flush(); assert.equal(calls, 4)
  assert.equal(render('closed').live, null)
})

test('switching Sessions aborts old subscriptions and ignores their delayed results', async t => {
  const hooks = progressHooks(); t.after(hooks.dispose)
  let finish, priorSignal, calls = 0
  const store = { getSnapshot: () => ({ status: { pollIntervalMs: 1000 } }), conversationData(_method, _context, signal) {
    calls++; priorSignal = signal; return new Promise(resolve => { finish = resolve })
  } }
  const render = (sessionId, status) => useAfpFeedbackProgress(hooks.React, store, { sessionId, callId: 'call' }, { turn: 1, status }, 'run')
  render('old', 'open'); assert.equal(calls, 1)
  assert.equal(render('new', 'closed').live, null); assert.equal(priorSignal.aborted, true)
  finish([{ callId: 'call', runId: 'run', state: 'running', pixelReviewed: 99 }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render('new', 'closed').live, null); assert.equal(calls, 1)
})
