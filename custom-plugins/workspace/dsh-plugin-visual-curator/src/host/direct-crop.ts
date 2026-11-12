/** Direct-original admissions and reads never create collection references or synthetic searches. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { wallpaperPromptPreparationPolicySchema, wallpaperGenerationBriefPrompt } from '../shared/wallpaper-generation-brief.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { importedRecords } from './imports.ts'
import { directCropStartSchema, directCropMetadataSchema, directCropBatchSchema, type DirectCropBatch } from '../shared/direct-crop.ts'
import { claritySettingsSchema } from '../shared/clarity.ts'
import { backgroundResolutionSettingsSchema } from '../shared/background-resolution.ts'
import { wallpaperDecisionSettingsSchema } from '../shared/wallpaper-decision.ts'
import { resolveWallpaperProcessing, wallpaperRepairPolicySchema, wallpaperGenerativeRepair, wallpaperRepairInstructions } from '../shared/wallpaper-policy.ts'
import { applyWallpaperEspcn, applyWallpaperConcurrency, wallpaperWorkImage, wallpaperProgress, wallpaperSettingsSchema, wallpaperVerdict } from '../shared/wallpaper.ts'
import { sourceFaithfulWallpaperPrompts, wallpaperBaseSkill } from '../shared/wallpaper-prompts.ts'
import { assetSchema, imageVersionSchema, type DomainActor, type CuratorRecord, type RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { remoteReferenceBlob } from '../media/remote-reference.ts'
import type { AssetFiles } from '../media/assets.ts'
import type { CuratorConfig } from './config.ts'
import { dataOf, executionSchema, RunEngine, specOf, toJson } from './runtime.ts'
import { wallpaperBatch, wallpaperRunState } from './wallpaper-state.ts'
import { deleteTaskHistory, hiddenTaskIds } from './task-history.ts'
import type { WallpaperWorkflows } from './wallpaper-workflow.ts'

/** Existing profile-owned capabilities; image-model discovery never changes global selection. */
export interface DirectCropDependencies {
  domain: CuratorDomain; files: AssetFiles; engine: RunEngine; wallpaper: WallpaperWorkflows
  config(): CuratorConfig
  imageModels?(provider: string): Promise<readonly { id: string }[]>
}

/** @param run Saved execution. @returns Whether it explicitly owns direct-original processing. */
export function isDirectCropRun(run: RunRecord): boolean { return specOf(run).input.workflow === 'wallpaper-direct-v1' }

/** Batch admission is serialized; durable per-file receipts retain successful originals across retries. */
export class DirectCropTasks {
  private admissions: Promise<void> = Promise.resolve()
  constructor(private readonly deps: DirectCropDependencies) {}

  /** @param raw Explicit original selection. @param actor Authenticated human. @param signal Admission lifetime. @returns Stable root task identity. */
  start(raw: unknown, actor: DomainActor, signal: AbortSignal): Promise<{ runId: string }> {
    const work = this.admissions.then(() => this.startNow(raw, actor, signal))
    this.admissions = work.then(() => {}, () => {})
    return work
  }
  /** Replace one source in a settled batch; the preceding run retains its original, edits and outputs.
   * @param raw Current task, selected image and one local file. @param actor Authenticated profile owner. @param signal Import lifetime.
   * @returns Stable continuation identity for the replacement alone.
   */
  replace(raw: unknown, actor: DomainActor, signal: AbortSignal): Promise<{ runId: string }> {
    const work = this.admissions.then(async () => {
      if (actor.kind !== 'human' || actor.profileId !== this.deps.domain.profileId) throw new CuratorError('owner-denied', 'direct-crop-replace', 'Replacement requires the authenticated profile owner.')
      const input = z.strictObject({ runId: z.string(), imageVersionId: z.string(), operationId: z.string(), file: z.strictObject({ path: z.string().min(1), name: z.string().min(1) }) }).parse(raw)
      const old = this.deps.engine.get(input.runId, actor)
      if (!isDirectCropRun(old) || ['created', 'running', 'pausing', 'cancelling', 'cancelled'].includes(old.status)) throw new CuratorError('constraint-conflict', 'direct-crop-replace', 'Pause or finish the current direct batch before replacing one original.')
      if (!wallpaperRunState(this.deps.domain, old).items.some(item => item.imageVersionId === input.imageVersionId)) throw new CuratorError('constraint-conflict', 'direct-crop-replace', 'Refresh the selected image before replacing its original.')
      const aggregateId = `direct-replacement:${contentDigest({ operationId: input.operationId, owner: actor })}`, inputDigest = contentDigest(input)
      const receipt = this.deps.domain.repository.manifest(aggregateId)
      let imageId: string
      if (receipt) imageId = z.object({ inputDigest: z.literal(inputDigest), imageId: z.string() }).parse(receipt.state).imageId
      else {
        const imported = await this.deps.files.importFile(input.file.path, signal)
        const saved = importedRecords(actor.profileId, actor, imported, { kind: 'local-import', description: input.file.name }, 'bytes-allowed')
        imageId = saved.image.id
        await this.deps.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: aggregateId, request: { inputDigest }, records: saved.records, state: { inputDigest, imageId } })
      }
      return await this.deps.wallpaper.continue({ runId: input.runId, operationId: input.operationId, imageAction: { action: 'replace', imageVersionId: input.imageVersionId, replacementId: imageId } }, actor)
    })
    this.admissions = work.then(() => {}, () => {})
    return work
  }
  private async startNow(raw: unknown, actor: DomainActor, signal: AbortSignal) {
    if (actor.kind !== 'human' || actor.profileId !== this.deps.domain.profileId) throw new CuratorError('owner-denied', 'direct-crop-start', 'Direct cropping requires the authenticated profile owner.')
    const input = directCropStartSchema.parse(raw), inputDigest = contentDigest(input), owner: DomainActor = { kind: 'human', id: actor.id, profileId: actor.profileId }
    const runId = this.deps.engine.operationRunId(input.operationId, owner), prior = this.deps.domain.repository.get('run', runId)
    if (prior) {
      this.deps.engine.get(runId, owner)
      if (!isDirectCropRun(prior) || directCropMetadataSchema.parse(specOf(prior).fixed.directCrop).inputDigest !== inputDigest) throw new CuratorError('operation-conflict', 'direct-crop-start', 'The operation identity was used for different originals.')
      return { runId }
    }
    const config = structuredClone(this.deps.config()), selected = input.source.kind === 'local' ? input.source.files : input.source.photos
    if (selected.length > config.limits.maxImportFiles || new Set(selected.map(file => 'path' in file ? file.path : file.id)).size !== selected.length) throw new CuratorError('invalid-input', 'direct-crop-start', 'Select a bounded set of distinct originals.')
    if (input.source.kind === 'gallery') {
      const accountId = input.source.accountId
      if (!config.source.unsplash.accounts.some(account => account.id === accountId)) throw new CuratorError('configuration-required', 'direct-crop-start', 'Choose a configured gallery account.')
      config.source.provider = 'unsplash'; config.source.unsplash.defaultAccountId = input.source.accountId
    }
    const images: string[] = []
    for (const [index, file] of selected.entries()) {
      signal.throwIfAborted()
      const aggregateId = `direct-original:${runId}:${index}`, receipt = this.deps.domain.repository.manifest(aggregateId)
      if (receipt) {
        const saved = z.object({ inputDigest: z.literal(inputDigest), imageId: z.string() }).parse(receipt.state)
        this.deps.domain.authorizedImage(saved.imageId, owner); images.push(saved.imageId); continue
      }
      let records: CuratorRecord[], imageId: string
      if ('path' in file) {
        const imported = await this.deps.files.importFile(file.path, signal)
        const saved = importedRecords(actor.profileId, owner, imported, { kind: 'local-import', description: file.name }, 'bytes-allowed')
        records = saved.records; imageId = saved.image.id
      } else if (input.source.kind === 'server') {
        const imported = this.deps.domain.authorizedImage(file.id, owner)
        if (imported.asset.source.kind !== 'provider' || imported.asset.source.providerId !== 'oppo-server-v1' || imported.image.versionKind !== 'normalized' || !imported.asset.originalBlob) throw new CuratorError('owner-denied', 'direct-crop-start', 'Choose an original imported by the server queue.')
        records = []; imageId = imported.image.id
      } else {
        if (input.source.kind !== 'gallery') throw new CuratorError('invalid-input', 'direct-crop-start', 'The selected original kind is inconsistent.')
        const photo = input.source.photos.find(photo => photo.id === file.id)!
        const base = { schemaVersion: 1, profileId: actor.profileId, createdAt: new Date().toISOString() }, accountId = input.source.accountId
        const blob = remoteReferenceBlob({ providerId: 'unsplash', photoId: photo.id, accountId, url: photo.referenceUrl, thumbnailUrl: photo.thumbnailUrl })
        const asset = assetSchema.parse({ ...base, kind: 'asset', id: randomUUID(), familyId: `remote-unsplash:${contentDigest(file.id).slice(10)}`, source: { kind: 'provider', providerId: 'unsplash', providerAssetId: file.id, accountIdentity: accountId, description: file.title || file.id, obtainedAt: base.createdAt }, access: { kind: 'profile-library' }, exportPermission: 'bytes-allowed', exportConfirmedBy: { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'import-confirmation', confirmedAt: base.createdAt }, groupingStatus: 'unreviewed' })
        const image = imageVersionSchema.parse({ ...base, kind: 'imageVersion', id: randomUUID(), assetId: asset.id, versionKind: 'remote-reference', blob, geometry: { width: photo.width, height: photo.height, colorSpace: 'unverified', processorVersion: 'direct-gallery-source-v1' } })
        records = [asset, image]; imageId = image.id
      }
      await this.deps.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: aggregateId, request: { inputDigest, index }, records, state: { inputDigest, imageId } })
      images.push(imageId)
    }
    const requested = wallpaperSettingsSchema.parse({ ...config.wallpaper, backgroundAlignment: config.wallpaper.backgroundAlignment ?? wallpaperSettingsSchema.shape.backgroundAlignment.unwrap().parse({}), sourceFrameRepair: config.wallpaper.sourceFrameRepair ?? wallpaperSettingsSchema.shape.sourceFrameRepair.unwrap().parse({}), decision: config.wallpaper.decision ?? wallpaperDecisionSettingsSchema.parse({}), clarity: config.wallpaper.clarity ?? claritySettingsSchema.parse({}), backgroundResolution: config.wallpaper.backgroundResolution ?? backgroundResolutionSettingsSchema.parse({}), learningEnabled: false, autoPromote: false })
    let imageModel = requested.imageModel
    if (!imageModel && this.deps.imageModels) {
      try { imageModel = (await this.deps.imageModels(requested.imageProvider))[0]?.id ?? '' }
      catch (error) { /* An unavailable optional image route leaves pure cropping available. */ }
    }
    const settings = { ...requested, imageModel, processing: resolveWallpaperProcessing(requested.processing), repairPolicy: requested.repairPolicy ?? wallpaperRepairPolicySchema.parse({}) }, prompts = sourceFaithfulWallpaperPrompts(settings)
    applyWallpaperConcurrency(settings); applyWallpaperEspcn(settings)
    const normalized = { workflow: 'wallpaper-direct-v1', operationId: input.operationId, sourceRunId: runId, imageVersionIds: images, targetCount: images.length, taskBrief: wallpaperGenerativeRepair(settings) ? wallpaperRepairInstructions : '忠于指定原图；保留现有主体、关键结构、颜色、材质和标识；允许经局部核实的画框边缘自然扩图，新增部位必须独立复审；严格遵守主体安全区与画面质量要求' }
    const fixed = { reviewOrder: 'generation-before-resolution-v1', generationPrompt: toJson(wallpaperGenerationBriefPrompt), generationPromptPolicy: toJson(wallpaperPromptPreparationPolicySchema.parse(config.vision.wallpaperPromptPreparation ?? {})), directCrop: toJson({ version: 'direct-crop-v1', name: input.name, origin: input.source.kind, inputDigest }), directPolicy: toJson({ version: wallpaperGenerativeRepair(settings) ? 'subject-repair-v1' : 'source-faithful-v2', promptDigest: contentDigest(prompts) }), prompts: toJson(prompts), promptDigest: contentDigest(prompts), wallpaper: toJson(settings), skill: { id: 'direct-original-base-v1', content: wallpaperGenerativeRepair(settings) ? wallpaperRepairInstructions : wallpaperBaseSkill } }
    const spec = executionSchema.parse({ kind: 'crop', config, input: normalized, fixed, specDigest: contentDigest({ kind: 'crop', config, input: normalized, fixed }) })
    return { runId: (await this.deps.engine.create(spec, owner, this.deps.wallpaper.worker(), input.operationId)).id }
  }

  /** @param actor Authenticated human. @param offset First root batch. @returns Bounded newest-first actual crop batches, each following its latest continuation. */
  list(actor: DomainActor, offset = 0, runId?: string): { batches: DirectCropBatch[]; total: number; nextOffset?: number } {
    if (actor.kind !== 'human' || actor.profileId !== this.deps.domain.profileId) throw new CuratorError('owner-denied', 'direct-crop-list', 'Direct batches require the profile owner.')
    return this.deps.domain.repository.readSnapshot(() => {
      const runs = this.deps.domain.repository.list('run').filter(isDirectCropRun)
      const continuations = new Map<string, RunRecord[]>()
      for (const run of runs) {
        const sourceRunId = specOf(run).input.sourceRunId
        if (typeof sourceRunId !== 'string') throw new CuratorError('reference-unavailable', 'direct-crop-list', 'A direct-crop task is missing its source run identity.')
        const related = continuations.get(sourceRunId) ?? []
        related.push(run)
        continuations.set(sourceRunId, related)
      }
      for (const related of continuations.values()) related.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const hidden = hiddenTaskIds(this.deps.domain.repository)
      const roots = runs.filter(run => !hidden.has(run.id) && specOf(run).input.sourceRunId === run.id && (!runId || run.id === runId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const limit = this.deps.config().limits.pageSize
      const batches = roots.slice(offset, offset + limit).map(root => {
        this.deps.engine.authorize(root, actor)
        const related = continuations.get(root.id)!, current = related[0]!
        this.deps.engine.authorize(current, actor)
        const stopped = ['completed', 'failed', 'cancelled'].includes(current.status) && !related.some(run => ['created', 'running', 'pausing', 'cancelling'].includes(run.status))
        const metadata = directCropMetadataSchema.parse(specOf(root).fixed.directCrop), state = wallpaperRunState(this.deps.domain, current), counts = wallpaperProgress(state, wallpaperWorkImage(specOf(current).input), current.status), data = dataOf(current)
        return directCropBatchSchema.parse({ runId: root.id, directCrop: true, removable: stopped, name: metadata.name, origin: metadata.origin, kind: 'crop', status: current.status, createdAt: root.createdAt, taskBrief: metadata.name, matched: state.items.length, unavailable: false, images: [], wallpaper: { runId: current.id, status: current.status, total: state.items.length, planned: counts.planned, rendered: counts.rendered, reviewed: counts.reviewed, passed: counts.passed, attention: counts.attention, budgetStopped: state.budgetStopped, counts, ...(data.error ? { errorCode: data.error.code } : {}) } })
      })
      return { batches, total: roots.length, ...(offset + limit < roots.length ? { nextOffset: offset + limit } : {}) }
    })
  }

  /** @param raw Confirmed root batch and idempotent action identity. @param actor Profile owner. @returns Durable list removal; original files, outputs and all run records remain addressable. */
  remove(raw: unknown, actor: DomainActor): Promise<{ runId: string; deleted: true }> {
    const work = this.admissions.then(() => this.removeNow(raw, actor)); this.admissions = work.then(() => {}, () => {}); return work
  }
  private async removeNow(raw: unknown, actor: DomainActor): Promise<{ runId: string; deleted: true }> {
    if (actor.kind !== 'human' || actor.profileId !== this.deps.domain.profileId) throw new CuratorError('owner-denied', 'direct-crop-delete', 'Direct batch removal requires its profile owner.')
    const { runId, operationId } = z.strictObject({ runId: z.string().min(1), operationId: z.string().min(1) }).parse(raw)
    const root = this.deps.engine.get(runId, actor)
    if (!isDirectCropRun(root) || specOf(root).input.sourceRunId !== root.id) throw new CuratorError('invalid-input', 'direct-crop-delete', 'Choose the root of a direct-original batch.')
    if (hiddenTaskIds(this.deps.domain.repository).has(root.id)) return { runId: root.id, deleted: true }
    const batch = wallpaperBatch(this.deps.domain, root)
    if (!batch.stopped) throw new CuratorError('constraint-conflict', 'direct-crop-delete', 'Stop every task in the batch before removing its list entry.')
    return deleteTaskHistory(this.deps.domain.repository, root, operationId, batch.current)
  }

  /** Read only the latest approved clean artifact; export and server delivery share the same gate.
   * @param runId Exact current task. @param imageVersionId Original slot. @param actor Profile owner. @param signal Read lifetime.
   * @returns Verified final bytes and identities, or an error for unapproved or superseded evidence.
   */
  async approvedFile(runId: string, imageVersionId: string, actor: DomainActor, signal: AbortSignal) {
    const run = this.deps.engine.get(runId, actor)
    if (actor.kind !== 'human' || !isDirectCropRun(run)) throw new CuratorError('owner-denied', 'direct-crop-output', 'Choose a direct-original task owned by this profile.')
    const state = wallpaperRunState(this.deps.domain, run), item = state.items.find(item => item.imageVersionId === imageVersionId), attempt = item?.attempts.at(-1)
    if (!item || item.status !== 'passed' || !attempt?.review || wallpaperVerdict(attempt.review) !== 'pass' || attempt.checks.length || !attempt.outputId || attempt.preResolutionReview && attempt.preResolutionReview.finalId !== attempt.outputId) throw new CuratorError('constraint-conflict', 'direct-crop-output', 'The current output has no matching generated-image review and completed processing evidence.')
    const latest = this.deps.domain.repository.list('run').filter(row => isDirectCropRun(row) && specOf(row).input.sourceRunId === state.sourceRunId).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
    if (latest?.id !== run.id) throw new CuratorError('revision-conflict', 'direct-crop-output', 'A newer task owns this image; inspect its latest result.')
    const image = this.deps.domain.authorizedImage(attempt.outputId, actor).image, settings = wallpaperSettingsSchema.parse(specOf(run).fixed.wallpaper)
    const bytes = await this.deps.files.read(image.blob, signal), measured = await sharp(bytes).metadata()
    if (image.processing?.wallpaperArtifact !== 'final' || measured.format !== 'png' || measured.width !== settings.width || measured.height !== settings.height) throw new CuratorError('constraint-conflict', 'direct-crop-output', 'The saved file is not a clean PNG of the required dimensions.')
    return { item, attempt, image, bytes }
  }

  /** @param runId Exact reviewed task. @param directory Native-picker destination. @param actor Authenticated human. @param signal Export lifetime. @returns Saved clean PNGs and a manifest; no history or existing file is overwritten. */
  async export(runId: string, directory: string, actor: DomainActor, signal: AbortSignal): Promise<{ directory: string; files: number; excluded: number }> {
    const run = this.deps.engine.get(runId, actor)
    if (actor.kind !== 'human' || !isDirectCropRun(run)) throw new CuratorError('owner-denied', 'direct-crop-export', 'Choose a direct-original task owned by this profile.')
    const state = wallpaperRunState(this.deps.domain, run), settings = wallpaperSettingsSchema.parse(specOf(run).fixed.wallpaper)
    const accepted = state.items.filter(item => item.status === 'passed' && item.attempts.at(-1)?.review && wallpaperVerdict(item.attempts.at(-1)!.review!) === 'pass' && !item.attempts.at(-1)!.checks.length)
    if (!accepted.length) throw new CuratorError('constraint-conflict', 'direct-crop-export', 'There are no independently approved clean outputs to export.')
    const parent = resolve(directory), output = resolve(parent, 'visual-curator-direct-' + state.sourceRunId.slice(0, 12) + '-' + run.id.slice(0, 12))
    if (!output.startsWith(parent.endsWith(sep) ? parent : parent + sep)) throw new CuratorError('invalid-input', 'direct-crop-export', 'The export destination is invalid.')
    await mkdir(output, { recursive: true })
    const rows = []
    const save = async (path: string, bytes: Uint8Array) => {
      try { await writeFile(path, bytes, { flag: 'wx', signal }) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) throw new CuratorError('operation-conflict', 'direct-crop-export', 'The destination contains a different file; choose another folder.')
      }
    }
    for (const item of accepted) {
      signal.throwIfAborted()
      const { attempt, image, bytes } = await this.approvedFile(run.id, item.imageVersionId, actor, signal)
      const name = String(state.items.indexOf(item) + 1).padStart(3, '0') + '-' + image.id.slice(-12) + '.png'
      await save(join(output, name), bytes)
      const source = this.deps.domain.authorizedImage(item.originalId!, actor), original = item.download?.originalBlob ?? source.asset.originalBlob ?? source.image.blob
      rows.push({ name, imageVersionId: image.id, sourceImageVersionId: item.originalId!, sourceDigest: original.digest, outputDigest: image.blob.digest, width: settings.width, height: settings.height, reviewedImageVersionId: attempt.preResolutionReview?.nativeId ?? image.id, postProcessing: attempt.preResolutionReview ? attempt.backgroundResolution ? { kind: 'super-resolution', model: attempt.backgroundResolution.model, modelSha256: attempt.backgroundResolution.modelSha256, postResolutionModelReview: false } : { kind: 'layout-render-only', postResolutionModelReview: false } : { kind: 'legacy-output-review' }, review: attempt.review })
    }
    await save(join(output, 'manifest.json'), Buffer.from(JSON.stringify({ version: 'direct-crop-export-v1', runId: run.id, sourceRunId: state.sourceRunId, policy: specOf(run).fixed.directPolicy, files: rows, excluded: state.items.length - accepted.length }, null, 2) + '\n', 'utf8'))
    return { directory: output, files: rows.length, excluded: state.items.length - accepted.length }
  }
}
