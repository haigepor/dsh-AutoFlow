/** Native components; browser-only transport replies are controlled and never reach a provider. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { TodoPanel } from '../../../../../packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx'
import { ConversationContent } from '../../../../../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx'
import conversationCss from '../../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import { createConversationFeedback } from '../../src/client/conversation-feedback.ts'
import { createTaskToolView } from '../../src/client/task-tool-view.tsx'
import { createTaskHistory } from '../../src/client/task-history.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'

const h = React.createElement, t = key => zh[key], { run: hostRun, snapshot } = window.feedbackFixtureData
const style = document.createElement('style'); style.textContent = pluginCss; document.head.append(style)
let state = { mode: 'conversation', session: 'a', offline: false, calls: [], opened: [] }
const store = createConversationFeedback({ invoke: async (operation, args) => {
  state.calls.push([operation, args.sessionId])
  if (state.offline) throw new Error('offline')
  if (operation === 'session-open') return { sessionToken: 'fixture', expiresAt: Date.now() + 1000000, pollIntervalMs: 100 }
  // 本夹具只验证展示和观察生命周期；真实 Session 授权由组合测试覆盖。
  return { ...hostRun, owner: { kind: 'session', sessionId: args.sessionId } }
} })
const Task = createTaskToolView(React, UI), History = createTaskHistory(React, UI)
const todoT = (key, vars = {}) => ({ 'todo.title': '任务', 'todo.status.completed': '已完成', 'todo.status.inProgress': '进行中', 'todo.status.pending': '待处理', 'todo.progress.done': `${vars.done} 已完成`, 'todo.progress.active': `${vars.active} 进行中`, 'todo.progress.pending': `${vars.pending} 待处理` })[key] ?? key
const todos = [{ content: '读取参考包并核验固定画像与检索参数', status: 'completed' }, { content: '启动检索并等待实际像素筛选和最终复核，完整长文本应换行显示', status: 'in_progress' }, { content: '核验保存结果并报告合格数量与失败情况', status: 'pending' }]
const watchA = id => store.watch('a', id), watchB = id => store.watch('b', id)
const refreshA = id => store.refresh('a', id), refreshB = id => store.refresh('b', id)
function FixtureViews() {
  const source = store.source(state.session)
  const useFeedback = selector => selector(React.useSyncExternalStore(source.subscribe, source.getSnapshot))
  return h('div', { className: 'fixture-chat' }, h(Task, { phase: 'result', toolName: 'visual_search_start', block: { isError: false, content: [{ type: 'text', text: JSON.stringify({ runId: hostRun.runId }) }] }, t, useFeedback, watch: state.session === 'a' ? watchA : watchB, refresh: state.session === 'a' ? refreshA : refreshB, openTask: async id => state.opened.push([state.session, id]) }))
}
function Conversation() {
  return h('div', { className: `${conversationCss.root} fixture-conversation`, 'data-phase': 'active' }, h(ConversationContent, {
    phase: 'active', sessionId: state.session, hero: false, variant: 'main', t: todoT,
    useSession: select => select({}), useSessions: select => select({ byId: {} }), useSessionStatus: select => select(new Map()),
    useWorkspaces: select => select({ phase: 'ready', items: [] }), useInput: select => select({ draft: '' }), useComposerBlock: select => select(undefined),
    useFactorySlot: (name, fallback) => name === 'views' ? FixtureViews : fallback,
    renderSlot: name => name === 'conversation.body.overlay' ? h(TodoPanel, { key: state.session, todos: state.session === 'a' ? todos : [{ content: '另一个会话自己的任务', status: 'pending' }], t: todoT }) : name === 'conversation.composer.bar' ? h('div', { className: 'fixture-composer' }, '原生输入区域') : null,
    renderSlotChain: (_name, _owner, options) => options.fallback, inputActions: { prefill: async () => {} }, selectWorkspace: async () => {},
  }))
}
function Workbench() {
  const [selected, select] = React.useState({ ...hostRun, resultFilter: 'all' })
  return h('div', { className: 'vc-workbench fixture-workbench' }, h(History, { runs: [hostRun], selected, snapshot, t, loading: false, onSelect: () => {}, onReferences: () => {}, report: work => work(), actions: { openAnalysis: () => {}, execute: async () => {}, loadRun: async (_id, _append, resultFilter) => select({ ...hostRun, resultFilter }) } }))
}
const root = createRoot(document.getElementById('root'))
function render() { root.render(h(React.Fragment, null, h('div', { className: 'fixture-toolbar' }, h('button', { onClick: () => { state.mode = state.mode === 'conversation' ? 'workbench' : 'conversation'; render() } }, '切换验收视图')), state.mode === 'conversation' ? h(Conversation) : h(Workbench))) }
window.feedbackFixture = { state, setMode: mode => { state.mode = mode; render() }, session: id => { state.session = id; render() }, reset: () => store.reset(), theme: dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dispose: () => { root.unmount(); store.dispose() } }
render()
