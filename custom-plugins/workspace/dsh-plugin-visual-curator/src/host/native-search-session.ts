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
import type { SearchWorkspace } from '../shared/search-launch.ts'
import { CuratorError } from '../shared/errors.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-title'

/** Optional GUI capability; the independent headless provider never requires it. */
export interface NativeSearchSessions {
  workspaces(): SearchWorkspace[]
  preflight(workspaceId: string, signal: AbortSignal): Promise<SearchWorkspace>
  ensure(workspace: SearchWorkspace, sessionId: string, signal: AbortSignal): Promise<void>
  accepted(sessionId: string, requestId: string): Promise<boolean>
  name(sessionId: string, title: string): Promise<void>
  submit(sessionId: string, requestId: string, text: string, filename: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>
  cancel(sessionId: string): Promise<void>
}

/** @param ctx Scoped public service lookup. @returns Optional native adapter; absence is reported at launch, not plugin load. */
export function nativeSearchSessions(ctx: Pick<Context, 'get'>): NativeSearchSessions | undefined {
  const controller = ctx.get('sessionController'), registry = ctx.get('workspaceRegistry'), uploads = ctx.get('fileUploads'), tools = ctx.get('tools')
  if (!controller || !registry || !uploads || !tools) return undefined
  const workspace = (id: string) => {
    const value = registry.get(brandString<WorkspaceId>(id))
    if (!value) throw new CuratorError('reference-unavailable', 'search-launch', 'The selected Workspace is unavailable. Select an existing Workspace.')
    return value
  }
  return {
    workspaces: () => registry.list().map(item => ({ id: item.id, title: item.title, path: item.path })),
    async preflight(id, signal) {
      signal.throwIfAborted()
      if (!ctx.get('sessionTitle')) throw new CuratorError('capability-unavailable', 'search-launch', 'The native conversation naming service is unavailable in this deployment.')
      const value = workspace(id)
      await access(value.path, constants.W_OK)
      const catalog = await controller.modelCatalog()
      if (!catalog.groups.some(group => group.id === catalog.default.provider && group.models.some(model => model.id === catalog.default.model))) throw new CuratorError('configuration-required', 'search-launch', 'Select an available default conversation model in model settings.')
      if (!tools.get('visual_task_prepare') || !tools.get('visual_search_start') || !tools.get('visual_run_get')) throw new CuratorError('capability-unavailable', 'search-launch', 'Enable the Visual Curator read and search tools before starting.')
      return { id: value.id, title: value.title, path: await realpath(value.path) }
    },
    async ensure(target, id, signal) {
      const sessionId = brandString<import('@deepseek-ai/dsh-session').SessionId>(id), value = workspace(target.id)
      if (resolve(await realpath(value.path)) !== resolve(target.path)) throw new CuratorError('owner-denied', 'search-launch', 'The selected Workspace directory changed.')
      const listed = await controller.list({}, signal)
      const existing = listed.items.find(item => item.sessionId === sessionId)
      if (existing) {
        if (!existing.cwd || resolve(await realpath(existing.cwd)) !== resolve(target.path)) throw new CuratorError('owner-denied', 'search-launch', 'The saved conversation belongs to another directory.')
        // 创建后的归属写入可能单独失败；恢复只补归属，不能再调用会另建会话的 create。
        if (!value.sessionIds.includes(sessionId)) await value.attachSession(sessionId)
        return
      }
      const created = await controller.create({ workspaceId: value.id, sessionId })
      if (created.sessionId !== sessionId) throw new CuratorError('operation-conflict', 'search-launch', 'The reserved conversation identity was not created. Inspect the saved launch before retrying.')
    },
    async accepted(id, requestId) {
      const matches = (message: import('@deepseek-ai/dsh-session').UserMessage) => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === requestId
      const resolved = await controller.resolveAgent(brandString<SessionId>(id))
      if ('error' in resolved) throw resolved.error
      if (resolved.agent.session.snapshotEvents().some(event => event.type === 'user/message' && matches(event.data))) return true
      return resolved.agent.inbox.nextTurn.some(matches) || resolved.agent.inbox.nextStep.some(matches)
    },
    async name(id, title) { await controller.rename({ sessionId: brandString<SessionId>(id), title }) },
    async submit(id, requestId, text, filename, bytes, signal) {
      const sessionId = brandString<import('@deepseek-ai/dsh-session').SessionId>(id)
      const receipt = await uploads.uploadStream({ sessionId, name: filename, data: (async function* () { yield bytes })(), signal })
      await controller.prompt({ sessionId, requestId: brandString<SessionRequestId>(requestId), mode: 'queue', content: [{ type: 'text', text }, { type: 'file', receiptId: receipt.receiptId }] }, signal)
    },
    async cancel(id) {
      const sessionId = brandString<SessionId>(id)
      if ((await controller.list({}, new AbortController().signal)).items.some(item => item.sessionId === sessionId)) {
        const resolved = await controller.resolveAgent(sessionId)
        if ('error' in resolved) throw resolved.error
        controller.cancel({ sessionId })
      }
    },
  }
}
