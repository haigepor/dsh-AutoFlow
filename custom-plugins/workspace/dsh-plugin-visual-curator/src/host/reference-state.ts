/** Reuse committed observations only when their original inputs still describe this collection. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { draftSchema, referenceSchema, feedbackSchema, recipeSchema, type DomainActor, type EvaluationRecipe, type Reference } from '../shared/model.ts'
import { referenceStateSchema, reusedObservationSchema } from '../shared/reference-state.ts'
import { dataOf, specOf } from './runtime.ts'

const inputsSchema = z.object({ draft: draftSchema, references: z.array(referenceSchema), feedback: z.array(feedbackSchema), recipe: recipeSchema, analysisOutput: z.literal('observations-only') })
const checkpointSchema = z.object({ analysisDoneImageIds: z.array(z.string()).default([]), analysisResultIds: z.array(z.string()).default([]) })
const committedRequestSchema = z.object({ bundle: z.object({ requestId: z.string() }) })
type Inputs = z.infer<typeof inputsSchema>

function recipeIdentity(recipe: EvaluationRecipe) {
  const { id, createdAt, ...settings } = recipe
  return settings
}
function imageInputs(input: Inputs, imageId: string) {
  const references = input.references.filter(ref => ref.imageVersionId === imageId)
  const threads = new Set(references.flatMap(ref => ref.feedbackThreadIds))
  // 新增图片只改变草稿修订号；旧图意图、有效反馈、规则和处理配置仍必须逐项匹配。
  return { rules: input.draft.rules, recipe: recipeIdentity(input.recipe), references: references.map(ref => ({ role: ref.role, intent: ref.intent, context: ref.context })).sort((a, b) => contentDigest(a).localeCompare(contentDigest(b))), feedback: input.feedback.filter(item => threads.has(item.threadId) || (item.subject.kind === 'pair' ? [item.subject.leftImageVersionId, item.subject.rightImageVersionId].includes(imageId) : item.subject.imageVersionId === imageId)).sort((a, b) => a.id.localeCompare(b.id)) }
}

/** @param domain Authorized record owner. @param styleId Current collection. @param actor Trusted execution scope. @returns Current draft, references and applicable human judgments. */
export function referenceInputs(domain: CuratorDomain, styleId: string, actor: DomainActor) {
  const style = domain.require('style', styleId), draft = domain.require('draft', style.draftId)
  const references = draft.referenceIds.map(id => domain.require('reference', id))
  for (const reference of references) domain.authorizedImage(reference.imageVersionId, actor)
  const threads = new Set(references.flatMap(ref => ref.feedbackThreadIds))
  const feedback = domain.currentFeedback(actor).filter(item => item.scope === 'style-candidate' && item.context.styleId === style.id && (threads.has(item.threadId) || draft.feedbackIds.includes(item.id)))
  return { style, draft, references, feedback }
}

/** @param domain Authorized record owner. @param styleId Current collection. @param photoId Stable Unsplash identity shared across gallery accounts. @param actor Trusted owner. @returns Existing current-draft reference, if any. */
export function importedGalleryReference(domain: CuratorDomain, styleId: string, photoId: string, actor: DomainActor): Reference | undefined {
  const style = domain.require('style', styleId), draft = domain.require('draft', style.draftId)
  return draft.referenceIds.map(id => domain.require('reference', id)).find(ref => {
    const { asset } = domain.authorizedImage(ref.imageVersionId, actor)
    return asset.source.kind === 'provider' && asset.source.providerId === 'unsplash' && asset.source.providerAssetId === photoId
  })
}

/** @param domain Saved collection and Run records. @param styleId Current collection. @param actor Trusted execution scope. @param recipe Current analysis settings. @returns Public eligibility and frozen original-observation links; no network work is performed. */
export function planReferenceAnalysis(domain: CuratorDomain, styleId: string, actor: DomainActor, recipe: EvaluationRecipe) {
  const current = referenceInputs(domain, styleId, actor)
  const inputs: Inputs = { ...current, recipe, analysisOutput: 'observations-only' }
  const reused = new Map<string, z.infer<typeof reusedObservationSchema>>(), seen = new Set<string>()
  const runs = domain.repository.list('run').filter(run => run.owner.kind === 'session' ? run.owner.sessionId === actor.sessionId : !actor.sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const sources = runs.map(run => ({ run, spec: specOf(run) })).filter(({ spec }) => spec.kind === 'analyze' && spec.input.styleId === styleId)
  const runIds = new Set(sources.map(({ run }) => run.id)), committedRequests = new Map<string, Set<string>>()
  // 同一次预检只复制并校验一次请求表；观察仍只能使用所属任务已提交的请求。
  if (sources.length) for (const request of domain.repository.list('request')) {
    if (request.state !== 'committed' || !runIds.has(request.runId)) continue
    const saved = committedRequestSchema.safeParse(request.data)
    if (!saved.success) continue
    let requests = committedRequests.get(request.runId)
    if (!requests) committedRequests.set(request.runId, requests = new Set())
    requests.add(saved.data.bundle.requestId)
  }
  for (const { run, spec } of sources) {
    const source = inputsSchema.safeParse(spec.fixed)
    const checkpoint = checkpointSchema.parse(dataOf(run).checkpoint)
    const requests = committedRequests.get(run.id)
    for (const observationId of checkpoint.analysisResultIds) {
      const observation = domain.repository.get('observation', observationId)
      if (!observation || !checkpoint.analysisDoneImageIds.includes(observation.imageVersionId)) continue
      const imageId = observation.imageVersionId
      if (!current.references.some(ref => ref.imageVersionId === imageId)) continue
      seen.add(imageId)
      if (!source.success || spec.input.buildDataset !== true || reused.has(imageId) || contentDigest(imageInputs(source.data, imageId)) !== contentDigest(imageInputs(inputs, imageId))) continue
      // 旧 Run 复用的观察仍指向原请求；输出及其图片必须已经持久化，不能复用在途响应。
      if (!observation.inferred.length || !observation.inferred.every(field => requests?.has(field.requestId))) continue
      reused.set(imageId, { runId: run.id, observationId: observation.id, imageVersionId: domain.require('imageVersion', imageId).id })
    }
  }
  const imageIds = [...new Set(current.references.map(ref => ref.imageVersionId))]
  const entries = current.references.map(ref => {
    const { asset, image } = domain.authorizedImage(ref.imageVersionId, actor)
    return { referenceId: ref.id, imageVersionId: image.id, state: reused.has(image.id) ? 'analyzed' as const : seen.has(image.id) ? 'needs-update' as const : 'pending' as const, ...(asset.source.kind === 'provider' ? { providerId: asset.source.providerId, photoId: asset.source.providerAssetId } : {}) }
  })
  const links = [...reused.values()].sort((a, b) => a.imageVersionId.localeCompare(b.imageVersionId))
  const digest = contentDigest({ styleId, revision: current.style.revision, draft: current.draft, recipe: recipeIdentity(recipe), feedback: current.feedback, links })
  return { ...current, reused: links, view: referenceStateSchema.parse({ styleId, revision: current.style.revision, digest, total: imageIds.length, reusable: reused.size, pending: imageIds.length - reused.size, changed: imageIds.filter(id => seen.has(id) && !reused.has(id)).length, entries }) }
}

/** @param domain Persisted source records. @param value Frozen analysis inputs. @param links Observation links admitted by the Host. @param actor Trusted Run scope. @returns Whether each link still matches committed source inputs in the same collection and owner. */
export function validObservationReuse(domain: CuratorDomain, value: unknown, links: z.infer<typeof reusedObservationSchema>[], actor: DomainActor): boolean {
  const current = inputsSchema.parse(value)
  return new Set(links.map(link => link.imageVersionId)).size === links.length && links.every(link => {
    const run = domain.require('run', link.runId), spec = specOf(run), observation = domain.require('observation', link.observationId)
    if (run.owner.kind === 'session' ? run.owner.sessionId !== actor.sessionId : !!actor.sessionId) return false
    if (spec.kind !== 'analyze' || spec.input.styleId !== current.draft.styleId || spec.input.buildDataset !== true || observation.imageVersionId !== link.imageVersionId) return false
    const checkpoint = checkpointSchema.parse(dataOf(run).checkpoint)
    return checkpoint.analysisResultIds.includes(link.observationId) && checkpoint.analysisDoneImageIds.includes(link.imageVersionId)
      && current.references.some(ref => ref.imageVersionId === link.imageVersionId)
      && contentDigest(imageInputs(inputsSchema.parse(spec.fixed), link.imageVersionId)) === contentDigest(imageInputs(current, link.imageVersionId))
  })
}
