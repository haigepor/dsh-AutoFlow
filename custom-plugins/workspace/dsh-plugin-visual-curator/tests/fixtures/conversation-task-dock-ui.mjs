/** Complete native conversation layout with controlled, keyless task responses. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { ConversationContent } from '../../../../../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx'
import { ConversationWidthControls } from '../../../../../packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx'
import { TodoPanel } from '../../../../../packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx'
import { installIconSprite } from '../../../../../packages/client/ui-theme/src/client/icon-sprite.ts'
import conversationCss from '../../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import { createConversationFeedback } from '../../src/client/conversation-feedback.ts'
import { createConversationTaskDock } from '../../src/client/conversation-task-dock.tsx'
import { createTaskToolView } from '../../src/client/task-tool-view.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import taskMetricArtwork from '../../assets/task-metric-plates-v2.webp'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'
import '../../../../../packages/client/ui-theme/src/styles/scrollbar.css'

const h = React.createElement, t = key => zh[key]
const todoT = (key, vars = {}) => ({ 'todo.title': '任务', 'todo.status.completed': '已完成', 'todo.status.inProgress': '进行中', 'todo.status.pending': '待处理', 'todo.progress.done': `${vars.done} 已完成`, 'todo.progress.active': `${vars.active} 进行中`, 'todo.progress.pending': `${vars.pending} 待处理` })[key] ?? key
const todos = [{ content: '读取当前风格资料', status: 'completed' }, { content: '查找并复核图片', status: 'in_progress' }, { content: '汇总匹配结果', status: 'pending' }]
const themeDisposers = []
installIconSprite({ effect(work) { themeDisposers.push(work()) }, on() { return () => {} } }, undefined)
const style = document.createElement('style'); style.textContent = pluginCss.replace('__VC_TASK_METRIC_ART__', taskMetricArtwork); document.head.append(style)
const { run } = window.feedbackFixtureData
const state = { preparing: new URL(location.href).searchParams.has('launch'), launchStopped: false, launchAccepted: false, completed: false, session: 'a', view: 'chat', visible: true, processOpen: !new URL(location.href).searchParams.has('folded'), offline: false, calls: [], opened: [], qualified: 3, terminal: false }
let releaseDetail
const previews = Array.from({ length: 12 }, (_, index) => ({ ...run.results[0], imageVersionId: `preview-${index}` }))
const task = (sessionId, runId) => ({ ...run, ...(runId === 'crop' ? {} : { outputKind: 'preview' }), results: previews.map((image, index) => ({ ...image, resultCategory: index < state.qualified ? 'selected' : index === 11 ? 'review' : 'rejected' })), owner: { kind: 'session', sessionId }, runId, kind: runId === 'crop' ? 'crop' : 'search', status: runId === 'crop' || state.completed ? 'completed' : state.terminal ? 'cancelled' : 'running', taskBrief: runId === 'crop' ? '海报裁剪结果' : sessionId === 'b' ? '另一个会话的找图任务' : '按固定画像寻找图片', counts: { candidates: 12, distinct: 12 }, resultSummary: { ...run.resultSummary, candidates: 12, selected: runId === 'crop' ? 3 : state.qualified, needsReview: 1, target: 10 } })
const pendingLaunch = sessionId => ({ id: '949d1789-e443-4ba7-b3d0-9f34f7a3392e', input: { operationId: '949d1789-e443-4ba7-b3d0-9f34f7a3392e', workspaceId: 'photos', modelProfileId: 'profile', datasetId: 'profile-export-fixture', taskBrief: '寻找符合当前风格的山林与湖泊图片，保留自然光。', targetCount: 10, output: { kind: 'preview' } }, sessionId, status: state.launchStopped ? 'stopped' : state.launchAccepted ? 'accepted' : 'working', stage: state.launchStopped ? 'stopped' : state.launchAccepted ? 'accepted' : 'attaching', createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z', runIds: [], qualified: 0 })
const store = createConversationFeedback({ invoke: async (operation, args) => {
  state.calls.push([operation, args.sessionId, args.runId])
  if (state.offline) throw new Error('offline')
  if (operation === 'session-open') return { sessionToken: 'fixture', expiresAt: Date.now() + 100000, pollIntervalMs: 100 }
  if (operation === 'search-launch-stop') { state.launchStopped = true; return pendingLaunch(args.sessionId) }
  if (operation === 'conversation-runs' && state.preparing) return { sessionId: args.sessionId, tasks: [], launch: pendingLaunch(args.sessionId) }
  if (operation === 'conversation-runs') return { sessionId: args.sessionId, tasks: (args.sessionId === 'a' ? ['search', 'crop', 'search'] : ['other']).map(runId => { const row = task(args.sessionId, runId); return { runId, kind: row.kind, status: row.status, taskBrief: row.taskBrief } }) }
  const value = task(args.sessionId, args.runId), filter = args.resultFilter ?? 'all', images = value.results.filter(image => filter === 'all' || image.resultCategory === filter), offset = Number(args.pageToken ?? 0), end = offset + (args.pageSize ?? 4)
  const response = { ...value, resultFilter: filter, results: images.slice(offset, end), ...(end < images.length ? { pageToken: String(end) } : {}) }
  if (state.holdNextDetail && args.runId === 'search') {
    state.holdNextDetail = false
    return new Promise(resolve => { releaseDetail = () => resolve(response) })
  }
  return response
} })
const Dock = createConversationTaskDock(React, UI), Receipt = createTaskToolView(React, UI)
function DockFixture() {
  const source = store.sessionSource(state.session)
  return h(Dock, { sessionId: state.session, t, useFeedback: select => select(React.useSyncExternalStore(source.subscribe, source.getSnapshot)), selectTask: id => store.select(state.session, id), refreshTask: id => store.refresh(state.session, id), stopLaunch: id => store.stopLaunch(state.session, id), filterTask: (id, filter) => store.filterResults(state.session, id, filter), loadMoreTask: id => store.loadMore(state.session, id), openTask: async id => { state.opened.push([state.session, id]) } })
}
function Views() {
  return h('div', { 'data-slot': 'conversation.session' }, h('article', { className: 'fixture-chat', 'data-conversation-active-view': state.view }, h('p', null, '这是一段正常的对话回复，执行过程可以单独折叠。'), h('section', { 'data-fixture-process': '' }, h('button', { onClick: () => { state.processOpen = !state.processOpen; render() } }, '切换执行过程'), state.processOpen && h('div', null, ...['visual_search_start', 'visual_run_get', 'visual_run_get', 'visual_crop_start'].map((toolName, index) => h(Receipt, { key: index, phase: 'result', toolName, block: { isError: false, content: [{ type: 'text', text: JSON.stringify({ runId: toolName === 'visual_crop_start' ? 'crop' : 'search' }) }] }, t })))), h('section', { 'data-conversation-content': '', hidden: true }, h('div', { 'data-conversation-active-view': 'chat' }, '嵌入会话不能改变外层标签页的显示判断。')), ...Array.from({ length: 12 }, (_, index) => h('p', { key: index }, `历史对话记录 ${index + 1}：卡片保持在输入区域上方，不插入工具执行过程。`))))
}
function Conversation() {
  return h('div', { className: `${conversationCss.root} fixture-conversation`, 'data-phase': 'active' }, h(ConversationContent, {
    phase: 'active', sessionId: state.session, hero: false, variant: 'main', t: key => key,
    useSession: select => select({}), useSessions: select => select({ byId: {} }), useSessionStatus: select => select(new Map()),
    useWorkspaces: select => select({ phase: 'ready', items: [] }), useInput: select => select({ draft: '' }), useComposerBlock: select => select(undefined),
    useFactorySlot: (name, fallback) => name === 'views' ? Views : name === 'widthControls' ? ConversationWidthControls : fallback,
    renderSlot: name => name === 'conversation.body.overlay' ? h(React.Fragment, null, h(TodoPanel, { key: state.session, todos, t: todoT }), h(DockFixture)) : name === 'conversation.composer.bar' ? h('textarea', { className: 'fixture-composer', 'aria-label': '消息输入框', placeholder: '发送消息' }) : null,
    renderSlotChain: (_name, _owner, options) => options.fallback, inputActions: { prefill: async () => {} }, selectWorkspace: async () => {},
  }))
}
const root = createRoot(document.getElementById('root'))
function render() { root.render(state.visible ? h(Conversation) : h('p', null, '会话已关闭')) }
window.dockFixture = { state, feedback() { return store.sessionSource(state.session).getSnapshot() }, view(value) { state.view = value; render() }, session(id) { state.session = id; render() }, visible(value) { state.visible = value; render() }, fold() { state.processOpen = false; render() }, refresh() { store.reset() }, acceptLaunch() { state.launchAccepted = true; store.refresh(state.session) }, startSearch() { state.preparing = false; store.refresh(state.session) }, completeSearch() { state.completed = true; state.qualified = 10; store.refresh(state.session); store.refresh(state.session, 'search') }, theme(dark) { document.body.toggleAttribute('data-ds-dark-theme', dark) }, dispose() { root.unmount(); store.dispose(); for (const dispose of themeDisposers) dispose() } }
render()
if (new URL(location.href).searchParams.has('terminal-race')) {
  const controls = document.createElement('nav')
  controls.setAttribute('aria-label', '任务终态同步测试')
  controls.style.cssText = 'position:fixed;left:12px;top:8px;z-index:1000;display:flex;gap:8px'
  for (const [label, action] of [
    ['暂挂旧详情', () => { state.holdNextDetail = true; store.refresh(state.session, 'search') }],
    ['后台任务结束', () => { state.completed = true; state.qualified = 0; store.refresh(state.session) }],
    ['返回旧详情', () => releaseDetail?.()],
  ]) {
    const button = document.createElement('button')
    button.textContent = label; button.addEventListener('click', action); controls.append(button)
  }
  document.body.append(controls)
}
