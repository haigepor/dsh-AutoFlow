/** Completed-task references keep explicit human roles and their original media permissions. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { AssetFiles } from '../media/assets.ts'
import { assetSchema, imageVersionSchema, referenceSchema, styleStandardSchema, dimensionSchema, type DomainActor, type RunRecord, type Assessment } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { taskReferenceReadSchema, taskReferenceImportSchema, taskReferenceReceiptSchema, taskReferencePageSchema, type TaskReferenceImport, type TaskReferencePage, type TaskReferenceReceipt } from '../shared/task-references.ts'
import { hiddenTaskIds } from './task-history.ts'
import { dataOf, rankedSelections, safeFailure, specOf, toJson } from './runtime.ts'
import { executionStandard } from './style-execution.ts'
import { resultCategory, searchIssueSchema, type RunResultFilter } from '../shared/search-feedback.ts'

const membershipSchema = z.object({ kind: z.string(), input: z.object({ taskBrief: z.unknown().optional() }), fixed: z.object({ release: z.unknown().optional() }) })
const collectionSchema = z.object({ styleId: z.string() })

function completedTasks(domain: CuratorDomain, styleId: string, actor: DomainActor): TaskReferencePage['tasks'] {
  if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'task-reference', 'Only the authenticated owner may add task references.')
  domain.repository.assertProfile(actor.profileId); domain.require('style', styleId)
  const hidden = hiddenTaskIds(domain.repository)
  return domain.repository.recordIds('run').flatMap(id => {
    const row = domain.repository.project('run', id, run => {
      if (run.profileId !== actor.profileId || run.status !== 'completed' || hidden.has(run.id)) return null
      const spec = membershipSchema.parse(run.spec), standard = collectionSchema.safeParse(spec.fixed.release)
      if (spec.kind !== 'search' || !standard.success || standard.data.styleId !== styleId) return null
      const data = z.object({ counts: z.object({ candidates: z.number().optional() }) }).parse(run.data)
      return { runId: run.id, taskBrief: typeof spec.input.taskBrief === 'string' ? spec.input.taskBrief : '', createdAt: run.createdAt, candidates: data.counts.candidates ?? 0 }
    })
    return row ? [row] : []
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))
}

/** @param domain Current profile. @param styleId Selected collection. @param runId Explicit completed task. @param actor Human owner. @returns Eligible Run without granting access to another Session. */
export function referenceTask(domain: CuratorDomain, styleId: string, runId: string, actor: DomainActor): RunRecord {
  if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'task-reference', 'Only the authenticated owner may add task references.')
  domain.repository.assertProfile(actor.profileId)
  return domain.repository.readSnapshot(() => {
    domain.require('style', styleId)
    const run = domain.repository.get('run', runId), hidden = domain.repository.manifest(`task-history-hidden:${runId}`)
    const spec = run ? membershipSchema.parse(run.spec) : undefined, standard = collectionSchema.safeParse(spec?.fixed.release)
    if (!run || run.profileId !== actor.profileId || run.status !== 'completed' || hidden || spec?.kind !== 'search' || !standard.success || standard.data.styleId !== styleId) throw new CuratorError('owner-denied', 'task-reference', 'Choose an available completed search in this collection.')
    return run
  })
}

type AssessmentFields = Pick<Assessment, 'id' | 'imageVersionId' | 'stage' | 'technicalStatus' | 'verdict' | 'preferenceScores'>

function taskImages(domain: CuratorDomain, run: RunRecord, actor: DomainActor, filter: RunResultFilter): TaskReferencePage['images'] {
  if (run.owner.kind === 'session' && run.owner.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'task-reference', 'This task belongs to another Session.')
  const spec = specOf(run), data = dataOf(run), imageIds = new Set<string>(), assessments = new Map<string, AssessmentFields>(), latest = new Map<string, AssessmentFields>(), final = new Map<string, AssessmentFields>(), sourceIds = new Set<string>()
  for (const id of domain.repository.recordIds('assessment')) {
    const row = domain.repository.project('assessment', id, assessment => assessment.runId === run.id ? { id: assessment.id, imageVersionId: assessment.imageVersionId, stage: assessment.stage, technicalStatus: assessment.technicalStatus, ...(assessment.verdict ? { verdict: assessment.verdict } : {}), preferenceScores: assessment.preferenceScores } : null)
    if (!row) continue
    assessments.set(row.id, row); latest.set(row.imageVersionId, row); imageIds.add(row.imageVersionId)
    if (row.stage === 'final') final.set(row.imageVersionId, row)
  }
  const search = z.object({ importedImages: z.record(z.string(), z.string()), issues: z.array(searchIssueSchema).default([]) }).safeParse(data.checkpoint.previewSearch ?? data.checkpoint.search)
  if (search.success) for (const id of Object.values(search.data.importedImages)) imageIds.add(id)
  for (const id of domain.repository.recordIds('cropCandidate')) {
    const crop = domain.repository.project('cropCandidate', id, row => row.runId === run.id ? { parent: row.parentImageVersionId, derived: row.derivedImageVersionId } : null)
    if (!crop) continue
    imageIds.add(crop.parent)
    if (crop.derived) { imageIds.add(crop.derived); sourceIds.add(crop.parent) }
  }
  const selections = domain.repository.recordIds('selection').flatMap(id => {
    const row = domain.repository.project('selection', id, selection => selection.runId === run.id ? { imageVersionId: selection.imageVersionId, assessmentId: selection.assessmentId } : null)
    return row ? [row] : []
  })
  const standard = executionStandard(styleStandardSchema.parse(spec.fixed.release), spec.fixed.executionRecipe)
  const selected = rankedSelections(selections.map(selection => ({ id: selection.imageVersionId, score: Object.entries(standard.recipe.preferenceScale.weights).reduce((score, [dimension, weight]) => score + (assessments.get(selection.assessmentId)?.preferenceScores[dimensionSchema.parse(dimension)] ?? 0) * weight, 0) })))
  const selectedIds = new Set(selected.map(row => row.id))
  for (const id of selectedIds) imageIds.add(id)
  const order = [...selectedIds, ...[...imageIds].filter(id => !selectedIds.has(id)).sort()]
  return order.flatMap(id => {
    const assessment = final.get(id) ?? latest.get(id)
    const category = resultCategory({ selected: selectedIds.has(id), technicalFailed: assessment?.technicalStatus === 'failed', verdict: assessment?.verdict, settled: true, source: sourceIds.has(id) })
    if (filter !== 'all' && category !== filter) return []
    try {
      const { image, asset } = domain.authorizedImage(id, actor), previewPath = `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: image.id })}`
      return [{ imageVersionId: image.id, name: asset.source.description || asset.id, width: image.geometry.width, height: image.geometry.height, kind: image.versionKind, previewPath, ...(image.blob.remoteSource ? { thumbnailPath: `${previewPath}&preview=thumbnail` } : {}), resultCategory: category }]
    } catch (error) { if (error instanceof CuratorError && error.code === 'owner-denied') return []; throw error }
  })
}

function offset(token: string | undefined, scope: string, ids: string[]): number {
  if (!token) return 0
  let value: unknown
  try { value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) } catch (error) { throw new CuratorError('invalid-input', 'task-reference-page', 'Refresh this task before loading more.', { cause: error }) }
  const cursor = z.strictObject({ scope: z.string(), id: z.string() }).safeParse(value)
  const index = cursor.success ? ids.indexOf(cursor.data.id) : -1
  if (!cursor.success || cursor.data.scope !== scope || index < 0) throw new CuratorError('invalid-input', 'task-reference-page', 'Refresh this task before loading more.')
  return index + 1
}
const cursor = (scope: string, id: string) => Buffer.from(JSON.stringify({ scope, id }), 'utf8').toString('base64url')

/** @param domain Current records. @param actor Human with the selected task's original Session authority when reading images. @param args Collection, task and cursor. @param pageSize Configured page limit. @returns Completed tasks or authorized candidate images, including rejected candidates. */
export function readTaskReferences(domain: CuratorDomain, actor: DomainActor, args: unknown, pageSize: number): TaskReferencePage {
  const input = taskReferenceReadSchema.parse(args), scope = JSON.stringify([actor.profileId, input.styleId, input.runId ?? null, input.resultFilter])
  return domain.repository.readSnapshot(() => {
    if (!input.runId) {
      const tasks = completedTasks(domain, input.styleId, actor), start = offset(input.pageToken, scope, tasks.map(task => task.runId)), page = tasks.slice(start, start + pageSize)
      return { styleId: input.styleId, runId: null, images: [], totalImages: 0, tasks: page, ...(start + pageSize < tasks.length ? { nextPageToken: cursor(scope, page.at(-1)!.runId) } : {}) }
    }
    const run = referenceTask(domain, input.styleId, input.runId, actor)
    const images = taskImages(domain, run, actor, input.resultFilter), start = offset(input.pageToken, scope, images.map(image => image.imageVersionId)), page = images.slice(start, start + pageSize)
    return taskReferencePageSchema.parse({ styleId: input.styleId, runId: run.id, tasks: [], images: page, totalImages: images.length, ...(start + pageSize < images.length ? { nextImagePageToken: cursor(scope, page.at(-1)!.imageVersionId) } : {}) })
  })
}

/** @param domain Current records. @param actor Human owner. @param input Explicit cross-task selection. @param maxFiles Configured total bound. @param sourceActors Verified source Session readers. Validate every task membership before admitting writes. */
export function validateTaskReferences(domain: CuratorDomain, actor: DomainActor, input: TaskReferenceImport, maxFiles: number, sourceActors: ReadonlyMap<string, DomainActor>): void {
  if (input.images.length > maxFiles || new Set(input.images.map(image => image.imageVersionId)).size !== input.images.length) throw new CuratorError('invalid-input', 'task-reference', 'Choose a bounded set of distinct task images.')
  for (const runId of new Set(input.images.map(image => image.runId))) {
    const run = referenceTask(domain, input.styleId, runId, actor), reader = sourceActors.get(runId)
    if (!reader) throw new CuratorError('owner-denied', 'task-reference', 'The source Session is unavailable.')
    const eligible = domain.repository.readSnapshot(() => new Set(taskImages(domain, run, reader, 'all').map(image => image.imageVersionId)))
    if (input.images.some(image => image.runId === runId && !eligible.has(image.imageVersionId))) throw new CuratorError('owner-denied', 'task-reference', 'Every selected image must belong to its chosen task.')
  }
}

const referenceIdentity = (profileId: string, sourceId: string) => contentDigest({ profileId, sourceId }).slice(10)

/** @param domain Current references. @param input Previously authorized, frozen selection. @returns Images still missing a committed reference with the requested role; other tasks and roles never count as completion. */
export function pendingTaskReferences(domain: CuratorDomain, input: TaskReferenceImport): TaskReferenceImport['images'] {
  const style = domain.require('style', input.styleId), draft = domain.require('draft', style.draftId), references = draft.referenceIds.map(id => domain.require('reference', id))
  return input.images.filter(({ imageVersionId }) => {
    const source = domain.require('imageVersion', imageVersionId), asset = domain.require('asset', source.assetId)
    const targetId = asset.access.kind === 'profile-library' ? source.id : `task-ref-image-${referenceIdentity(source.profileId, source.id)}`
    return !references.some(reference => reference.imageVersionId === targetId && reference.intent.kind === 'overall' && domain.referenceJudgments(reference).some(feedback => feedback.judgment.kind === 'style-verdict' && feedback.judgment.value === (input.role === 'positive' ? 'accept' : 'reject')))
  })
}

/** @param domain Current records. @param files Existing media verifier; remote descriptors do not download originals. @param actor Human owner adding references. @param args Frozen cross-task selection, collection revision and role. @param maxFiles Configured total addition bound. @param signal Request lifetime. @param sourceActors Verified original Session authority for every selected task. @returns Committed per-image outcomes; retry resumes the same operation without duplicating references. */
export async function importTaskReferences(domain: CuratorDomain, files: AssetFiles, actor: DomainActor, args: unknown, maxFiles: number, signal: AbortSignal, sourceActors: ReadonlyMap<string, DomainActor>): Promise<TaskReferenceReceipt> {
  const input = taskReferenceImportSchema.parse(args)
  validateTaskReferences(domain, actor, input, maxFiles, sourceActors)
  const aggregateId = `task-reference:${contentDigest({ profileId: actor.profileId, operationId: input.operationId })}`
  let saved = domain.repository.manifest(aggregateId)
  if (saved) {
    if ((saved.receipts[input.operationId] ?? saved.receipts[`${input.operationId}:prepared`])?.requestDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'task-reference', 'This addition already describes another selection.')
    if (saved.receipts[input.operationId]) return taskReferenceReceiptSchema.parse(saved.state)
  } else {
    const style = domain.require('style', input.styleId)
    if (style.archived || style.revision !== input.expectedRevision) throw new CuratorError('revision-conflict', 'task-reference', 'Refresh this collection before adding task references.')
    await domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: `${input.operationId}:prepared`, request: input, records: [], state: { results: [] } })
    saved = domain.repository.manifest(aggregateId)!
  }
  const receipt = taskReferenceReceiptSchema.parse(saved.state)
  const append = domain.beginReferenceAppend(input.styleId, domain.require('style', input.styleId).revision, actor)
  for (const { runId, imageVersionId: sourceId } of input.images) {
    if (receipt.results.some(row => row.sourceImageVersionId === sourceId)) continue
    signal.throwIfAborted()
    let row: TaskReferenceReceipt['results'][number]
    try {
      const { image: source, asset } = domain.authorizedImage(sourceId, sourceActors.get(runId)!)
      domain.assertLearningFamily(domain.familyOf(asset.familyId))
      await files.verifyReference(source.blob, signal)
      let image = source
      if (asset.access.kind !== 'profile-library') {
        const identity = referenceIdentity(actor.profileId, sourceId), imageId = `task-ref-image-${identity}`
        const existing = domain.repository.get('imageVersion', imageId)
        if (existing) image = existing
        else {
          const copy = assetSchema.parse({ ...asset, id: `task-ref-asset-${identity}`, access: { kind: 'profile-library' } })
          image = imageVersionSchema.parse({ ...source, id: imageId, assetId: copy.id, parentImageVersionId: undefined })
          await domain.repository.commit({ aggregateId: `task-reference-image:${imageId}`, expectedRevision: 0, operationId: imageId, request: { sourceId }, records: [copy, image], state: { imageId } })
        }
      }
      const style = domain.require('style', input.styleId)
      if (style.archived) throw new CuratorError('constraint-conflict', 'task-reference', 'This collection is archived.')
      const existing = append.findByImage(image.id)
      if (existing) {
        const value = input.role === 'positive' ? 'accept' : 'reject'
        if (existing.intent.kind !== 'overall' || !domain.referenceJudgments(existing).some(feedback => feedback.judgment.kind === 'style-verdict' && feedback.judgment.value === value)) throw new CuratorError('constraint-conflict', 'task-reference', 'This image is already referenced with another role. Adjust the existing reference first.')
        row = { sourceImageVersionId: sourceId, status: 'skipped', referenceId: existing.id }
      } else {
        const key = `${input.operationId}:${sourceId}`
        const reference = z.object({ id: referenceSchema.shape.id }).parse(await domain.action('reference-confirm', { operationId: `${key}:reference`, styleId: style.id, imageVersionId: image.id, role: input.role, intent: { kind: 'overall' }, context: {}, viewEvidence: [{ imageVersionId: image.id, versionKind: image.versionKind }] }, actor))
        await append.append(reference.id, `${key}:draft`, style.revision)
        row = { sourceImageVersionId: sourceId, status: 'added', referenceId: reference.id }
      }
    } catch (error) { signal.throwIfAborted(); row = { sourceImageVersionId: sourceId, status: 'failed', code: safeFailure(error).code } }
    receipt.results.push(row)
    await domain.repository.commit({ aggregateId, expectedRevision: saved.revision, operationId: `${input.operationId}:row:${sourceId}`, request: { sourceId }, records: [], state: toJson(receipt) })
    saved = domain.repository.manifest(aggregateId)!
  }
  await domain.repository.commit({ aggregateId, expectedRevision: saved.revision, operationId: input.operationId, request: input, records: [], state: toJson(receipt) })
  return receipt
}
