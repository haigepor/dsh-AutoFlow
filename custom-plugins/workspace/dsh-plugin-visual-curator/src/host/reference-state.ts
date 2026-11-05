/** Reuse committed observations only when their original inputs still describe this collection. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { draftSchema, referenceSchema, feedbackSchema, recipeSchema, type DomainActor, type EvaluationRecipe, type Reference, type RunRecord } from '../shared/model.ts'
import { referenceStateSchema, reusedObservationSchema } from '../shared/reference-state.ts'
import { dataOf, specOf } from './runtime.ts'
import { referenceFeedbackRole } from '../shared/reference-semantics.ts'

const inputsSchema = z.object({ draft: draftSchema, references: z.array(referenceSchema), feedback: z.array(feedbackSchema), recipe: recipeSchema, analysisOutput: z.literal('observations-only') })
const checkpointSchema = z.object({ analysisDoneImageIds: z.array(z.string()).default([]), analysisResultIds: z.array(z.string()).default([]) })
const committedRequestSchema = z.object({ bundle: z.object({ requestId: z.string() }) })
type Inputs = z.infer<typeof inputsSchema>

function recipeIdentity(recipe: EvaluationRecipe) {
  const { id, createdAt, ...settings } = recipe
  return settings
}
function imageInputDigests(input: Inputs) {
  const references = new Map<string, Reference[]>(), threadImages = new Map<string, Set<string>>(), feedback = new Map<string, Inputs['feedback']>(), digests = new Map<string, string>()
  for (const reference of input.references) {
    const rows = references.get(reference.imageVersionId) ?? []; rows.push(reference); references.set(reference.imageVersionId, rows)
    for (const threadId of reference.feedbackThreadIds) { const images = threadImages.get(threadId) ?? new Set<string>(); images.add(reference.imageVersionId); threadImages.set(threadId, images) }
  }
  for (const item of input.feedback) {
    const imageIds = new Set([...(threadImages.get(item.threadId) ?? []), ...(item.subject.kind === 'pair' ? [item.subject.leftImageVersionId, item.subject.rightImageVersionId] : [item.subject.imageVersionId])])
    for (const imageId of imageIds) { const rows = feedback.get(imageId) ?? []; rows.push(item); feedback.set(imageId, rows) }
  }
  // 已保存的观察可跨模型复用；原始模型与请求仍由来源 Run 保留，不能改写为新模型的输出。
  const { id, createdAt, model, vendorVersion, visionRevision, ...processing } = input.recipe
  const policy = contentDigest({ rules: input.draft.rules, recipe: processing })
  return (imageId: string) => {
    let digest = digests.get(imageId)
    if (!digest) {
      const rows = (references.get(imageId) ?? []).map(ref => { const value = { role: ref.role, intent: ref.intent, context: ref.context }; return { value, digest: contentDigest(value) } }).sort((a, b) => a.digest.localeCompare(b.digest))
      digest = contentDigest({ policy, references: rows.map(row => row.value), feedback: [...feedback.get(imageId) ?? []].sort((a, b) => a.id.localeCompare(b.id)) }); digests.set(imageId, digest)
    }
    return digest
  }
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
  const imageIds = [...new Set(current.references.map(ref => ref.imageVersionId))], wanted = new Set(imageIds), currentDigest = imageInputDigests(inputs)
  const reused = new Map<string, z.infer<typeof reusedObservationSchema>>(), seen = new Set<string>()
  const runs = domain.repository.list('run').filter(run => run.owner.kind === 'session' ? run.owner.sessionId === actor.sessionId : !actor.sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const sources = runs.map(run => ({ run, spec: specOf(run) })).filter(({ spec }) => spec.kind === 'analyze' && spec.input.styleId === styleId)
  for (const { run, spec } of sources) {
    const data = dataOf(run), checkpoint = checkpointSchema.parse(data.checkpoint), done = new Set(checkpoint.analysisDoneImageIds)
    if (!checkpoint.analysisDoneImageIds.some(id => wanted.has(id) && !reused.has(id))) continue
    const source = inputsSchema.safeParse(spec.fixed), sourceDigest = source.success ? imageInputDigests(source.data) : undefined
    let requests: Set<string> | undefined
    for (const observationId of checkpoint.analysisResultIds) {
      const observation = domain.repository.get('observation', observationId)
      if (!observation || !done.has(observation.imageVersionId)) continue
      const imageId = observation.imageVersionId
      if (!wanted.has(imageId)) continue
      seen.add(imageId)
      if (!sourceDigest || spec.input.buildDataset !== true || reused.has(imageId) || sourceDigest(imageId) !== currentDigest(imageId)) continue
      if (!requests) {
        requests = new Set()
        // requestIds 与请求记录在同一次检查点提交；只读取该来源任务登记的请求。
        for (const id of data.requestIds) {
          const request = domain.repository.get('request', id)
          if (!request || request.runId !== run.id || request.state !== 'committed') continue
          const saved = committedRequestSchema.safeParse(request.data)
          if (saved.success) requests.add(saved.data.bundle.requestId)
        }
      }
      // 旧 Run 复用的观察仍指向原请求；输出及其图片必须已经持久化，不能复用在途响应。
      const committed = requests
      if (!observation.inferred.length || !observation.inferred.every(field => committed.has(field.requestId))) continue
      reused.set(imageId, { runId: run.id, observationId: observation.id, imageVersionId: domain.require('imageVersion', imageId).id })
    }
  }
  const entries = current.references.map(ref => {
    const { asset, image } = domain.authorizedImage(ref.imageVersionId, actor)
    return { referenceId: ref.id, imageVersionId: image.id, role: referenceFeedbackRole(current.draft.rules, ref, current.feedback), state: reused.has(image.id) ? 'analyzed' as const : seen.has(image.id) ? 'needs-update' as const : 'pending' as const, ...(asset.source.kind === 'provider' ? { providerId: asset.source.providerId, photoId: asset.source.providerAssetId } : {}) }
  })
  const links = [...reused.values()].sort((a, b) => a.imageVersionId.localeCompare(b.imageVersionId))
  const digest = contentDigest({ styleId, revision: current.style.revision, draft: current.draft, recipe: recipeIdentity(recipe), feedback: current.feedback, links })
  return { ...current, reused: links, view: referenceStateSchema.parse({ styleId, revision: current.style.revision, digest, total: imageIds.length, reusable: reused.size, pending: imageIds.length - reused.size, changed: imageIds.filter(id => seen.has(id) && !reused.has(id)).length, entries }) }
}

/** @param domain Persisted source records. @param value Frozen analysis inputs. @param links Observation links admitted by the Host. @param actor Trusted Run scope. @returns Whether each link still matches committed source inputs in the same collection and owner. */
export function validObservationReuse(domain: CuratorDomain, value: unknown, links: z.infer<typeof reusedObservationSchema>[], actor: DomainActor): boolean {
  const current = inputsSchema.parse(value), currentDigest = imageInputDigests(current), imageIds = new Set(current.references.map(ref => ref.imageVersionId))
  const sources = new Map<string, { run: RunRecord; spec: ReturnType<typeof specOf>; observations: Set<string>; images: Set<string> }>(), digests = new Map<string, ReturnType<typeof imageInputDigests>>()
  return new Set(links.map(link => link.imageVersionId)).size === links.length && links.every(link => {
    let source = sources.get(link.runId)
    if (!source) {
      const run = domain.require('run', link.runId)
      if (run.owner.kind === 'session' ? run.owner.sessionId !== actor.sessionId : !!actor.sessionId) return false
      const checkpoint = checkpointSchema.parse(dataOf(run).checkpoint)
      source = { run, spec: specOf(run), observations: new Set(checkpoint.analysisResultIds), images: new Set(checkpoint.analysisDoneImageIds) }; sources.set(link.runId, source)
    }
    const { run, spec } = source, observation = domain.require('observation', link.observationId)
    if (run.owner.kind === 'session' ? run.owner.sessionId !== actor.sessionId : !!actor.sessionId) return false
    if (spec.kind !== 'analyze' || spec.input.styleId !== current.draft.styleId || spec.input.buildDataset !== true || observation.imageVersionId !== link.imageVersionId) return false
    if (!source.observations.has(link.observationId) || !source.images.has(link.imageVersionId) || !imageIds.has(link.imageVersionId)) return false
    let sourceDigest = digests.get(run.id)
    if (!sourceDigest) { sourceDigest = imageInputDigests(inputsSchema.parse(spec.fixed)); digests.set(run.id, sourceDigest) }
    return sourceDigest(link.imageVersionId) === currentDigest(link.imageVersionId)
  })
}
