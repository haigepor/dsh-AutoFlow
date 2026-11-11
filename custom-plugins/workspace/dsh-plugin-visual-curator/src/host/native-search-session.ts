/** Public native services own conversation identity, attachment admission and execution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import type { SearchWorkspace, SearchConversationModel, SearchConversationModelOption } from '../shared/search-launch.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { CuratorError } from '../shared/errors.ts'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionTaskSnapshot, SessionTaskPublisher } from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import type { RunData } from './runtime.ts'
import type {} from '@deepseek-ai/dsh-session-title'

/** Optional GUI capability; the independent headless provider never requires it. */
export interface NativeSearchSessions {
  workspaces(): SearchWorkspace[]
  /** @returns Native catalog choices and the currently available default. */
  models(): Promise<{ conversationModels: SearchConversationModelOption[]; defaultConversationModel?: SearchConversationModel }>
  /** @param workspaceId Selected native Workspace. @param signal Preparation lifetime. @param model Explicit conversation route, or the existing default when absent. @param mode Workflow execution uses the saved vision route; absent retains conversation admission. @returns Writable Workspace after required capability validation. */
  preflight(workspaceId: string, signal: AbortSignal, model?: SearchConversationModel, mode?: 'workflow' | 'conversation'): Promise<SearchWorkspace>
  ensure(workspace: SearchWorkspace, sessionId: string, signal: AbortSignal): Promise<void>
  /** @param sessionId Existing native Session. @param requestId Frozen prompt identity. @returns Whether the prompt is logged, pending, or claimed by its still-running turn. */
  accepted(sessionId: string, requestId: string): Promise<boolean>
  /** @param sessionId Owning Session. @param requestId Frozen prompt identity. @returns Its settled conversation failure, or absence for unloaded, running or successful conversations; never activates a Session. */
  failure(sessionId: string, requestId: string): RunData['error']
  /** @param sessionId Newly admitted native Session. @param model Frozen catalog route. @param signal Launch lifetime. @returns After recording this Session's route without saving a profile default. */
  selectModel(sessionId: string, model: SearchConversationModel, signal: AbortSignal): Promise<void>
  name(sessionId: string, title: string): Promise<void>
  submit(sessionId: string, requestId: string, text: string, filename: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>
  cancel(sessionId: string): Promise<void>
  /** @param sessionId Owning Session. @param snapshot Display-only checkpoint. @returns Durable acknowledgement; absent on an older Host. */
  present?(sessionId: string, snapshot: SessionTaskSnapshot): Promise<void>
}

/** @param ctx Scoped public service lookup. @returns Optional native adapter; absence is reported at launch, not plugin load. */
export function nativeSearchSessions(ctx: Pick<Context, 'get'>): NativeSearchSessions | undefined {
  const controller = ctx.get('sessionController'), registry = ctx.get('workspaceRegistry'), uploads = ctx.get('fileUploads'), tools = ctx.get('tools'), agents = ctx.get('agents')
  if (!controller || !registry || !uploads || !tools || !agents) return undefined
  const supportsPresentation = (value: object): value is SessionTaskPublisher => 'recordTask' in value && typeof value.recordTask === 'function'
  const publisher = supportsPresentation(controller) ? controller : undefined
  const workspace = (id: string) => {
    const value = registry.get(brandString<WorkspaceId>(id))
    if (!value) throw new CuratorError('reference-unavailable', 'search-launch', 'The selected Workspace is unavailable. Select an existing Workspace.')
    return value
  }
  const resolveModel = async (selection: SearchConversationModel) => {
    const catalog = await controller.modelCatalog(), model = catalog.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)
    if (!model || selection.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new CuratorError('configuration-required', 'search-launch-model', 'The selected conversation model or reasoning effort is unavailable. Refresh the model list and select an available route.')
    const llm = ctx.get('llm')
    if (!llm) throw new CuratorError('capability-unavailable', 'search-launch-model', 'The conversation model service is unavailable.')
    const selected = { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) } : {}) }
    await llm.resolveCallConfig(selected)
    return selected
  }
  return {
    workspaces: () => registry.list().map(item => ({ id: item.id, title: item.title, path: item.path })),
    async models() {
      const catalog = await controller.modelCatalog()
      const conversationModels = catalog.groups.flatMap(group => group.models.map(model => {
        const reasoningEffort = group.id === catalog.default.provider && model.id === catalog.default.model ? catalog.default.reasoningEffort : model.reasoning?.defaultEffort
        return { provider: group.id, model: model.id, label: `${group.name} / ${model.name}`, ...(reasoningEffort ? { reasoningEffort } : {}) }
      }))
      return { conversationModels, ...(conversationModels.some(model => model.provider === catalog.default.provider && model.model === catalog.default.model) ? { defaultConversationModel: { ...catalog.default } } : {}) }
    },
    async preflight(id, signal, selection, mode) {
      signal.throwIfAborted()
      if (!ctx.get('sessionTitle')) throw new CuratorError('capability-unavailable', 'search-launch', 'The native conversation naming service is unavailable in this deployment.')
      const value = workspace(id)
      await access(value.path, constants.W_OK)
      if (mode === 'workflow') {
        if (!publisher) throw new CuratorError('capability-unavailable', 'task-presentation', 'This workflow requires a Host with durable task presentation. Open the updated local desktop preview before starting.')
        return { id: value.id, title: value.title, path: await realpath(value.path) }
      }
      if (selection) await resolveModel(selection)
      else {
        const catalog = await controller.modelCatalog()
        if (!catalog.groups.some(group => group.id === catalog.default.provider && group.models.some(model => model.id === catalog.default.model))) throw new CuratorError('configuration-required', 'search-launch', 'Select an available default conversation model in model settings.')
      }
      if (!tools.get('visual_task_prepare') || !tools.get('visual_search_start') || !tools.get('visual_run_get')) throw new CuratorError('capability-unavailable', 'search-launch', 'Enable the Visual Curator read and search tools before starting.')
      return { id: value.id, title: value.title, path: await realpath(value.path) }
    },
    async ensure(target, id, signal) {
      signal.throwIfAborted()
      const sessionId = brandString<import('@deepseek-ai/dsh-session').SessionId>(id), value = workspace(target.id)
      if (resolve(await realpath(value.path)) !== resolve(target.path)) throw new CuratorError('owner-denied', 'search-launch', 'The selected Workspace directory changed.')
      const listed = await controller.list({}, signal)
      signal.throwIfAborted()
      const existing = listed.items.find(item => item.sessionId === sessionId)
      if (existing) {
        if (!existing.cwd || resolve(await realpath(existing.cwd)) !== resolve(target.path)) throw new CuratorError('owner-denied', 'search-launch', 'The saved conversation belongs to another directory.')
        // 创建后的归属写入可能单独失败；恢复只补归属，不能再调用会另建会话的 create。
        if (!value.sessionIds.includes(sessionId)) await value.attachSession(sessionId)
        signal.throwIfAborted()
        return
      }
      signal.throwIfAborted()
      const created = await controller.create({ workspaceId: value.id, sessionId })
      if (created.sessionId !== sessionId) throw new CuratorError('operation-conflict', 'search-launch', 'The reserved conversation identity was not created. Inspect the saved launch before retrying.')
      signal.throwIfAborted()
    },
    async accepted(id, requestId) {
      const matches = (message: UserMessage) => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === requestId
      const resolved = await controller.resolveAgent(brandString<SessionId>(id))
      if ('error' in resolved) throw resolved.error
      const agent = resolved.agent
      if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true
      const pending: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
      let activeTurn = false, claimed = false
      // Claiming removes input from pending before request preparation logs user/message.
      for (const event of agent.session.snapshotEvents()) {
        switch (event.type) {
          case 'user/message': if (matches(event.data)) return true; break
          case 'turn/start': activeTurn = true; claimed = false; break
          case 'turn/end': activeTurn = false; claimed = false; break
          case 'agent/inbox/spliced': {
            const splice = event.data, removed = pending[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
            if (activeTurn && splice.outcome !== 'canceled' && removed.some(matches)) claimed = true
            break
          }
          // Other event extensions do not mutate the native inbox or its turn lifetime.
          default: break
        }
      }
      return agent.status === 'running' && activeTurn && claimed
    },
    failure(id, requestId) {
      const agent = agents.get(brandString<SessionId>(id))
      if (!agent || agent.status === 'running') return undefined
      let entered = false, failed = false
      for (const event of agent.session.snapshotEvents()) {
        if (event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === requestId) { entered = true; failed = false }
        else if (entered && event.type === 'turn/start') failed = false
        else if (entered && event.type === 'turn/end') failed = event.data.reason.kind === 'error'
      }
      return failed ? { code: 'remote-request-failed', stage: 'search-launch-conversation', retryable: true,
        safeMessage: 'The conversation failed before starting image search. Its saved data and task requirements remain available.',
        suggestedAction: 'Open the conversation to inspect the model error, then retry there or stop this task.' } : undefined
    },
    async selectModel(id, selection, signal) {
      signal.throwIfAborted()
      const selected = await resolveModel(selection)
      signal.throwIfAborted()
      const resolved = await controller.resolveAgent(brandString<SessionId>(id))
      if ('error' in resolved) throw resolved.error
      resolved.agent.model.select(selected)
    },
    async name(id, title) { await controller.rename({ sessionId: brandString<SessionId>(id), title }) },
    async submit(id, requestId, text, filename, bytes, signal) {
      const sessionId = brandString<import('@deepseek-ai/dsh-session').SessionId>(id)
      const receipt = await uploads.uploadStream({ sessionId, name: filename, data: (async function* () { yield bytes })(), signal })
      await controller.prompt({ sessionId, requestId: brandString<SessionRequestId>(requestId), mode: 'queue', content: [{ type: 'text', text }, { type: 'file', receiptId: receipt.receiptId }] }, signal)
    },
    async cancel(id) {
      const sessionId = brandString<SessionId>(id)
      // A cold Session has no native turn to cancel; stopping must not activate it.
      if (agents.get(sessionId)) controller.cancel({ sessionId })
    },
    ...(publisher ? { async present(id: string, snapshot: SessionTaskSnapshot) {
      try { await publisher.recordTask(brandString<SessionId>(id), snapshot) }
      catch (cause) {
        const failure = z.object({ code: z.literal('session/task-checkpoint-failed'), details: z.object({ reason: z.string() }) }).safeParse(cause)
        if (!failure.success) throw cause
        const reason = failure.data.details.reason
        throw new CuratorError(reason === 'persistence-unconfirmed' ? 'storage-commit-failed' : reason === 'revision-conflict' ? 'operation-conflict' : 'capability-unavailable', 'task-presentation', `Conversation checkpoint was not confirmed (${reason}). Execution checkpoints remain saved.`, { cause, retryable: reason === 'persistence-unconfirmed' || reason === 'closing', suggestedAction: 'Retry display synchronization; do not create another task to restore its display.' })
      }
    } } : {}),
  }
}
