/** Logged image calls own a disclosure at their dispatch position in the Chat process. */
import type { ConversationMatch, ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { z } from 'zod'
import type { ImageViewTask } from '../shared/image-view.ts'
import { imageTaskActive, recordedImageTask } from './model.ts'

/** A UI projection of one logged generate call, never a synthetic Session result. */
export interface ConversationImageData { callId: string; settled: boolean; failed: boolean; live?: boolean; saved?: ImageViewTask | undefined }

interface ImageTurnState { tasks: ReadonlyMap<string, ImageViewTask> }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap { 'codex-image-turn': ImageTurnState }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'codex-image': ConversationImageData }
}

const operation = z.object({ codexImage: z.object({ operation: z.literal('generate') }) })

function updateTurn(previous: ImageTurnState | undefined, match: ConversationMatch): ImageTurnState {
  const { event } = match
  const state = previous ?? { tasks: new Map<string, ImageViewTask>() }
  // Refresh dependent cards when the Turn closes even if no further tool result was recorded.
  if (event.type === 'turn/end') return { ...state }
  const saved = event.type === 'tool/result' && isAppendSurfaceEvent(event)
    ? recordedImageTask(event.data.meta, event.data.message.content, event.time) : undefined
  if (!saved) return state
  const old = state.tasks.get(saved.taskId)
  if (old && !imageTaskActive(old) && imageTaskActive(saved)) return state
  return { tasks: new Map(state.tasks).set(saved.taskId, saved) }
}

/** Share durable results with their generation calls in the same Turn. */
export const imageTurnDefinition: ConversationNodeDefinition<ImageTurnState> = {
  kind: 'codex-image-turn',
  match(event) {
    switch (event.type) {
      case 'turn/start': case 'turn/end': case 'tool/result':
        return { id: String(event.data.turn), role: 'start' }
      default: return null
    }
  },
  start: (_context, match) => updateTurn(undefined, match),
  update: (context, match) => updateTurn(context.state, match),
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
  // Stay with the dispatch instead of following later reasoning, polls or the final reply.
  const anchorSeq = (context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0) + .05
  const live = turn?.status === 'open'
  const current = context.current.get('chat') as ChatNode<'codex-image'> | null | undefined
  const data = current?.data.callId === state.callId && current.data.settled === state.settled && current.data.failed === state.failed
    && current.data.saved === saved && current.data.live === live ? current.data : { ...state, saved, live }
  if (current?.data === data && current.anchorSeq === anchorSeq && current.location === location) return current
  return { key: context.key, id: context.id, target: 'chat', kind: 'codex-image', anchorSeq, location, visibility: 'visible', data }
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
    // Later recorded polls can refresh the card without changing its position.
    reader.previous<ImageTurnState>('codex-image-turn')
    return project(match)
  },
  update: (context, match) => project(match, context.state),
  buildViewNode: node,
}
