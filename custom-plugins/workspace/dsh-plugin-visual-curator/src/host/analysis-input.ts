/** Read-only projections of saved vision requests; callers authorize the owning run first. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import type { DomainActor, RecordOf, RunRecord } from '../shared/model.ts'
import type { AnalysisInput, AnalysisRequest } from '../shared/analysis-process.ts'
import { CuratorError } from '../shared/errors.ts'
import { nativeCallFactsSchema } from '../shared/analysis-process.ts'
import { dataOf } from './runtime.ts'

const descriptorSchema = z.object({ operation: z.enum(['analyze', 'summarize']), model: z.string(), instructions: z.string(), inputText: z.string(), images: z.array(z.object({ imageVersionId: z.string(), digest: z.string(), mime: z.string(), role: z.string(), remoteUrl: z.string().optional() })) })
function descriptor(request: RecordOf<'request'>) {
  const data = request.data
  // 旧恢复逻辑只改请求状态，仍保留预留时的直接描述；完整校验后继续提供原输入。
  if (request.state === 'outcome-unknown') {
    const interrupted = descriptorSchema.safeParse(data)
    if (interrupted.success) return interrupted
  }
  return descriptorSchema.safeParse(request.state === 'reserved' ? data : data && typeof data === 'object' && !Array.isArray(data) ? data.bundle : undefined)
}

/** @param domain Saved records. @param run Authorized analysis. @returns Attempt identities without prompt text. */
export function analysisRequests(domain: CuratorDomain, run: RunRecord): AnalysisRequest[] {
  return dataOf(run).requestIds.flatMap(id => {
    const request = domain.repository.get('request', id)
    if (!request || request.runId !== run.id) return []
    const parsed = descriptor(request)
    const native = nativeCallFactsSchema.safeParse(request.data && typeof request.data === 'object' && !Array.isArray(request.data) ? request.data.metadata : undefined)
    return [{ requestId: request.id, createdAt: request.createdAt, state: request.state, operation: parsed.success ? parsed.data.operation : null, model: parsed.success ? parsed.data.model : null, imageIds: parsed.success ? parsed.data.images.map(image => image.imageVersionId) : [], available: parsed.success, ...(native.success ? { native: native.data } : {}) }]
  })
}

/** @param domain Saved records and authorized media. @param run Authorized analysis. @param requestId Actual attempt record. @param actor Authenticated reader. @returns Original safe text and ordered image references. */
export function readAnalysisInput(domain: CuratorDomain, run: RunRecord, requestId: string, actor: DomainActor): AnalysisInput {
  const request = domain.repository.get('request', requestId)
  if (!dataOf(run).requestIds.includes(requestId) || !request || request.runId !== run.id) throw new CuratorError('reference-unavailable', 'analysis-input', 'The saved request is unavailable for this task.')
  const parsed = descriptor(request)
  if (!parsed.success) throw new CuratorError('reference-unavailable', 'analysis-input', 'This historical request has no saved input.')
  const saved = parsed.data
  return { requestId: request.id, instructions: saved.instructions, inputText: saved.inputText, images: saved.images.map(item => {
    const { image, asset } = domain.authorizedImage(item.imageVersionId, actor)
    if (image.blob.digest !== item.digest) throw new CuratorError('reference-unavailable', 'analysis-input', 'The saved image identity no longer matches this request.')
    const previewPath = `/api/visual-curator/resource?imageVersionId=${encodeURIComponent(item.imageVersionId)}`
    return { imageVersionId: item.imageVersionId, name: asset.source.description || item.imageVersionId, digest: item.digest, mime: item.mime, role: item.role, previewPath, ...(image.blob.remoteSource ? { thumbnailPath: `${previewPath}&preview=thumbnail` } : {}), sourceKind: item.remoteUrl ? 'remote' as const : 'local' as const }
  }) }
}
