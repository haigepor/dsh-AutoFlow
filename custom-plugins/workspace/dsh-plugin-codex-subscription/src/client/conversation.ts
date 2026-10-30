/** Logged image calls receive an independent Chat node outside process folding. */
import type { ConversationMatch, ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-tools/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { z } from 'zod'
import type { ImageViewTask } from '../shared/image-view.ts'
import { imageTaskActive, recordedImageTask } from './model.ts'

/** A UI projection of one logged generate call, never a synthetic Session result. */
export interface ConversationImageData { callId: string; settled: boolean; failed: boolean; live?: boolean; saved?: ImageViewTask | undefined }

interface ImageTurnState { lastSeq: number; tasks: ReadonlyMap<string, ImageViewTask> }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap { 'codex-image-turn': ImageTurnState }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'codex-image': ConversationImageData }
}

const operation = z.object({ codexImage: z.object({ operation: z.literal('generate') }) })

function updateTurn(previous: ImageTurnState | undefined, match: ConversationMatch): ImageTurnState {
  const { event } = match
  const saved = event.type === 'tool/result' && isAppendSurfaceEvent(event)
    ? recordedImageTask(event.data.meta, event.data.message.content, event.time) : undefined
  let tasks = previous?.tasks ?? new Map<string, ImageViewTask>()
  const old = saved && tasks.get(saved.taskId)
  // 历史生成调用可能只记录 sent；后续查询的完成结果优先，不能被旧的进行中快照覆盖。
  if (saved && (!old || imageTaskActive(old) || !imageTaskActive(saved))) tasks = new Map(tasks).set(saved.taskId, saved)
  return { lastSeq: event.seq, tasks }
}

/** Share durable result-query facts and current process ordering within one Turn. */
export const imageTurnDefinition: ConversationNodeDefinition<ImageTurnState> = {
  kind: 'codex-image-turn',
  match(event) {
    switch (event.type) {
      case 'turn/start': case 'turn/end': case 'step/start': case 'step/end':
      case 'tool/call': case 'tool/result': case 'assistant/message': case 'assistant/live-chunk':
        return { id: String(event.data.turn), role: 'start' }
      // Other extensible Session events do not change image presentation ordering.
      default: return null
    }
  },
  start: (_context, match) => updateTurn(undefined, match),
  update: (context, match) => updateTurn(context.state, match),
  publication: match => match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate',
  buildLocationData(context, scope, previous) {
    if (scope !== 'turn' || !context.state) return null
    const location = context.start?.location ?? context.matches[0]?.location
    if (location?.kind !== 'turn' && location?.kind !== 'step') return null
    if (previous?.kind === 'turn' && previous.key === 'codex-image-turn' && previous.value === context.state) return previous
    return { kind: 'turn', turn: location.turn.turn, key: 'codex-image-turn', value: context.state }
  },
}

function project(match: ConversationMatch, previous?: ConversationImageData): ConversationImageData | undefined {
  const { event } = match
  if (event.type === 'tool/call') return { callId: String(event.data.callId), settled: false, failed: false }
  if (event.type === 'tool/ptc-dispatch-start') return { callId: String(event.data.subCallId), settled: false, failed: false }
  if (event.type === 'tool/ptc-dispatch') return { callId: String(event.data.subCallId), settled: true, failed: event.data.isError === true,
    saved: recordedImageTask(event.data.meta, event.data.content ?? [], event.time) }
  if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event) || !previous && !operation.safeParse(event.data.meta).success) return previous
  return { callId: String(event.data.message.source.callId), settled: true, failed: event.data.message.isError === true,
    saved: recordedImageTask(event.data.meta, event.data.message.content, event.time) }
}

function node(context: ConversationNodeContext<ConversationImageData | undefined>): ChatNode<'codex-image'> | null {
  const state = context.state
  if (!state) return null
  const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' as const }
  const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn : undefined
  const activity = turn?.data.get('codex-image-turn')
  const saved = (state.saved && activity?.tasks.get(state.saved.taskId)) ?? state.saved
  const answer = turn?.data.get('turn-process')?.answerAnchorSeq
  // 图片留在正文；工具、查询与真实思考均排在它之前，不拆出图片下方的第二段工具过程。
  const anchorSeq = answer != null ? answer - .05 : (activity?.lastSeq ?? context.matches.at(-1)?.event.seq ?? 0) + .05
  const live = turn?.status === 'open'
  const current = context.current.get('chat') as ChatNode<'codex-image'> | null | undefined
  const data = current?.data.callId === state.callId && current.data.settled === state.settled && current.data.failed === state.failed
    && current.data.saved === saved && current.data.live === live ? current.data : { ...state, saved, live }
  if (current?.data === data && current.anchorSeq === anchorSeq && current.location === location) return current
  return { key: context.key, id: context.id, target: 'chat', kind: 'codex-image', anchorSeq, location, visibility: 'visible', groupTree: 'turn', data }
}

/** Project only native generation calls; result polls remain in the ordinary process history. */
export const imageConversationDefinition: ConversationNodeDefinition<ConversationImageData | undefined> = {
  kind: 'codex-image', target: 'chat',
  match(event) {
    if (event.type === 'tool/call') return event.data.name === 'codex_image_generate' ? { id: String(event.data.callId), role: 'start' } : null
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') return event.data.name === 'codex_image_generate' ? { id: String(event.data.subCallId), role: 'start' } : null
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) return { id: String(event.data.message.source.callId), role: operation.safeParse(event.data.meta).success ? 'start' : 'update' }
    return null
  },
  start: (_context, match, reader) => {
    // Location 数据不会自动重建其他节点；登记同轮前序依赖，后续思考与查询才能及时更新图片位置。
    reader.previous<ImageTurnState>('codex-image-turn')
    return project(match)
  },
  update: (context, match) => project(match, context.state),
  buildViewNode: node,
}
