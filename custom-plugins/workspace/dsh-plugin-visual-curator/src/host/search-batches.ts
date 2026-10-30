/** Collection-scoped history reads use the authenticated human's existing Session authority. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { styleSchema, runSchema, type DomainActor, type RunRecord, type RecordOf } from '../shared/model.ts'
import type { SearchBatchPage } from '../shared/search-batches.ts'
import { CuratorError } from '../shared/errors.ts'
import { specOf } from './runtime.ts'
import { hiddenTaskIds, deleteTaskHistory } from './task-history.ts'
import { rankedRunSelections } from './projection.ts'

/** @param domain Owning profile records. @param actor Authenticated human. @param args Collection, terminal batch and idempotent deletion identity. @returns Existing history-hiding receipt without reading or granting Session images. */
export async function deleteSearchBatch(domain: CuratorDomain, actor: DomainActor, args: unknown) {
  if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'search-batches-delete', 'Batch deletion requires the authenticated workbench owner.')
  domain.repository.assertProfile(actor.profileId)
  const input = z.strictObject({ styleId: styleSchema.shape.id, runId: runSchema.shape.id, operationId: z.string().min(1) }).parse(args)
  domain.require('style', input.styleId)
  const run = domain.require('run', input.runId), spec = specOf(run)
  const standard = z.object({ styleId: z.string() }).safeParse(spec.fixed.release)
  // 只授权当前素材集的历史隐藏；会话不存在时也不读取结果或创建新的资源授权。
  if (run.profileId !== actor.profileId || !['search', 'crop'].includes(spec.kind) || !standard.success || standard.data.styleId !== input.styleId) throw new CuratorError('owner-denied', 'search-batches-delete', 'This batch is unavailable in the selected collection.')
  return await deleteTaskHistory(domain.repository, run, input.operationId)
}

const inputSchema = z.strictObject({ styleId: styleSchema.shape.id, batchId: runSchema.shape.id.optional(), pageToken: z.string().optional() })
const cursorSchema = z.strictObject({ scope: z.string(), id: z.string() })
function offset(token: string | undefined, scope: string, ids: string[]): number {
  if (!token) return 0
  const cursor = cursorSchema.safeParse((() => { try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) } catch (error) { /* 无效游标统一返回可恢复的分页错误。 */ return null } })())
  const index = cursor.success ? ids.indexOf(cursor.data.id) : -1
  if (!cursor.success || cursor.data.scope !== scope || index < 0) throw new CuratorError('invalid-input', 'search-batches-page', 'Refresh the batch list before continuing.')
  return index + 1
}
const continuation = (scope: string, id: string) => Buffer.from(JSON.stringify({ scope, id }), 'utf8').toString('base64url')

/** The service supplies existing Session authority without changing the workbench's selected Session. */
export interface SearchBatchReader { actor: DomainActor; sessionToken?: string }

/** @param domain Saved profile records. @param actor Authenticated human. @param args Collection and optional batch/cursor. @param pageSize Configured batch and image page bound. @param read Authorized reader and resource grant, or absent when the Session is unavailable. @returns Matching images grouped by their own Run, projecting only current-page metadata and preview links. */
export function readSearchBatches(domain: CuratorDomain, actor: DomainActor, args: unknown, pageSize: number, read: (run: RunRecord) => SearchBatchReader | undefined): SearchBatchPage {
  if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'search-batches', 'Batch browsing requires the authenticated workbench owner.')
  domain.repository.assertProfile(actor.profileId)
  const input = inputSchema.parse(args)
  domain.require('style', input.styleId)
  return domain.repository.readSnapshot(() => {
    const hidden = hiddenTaskIds(domain.repository)
    const runs = domain.repository.list('run').filter(run => {
      if (run.profileId !== actor.profileId || hidden.has(run.id)) return false
      const spec = specOf(run)
      if (spec.kind !== 'search' && spec.kind !== 'crop') return false
      const standard = z.object({ styleId: z.string() }).safeParse(spec.fixed.release)
      return standard.success && standard.data.styleId === input.styleId
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const matches = new Map<string, Set<string>>(), selections = new Map<string, RecordOf<'selection'>[]>()
    for (const selection of domain.repository.list('selection')) {
      const rows = selections.get(selection.runId) ?? []; rows.push(selection); selections.set(selection.runId, rows)
      if (selection.qualification === 'auto-qualified') {
        const ids = matches.get(selection.runId) ?? new Set<string>(); ids.add(selection.imageVersionId); matches.set(selection.runId, ids)
      }
    }
    const selected = input.batchId ? runs.filter(run => run.id === input.batchId) : runs
    if (input.batchId && !selected.length) throw new CuratorError('owner-denied', 'search-batches', 'This batch is unavailable in the selected collection.')
    const scope = JSON.stringify([actor.profileId, input.styleId, input.batchId ?? null])
    const start = input.batchId ? 0 : offset(input.pageToken, scope, selected.map(run => run.id)), page = selected.slice(start, start + pageSize)
    const batches = page.map(run => {
      const reader = read(run), spec = specOf(run)
      const order = reader ? rankedRunSelections(run, selections.get(run.id) ?? [], id => domain.repository.get('assessment', id)) : []
      const images = [...new Set(order.map(item => item.id))].flatMap(id => {
        try { return [domain.authorizedImage(id, reader!.actor)] }
        catch (error) { if (error instanceof CuratorError && error.code === 'owner-denied') return []; throw error }
      })
      const imageScope = `${scope}:images:${run.id}`, imageStart = input.batchId ? offset(input.pageToken, imageScope, images.map(({ image }) => image.id)) : 0
      const visible = images.slice(imageStart, imageStart + pageSize)
      return { runId: run.id, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}), kind: spec.kind === 'crop' ? 'crop' as const : 'search' as const, status: run.status, createdAt: run.createdAt, taskBrief: typeof spec.input.taskBrief === 'string' ? spec.input.taskBrief : '', matched: matches.get(run.id)?.size ?? 0, unavailable: !reader,
        images: visible.map(({ image, asset }) => {
          const previewPath = `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: image.id, ...(reader?.sessionToken ? { sessionToken: reader.sessionToken } : {}) })}`
          return { imageVersionId: image.id, name: asset.source.description || asset.id, width: image.geometry.width, height: image.geometry.height, previewPath,
            ...(image.blob.remoteSource ? { thumbnailPath: `${previewPath}&preview=thumbnail` } : {}) }
        }),
        ...(imageStart + pageSize < images.length ? { nextImagePageToken: continuation(imageScope, visible.at(-1)!.image.id) } : {}) }
    })
    return { styleId: input.styleId, totalBatches: selected.length, totalMatches: selected.reduce((total, run) => total + (matches.get(run.id)?.size ?? 0), 0), batches,
      ...(!input.batchId && start + pageSize < selected.length ? { nextPageToken: continuation(scope, page.at(-1)!.id) } : {}) }
  })
}
