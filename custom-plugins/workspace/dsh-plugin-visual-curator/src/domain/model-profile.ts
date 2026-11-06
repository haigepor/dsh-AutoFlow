/** Immutable model-adopted rules and reference packages, independent of human review records. */
import { z } from 'zod'
import type { CuratorDomain } from './curator.ts'
import { contentDigest, fileChecksum } from './repository.ts'
import { removedDatasetIds } from './dataset-removal.ts'
import { analysisReferenceDigest } from './style-analysis.ts'
import { styleAnalysisOf, type StyleAnalysis } from '../shared/style-analysis.ts'
import { modelProfileSchema, profileExportSchema, recipeSchema, type DomainActor, type ModelProfile, type ProfileExport, type ReferenceSnapshot, type Rule, type RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DatasetProgress, DatasetScope } from '../shared/datasets.ts'
import { effectiveReviewReferenceRole, isMatchingRule } from '../shared/reference-semantics.ts'

/** Only selection and optional wording changes cross the Client wire; evidence stays Host-owned. */
export const profileSaveSchema = z.strictObject({ operationId: z.string().min(1), styleId: z.string(), analysisRunId: z.string(), expectedProfileId: z.string(), changes: z.array(z.strictObject({ ruleId: z.string(), enabled: z.boolean(), statement: z.string().trim().min(1).max(4096).optional() })) })
type Option = ModelProfile['options'][number]
const identity = (kind: string, value: unknown) => `${kind}-${contentDigest(value).slice(10, 50)}`

function ruleReferenceRole(rule: Rule, reference: ReferenceSnapshot) {
  if (reference.reference.intent.kind === 'dimensions' && !reference.reference.intent.dimensions.includes(rule.dimension)) return undefined
  return effectiveReviewReferenceRole({ rules: [rule] }, reference)
}

function hasNegativeRuleEvidence(rule: Rule, references: readonly ReferenceSnapshot[]): boolean {
  return rule.counterRefs.length > 0
    && rule.counterRefs.every(id => { const reference = references.find(ref => ref.reference.id === id); return reference !== undefined && ruleReferenceRole(rule, reference) === 'negative' })
    && rule.supportRefs.every(id => { const reference = references.find(ref => ref.reference.id === id); return reference !== undefined && ruleReferenceRole(rule, reference) === 'positive' })
}

function hasCurrentRuleEvidence(rule: Rule, references: readonly ReferenceSnapshot[]): boolean {
  const negativeEvidence = hasNegativeRuleEvidence(rule, references)
  const supported = rule.strength === 'required' && rule.confirmation.status === 'suggested' && rule.counterRefs.length > 0 ? negativeEvidence : rule.supportRefs.length > 0 || negativeEvidence
  return supported && [...rule.supportRefs, ...rule.counterRefs].every(id => references.some(ref => ref.reference.id === id))
}

/** @param operationId Accepted export operation. @returns Its existing deterministic package identity. */
export function profileExportIdentity(operationId: string): ProfileExport['id'] { return brandString<ProfileExport['id']>(identity('profile-export', operationId)) }

/** Export cancellation and progress belong to the caller; observer failures stop dependent work. */
export interface ProfileExportOptions { signal?: AbortSignal; progress?(value: DatasetProgress): Promise<void>; acceptedLaunchId?: string; finalizingAnalysisRunId?: string; sampleScope?: DatasetScope; shareWithLibrary?: boolean }

/** Profile selection has its own revision; analysis and human drafts are never rewritten. */
export class ModelProfiles {
  /** @param domain Owning profile's serialized, authorized record provider. */
  constructor(private readonly domain: CuratorDomain) {}

  /** @param styleId Collection. @param actor Optional profile owner. @param candidates Directory records from the same read, when available. @returns The collection's latest immutable selection, including records created by older Session-scoped versions. */
  current(styleId: string, actor?: DomainActor, candidates?: readonly ModelProfile[]): ModelProfile | undefined {
    if (actor) this.domain.repository.assertProfile(actor.profileId)
    return [...(candidates ?? this.domain.repository.list('modelProfile'))].filter(profile => profile.styleId === styleId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.revision - left.revision || right.id.localeCompare(left.id))[0]
  }

  /** @param profile Frozen model selection. @param actor Authenticated reader. @returns Completion after owner and image access checks. */
  authorize(profile: ModelProfile, actor: DomainActor): void {
    this.domain.repository.readSnapshot(() => {
      this.domain.repository.assertProfile(actor.profileId)
      for (const ref of profile.references) this.domain.authorizedImage(ref.reference.imageVersionId, actor)
    })
  }

  /** @param profile Immutable profile selected by the dataset. @param id Completed full package. @param actor Authorized reader. @returns Verified saved package, independent of the current draft; images remain checked by verifyRelease. */
  authorizeDataset(profile: ModelProfile, id: string, actor: DomainActor): ProfileExport {
    this.authorize(profile, actor)
    const dataset = this.domain.repository.get('profileExport', id)
    if (!dataset) throw new CuratorError('reference-unavailable', 'search-launch-dataset', 'Choose a completed dataset before starting this search.')
    if (dataset.profileId !== actor.profileId) throw new CuratorError('owner-denied', 'search-launch-dataset', 'This dataset belongs to another application profile.')
    if (dataset.sampleScope && dataset.sampleScope !== 'all') throw new CuratorError('constraint-conflict', 'search-launch-dataset', 'Observation-only packages cannot be used as a style-search standard. Choose a complete style package.')
    if (dataset.modelProfileId !== profile.id || dataset.analysisRunId !== profile.analysisRunId) throw new CuratorError('revision-conflict', 'search-launch-dataset', 'Choose a dataset matching the selected profile version.')
    const names = new Set(dataset.files.map(file => file.name))
    if (names.size !== dataset.files.length || ['style-profile.json', 'samples.jsonl', 'references.json', 'SKILL.md', 'manifest.json'].some(name => !names.has(name)) || dataset.files.some(file => file.checksum !== fileChecksum(file.content))) throw new CuratorError('reference-unavailable', 'search-launch-dataset', 'The selected dataset is incomplete or failed checksum verification. Generate a new dataset.')
    let frozen: { modelProfileId: string; analysisRunId: string; contentDigest: string }
    try { frozen = z.object({ formatVersion: z.literal(2), modelProfileId: z.string(), analysisRunId: z.string(), contentDigest: z.string() }).parse(JSON.parse(dataset.files.find(file => file.name === 'style-profile.json')!.content)) }
    catch (cause) { throw new CuratorError('reference-unavailable', 'search-launch-dataset', 'The selected dataset profile cannot be read. Generate a new dataset.', { cause }) }
    if (frozen.modelProfileId !== profile.id || frozen.analysisRunId !== profile.analysisRunId || frozen.contentDigest !== profile.contentDigest) throw new CuratorError('revision-conflict', 'search-launch-dataset', 'The selected dataset does not match the fixed profile.')
    return dataset
  }

  /** @param profile Frozen selection. @param actor Authenticated reader. @param finalizingAnalysisRunId Internal owner Run allowed to seal its saved final analysis; omission requires completion. @returns Completion only for current, complete reference evidence. */
  assertFresh(profile: ModelProfile, actor: DomainActor, finalizingAnalysisRunId?: string): void {
    if (!this.isFresh(profile, actor, finalizingAnalysisRunId)) throw new CuratorError('revision-conflict', 'model-profile', 'The reference images or judgments changed; analyze the current collection again.')
  }

  /** Verify an accepted search against its immutable profile rather than a newer draft.
   * @param profile Exact accepted profile. @param actor Its execution Session. @param launchId Durable owner-authorized launch. @param shareWithLibrary Whether the human launch must explicitly authorize a reusable library package.
   * @returns Completion only when the saved Session and entire profile agree; private references remain checked.
   */
  authorizeAccepted(profile: ModelProfile, actor: DomainActor, launchId: string, shareWithLibrary = false): void {
    const pinned = z.object({ version: z.literal(1), sessionId: z.string(), input: z.object({ operationId: z.string(), modelProfileId: z.string(), autoPrepareDataset: z.boolean().optional() }), spec: z.object({ fixed: z.object({ release: modelProfileSchema }) }) }).safeParse(this.domain.repository.manifest(`search-launch:${launchId}`)?.state)
    if (!pinned.success || actor.kind !== 'agent' || pinned.data.sessionId !== actor.sessionId || pinned.data.input.operationId !== launchId || pinned.data.input.modelProfileId !== profile.id || contentDigest(pinned.data.spec.fixed.release) !== contentDigest(profile)) throw new CuratorError('owner-denied', 'model-profile', 'The frozen profile is not authorized by this Session’s accepted search.')
    if (shareWithLibrary && pinned.data.input.autoPrepareDataset !== true) throw new CuratorError('owner-denied', 'profile-export', 'This launch did not authorize a reusable library package.')
    this.authorize(profile, actor)
  }

  /** @param profile Frozen selection. @param actor Authenticated reader. @param finalizingAnalysisRunId Internal owner Run allowed to seal its saved final analysis; omission requires completion. @returns Whether complete saved evidence still matches current references. */
  isFresh(profile: ModelProfile, actor: DomainActor, finalizingAnalysisRunId?: string): boolean {
    return this.domain.repository.readSnapshot(() => {
      this.authorize(profile, actor)
      const run = this.domain.require('run', profile.analysisRunId), result = styleAnalysisOf(run)
      const finalizing = finalizingAnalysisRunId === run.id && run.stage === 'finalizing' && run.status === 'running' && (run.owner.kind !== 'session' || run.owner.sessionId === actor.sessionId)
      return (run.status === 'completed' && run.outcome === 'target-met' || finalizing) && !!result && this.fresh(result, actor)
    })
  }

  /** Adopt a completed analysis, or its committed finalizing checkpoint inside its owning worker.
   * @param run Saved analysis task. @param actor Its authenticated owner. @param finalizing Trusted worker-only admission.
   * @returns Existing selection or an immutable model version; partial collections have no active rules and outdated analyses remain unadopted.
   */
  async adopt(run: RunRecord, actor: DomainActor, finalizing = false): Promise<ModelProfile | undefined> {
    const analysis = styleAnalysisOf(run)
    if (!analysis || !(run.status === 'completed' && run.outcome === 'target-met' || finalizing && run.status === 'running' && run.stage === 'finalizing') || !this.fresh(analysis, actor)) return undefined
    if (run.owner.kind === 'session' && run.owner.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'model-profile', 'The analysis belongs to another Session.')
    const previous = this.current(analysis.styleId, actor)
    if (previous?.analysisRunId === analysis.runId) { this.authorize(previous, actor); return previous }
    if (previous && this.domain.require('run', previous.analysisRunId).createdAt > run.createdAt) return previous
    const references: ModelProfile['references'] = analysis.samples.map(sample => {
      const { asset } = this.domain.authorizedImage(sample.reference.imageVersionId, actor)
      const feedback = sample.feedbackIds.map(id => this.domain.require('feedback', id))
      return { reference: sample.reference, imageDigest: sample.imageDigest, familyId: asset.familyId, feedbackIds: sample.feedbackIds,
        judgments: feedback.flatMap(item => item.judgment.kind === 'style-verdict' ? [{ feedbackId: item.id, value: item.judgment.value }] : item.judgment.kind === 'dimension-verdict' ? [{ feedbackId: item.id, value: item.judgment.value, dimension: item.judgment.dimension }] : []) }
    })
    const recipe = z.object({ fixed: z.object({ recipe: recipeSchema }) }).parse(run.spec).fixed.recipe
    const expected = this.domain.require('draft', analysis.draftId).referenceIds
    if (expected.some(id => !analysis.samples.some(sample => sample.reference.id === id))) {
      return await this.commit({ styleId: analysis.styleId, draftId: analysis.draftId, draftRevision: analysis.draftRevision, analysisRunId: analysis.runId, referenceDigest: analysis.referenceDigest, model: analysis.model, matchingPrompt: analysis.summary.matchingPrompt, references, recipe, groups: [], options: [] }, previous, `auto-profile:${run.id}`, { analysisRunId: run.id })
    }
    const options: Option[] = [], groups: ModelProfile['groups'] = analysis.summary.organization?.groups.map(group => ({ ...group })) ?? []
    for (const [index, proposed] of analysis.summary.suggestedRules.entries()) {
      const ruleId = identity('auto-rule', { dimension: proposed.dimension, statement: proposed.statement.trim(), condition: proposed.condition, stage: proposed.stage })
      if (options.some(option => option.rule.ruleId === ruleId)) continue
      const rule: Rule = { ruleId, dimension: proposed.dimension, statement: proposed.statement, strength: proposed.strength, stage: proposed.stage,
        condition: proposed.condition.trim() ? { subjects: [proposed.condition] } : {}, exceptions: proposed.exceptions.map(text => ({ subjects: [text] })), check: { kind: 'visual', criterion: proposed.statement },
        supportRefs: [], counterRefs: proposed.counterImageVersionIds.filter(id => !proposed.notApplicableImageVersionIds?.includes(id)).flatMap(id => { const ref = references.find(ref => ref.reference.imageVersionId === id); return ref ? [ref.reference.id] : [] }),
        ...(proposed.notApplicableImageVersionIds ? { notApplicableRefs: proposed.notApplicableImageVersionIds.flatMap(id => references.filter(ref => ref.reference.imageVersionId === id).map(ref => ref.reference.id)) } : {}), confirmation: { status: 'suggested' } }
      const positiveIds = new Set(references.filter(ref => ruleReferenceRole(rule, ref) === 'positive').map(ref => ref.reference.imageVersionId))
      const support = proposed.supportImageVersionIds.filter(id => {
        const ref = references.find(ref => ref.reference.imageVersionId === id)
        return ref !== undefined && ruleReferenceRole(rule, ref) === 'positive'
      })
      rule.supportRefs = support.map(id => references.find(ref => ref.reference.imageVersionId === id)!.reference.id)
      const negativeEvidence = hasNegativeRuleEvidence(rule, references) && support.length === proposed.supportImageVersionIds.length
      if (rule.strength === 'required' && (!negativeEvidence || analysis.summaryPromptVersion === 'visual-curator-summary-v4')) rule.strength = 'preferred'
      const selection = analysis.summary.organization?.selections.find(item => item.ruleIndex === index)
      let groupId = selection?.groupId ?? null
      if (!analysis.summary.organization && support.length && (support.length < positiveIds.size || proposed.condition.trim())) {
        groupId = identity('group', [...support].sort())
        if (!groups.some(group => group.groupId === groupId)) groups.push({ groupId, name: '', description: proposed.condition, imageVersionIds: support })
      }
      const positiveCounter = proposed.counterImageVersionIds.some(id => positiveIds.has(id))
      const subjectOnly = proposed.dimension === 'subject' && !negativeEvidence && !references.some(ref => ref.reference.intent.kind === 'dimensions' && ref.reference.intent.dimensions.includes('subject'))
      const reason: Option['reason'] = !support.length && !negativeEvidence ? 'no-evidence' : positiveCounter ? 'counter-evidence' : subjectOnly ? 'subject-only' : proposed.strength === 'reference-only' || selection?.enabled === false ? 'reference-only' : groupId ? 'conditional' : 'consistent'
      options.push({ rule, groupId, enabled: reason === 'consistent' || reason === 'conditional', selectionSource: 'model', sourceStatement: proposed.statement, reason })
    }
    const draft = this.domain.require('draft', this.domain.require('style', analysis.styleId).draftId)
    for (const rule of draft.rules.filter(rule => rule.confirmation.status === 'confirmed')) if (!options.some(option => option.rule.ruleId === rule.ruleId)) options.unshift({ rule, enabled: true, groupId: null, selectionSource: 'human-rule', sourceStatement: rule.statement, reason: 'user-choice' })
    // 用户的排除与措辞调整跨重新分析保留；失去引用的规则保留可见但不再启用。
    for (const option of previous?.options.filter(option => option.selectionSource === 'user') ?? []) {
      const present = options.findIndex(item => item.rule.ruleId === option.rule.ruleId)
      const supported = hasCurrentRuleEvidence(option.rule, references)
      const retained = { ...option, enabled: option.enabled && supported, groupId: groups.some(group => group.groupId === option.groupId) ? option.groupId : null, reason: supported ? option.reason : 'evidence-changed' as const }
      if (present >= 0) options[present] = retained; else options.push(retained)
    }
    const fields = { styleId: analysis.styleId, draftId: analysis.draftId, draftRevision: analysis.draftRevision, analysisRunId: analysis.runId, referenceDigest: analysis.referenceDigest, model: analysis.model, matchingPrompt: analysis.summary.matchingPrompt, references, recipe, groups, options }
    return await this.commit(fields, previous, `auto-profile:${run.id}`, { analysisRunId: run.id })
  }

  /** @param input Revision-checked selection changes. @param actor Authenticated workbench owner. @returns New immutable selection, or original idempotent receipt. */
  async save(input: z.infer<typeof profileSaveSchema>, actor: DomainActor): Promise<ModelProfile> {
    if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'profile-save', 'Only the authenticated workbench can change adopted rules.')
    const selection = this.domain.repository.readSnapshot(() => {
      const current = this.current(input.styleId, actor)
      const aggregateId = current?.access.kind === 'session-run' ? `model-profiles:${input.styleId}:session:${current.access.sessionId}` : `model-profiles:${input.styleId}`
      const replay = this.domain.repository.manifest(aggregateId)?.receipts[input.operationId]
      if (replay) {
        if (replay.requestDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'profile-save', 'This operation already used different selection changes.')
        const state = z.object({ profileId: z.string() }).parse(replay.state), profile = this.domain.require('modelProfile', state.profileId)
        this.authorize(profile, actor); return { kind: 'replay' as const, profile }
      }
      if (!current || current.id !== input.expectedProfileId || current.analysisRunId !== input.analysisRunId) throw new CuratorError('revision-conflict', 'profile-save', 'Rules changed; refresh the profile before saving.')
      this.assertFresh(current, actor)
      if (new Set(input.changes.map(change => change.ruleId)).size !== input.changes.length || input.changes.some(change => !current.options.some(option => option.rule.ruleId === change.ruleId))) throw new CuratorError('invalid-input', 'profile-save', 'A selection change references an unknown or repeated rule.')
      if (input.changes.some(change => {
        const option = current.options.find(option => option.rule.ruleId === change.ruleId)!
        return change.enabled && option.rule.confirmation.status !== 'confirmed' && !hasCurrentRuleEvidence(option.rule, current.references)
      })) throw new CuratorError('constraint-conflict', 'profile-save', 'This model rule has no current supporting image evidence.')
      const options = current.options.map(option => {
        const change = input.changes.find(change => change.ruleId === option.rule.ruleId)
        if (!change) return option
        const statement = change.statement ?? option.rule.statement
        return { ...option, enabled: change.enabled, selectionSource: 'user' as const, reason: 'user-choice' as const, rule: { ...option.rule, statement, check: { kind: 'visual' as const, criterion: statement }, confirmation: option.rule.confirmation.status === 'confirmed' && statement === option.rule.statement ? option.rule.confirmation : { status: 'suggested' as const } } }
      })
      return { kind: 'save' as const, profile: current, options }
    })
    if (selection.kind === 'replay') return selection.profile
    return await this.commit({ ...selection.profile, options: selection.options }, selection.profile, input.operationId, input)
  }

  /** @param profile Frozen selection. @param operationId Accepted export identity. @param actor Authenticated exporter. @param options Owning cancellation and real work observer. @returns Committed, checksummed reference package; an existing receipt is reused. */
  async export(profile: ModelProfile, operationId: string, actor: DomainActor, options: ProfileExportOptions = {}): Promise<ProfileExport> {
    const sampleScope = options.sampleScope ?? 'all'
    options.signal?.throwIfAborted()
    const report = async (phase: DatasetProgress['phase'], completed: number, total: number, unit: DatasetProgress['unit']) => { options.signal?.throwIfAborted(); await options.progress?.({ phase, completed, total, unit }); options.signal?.throwIfAborted() }
    const id = profileExportIdentity(operationId), existing = this.domain.repository.get('profileExport', id)
    if (existing) {
      this.authorize(profile, actor)
      if (existing.modelProfileId !== profile.id || (existing.sampleScope ?? 'all') !== sampleScope) throw new CuratorError('operation-conflict', 'profile-export', 'The export identity already describes another profile or reference scope.')
      return existing
    }
    const aggregateId = `profile-export:${id}`, request = { profileId: profile.id, operationId, sampleScope }
    const receipt = this.domain.repository.manifest(aggregateId)
    if (receipt) {
      if (receipt.receipts[operationId]?.requestDigest !== contentDigest(request)) throw new CuratorError('operation-conflict', 'profile-export', 'This export request already describes another profile or reference scope.')
      const saved = this.domain.require('profileExport', z.object({ id: z.string() }).parse(receipt.state).id)
      this.authorize(profile, actor)
      return saved
    }
    if (options.shareWithLibrary && (!options.acceptedLaunchId || sampleScope !== 'all')) throw new CuratorError('owner-denied', 'profile-export', 'A reusable automatic complete package requires an accepted human launch.')
    if (options.acceptedLaunchId) this.authorizeAccepted(profile, actor, options.acceptedLaunchId, options.shareWithLibrary)
    else this.assertFresh(profile, actor, options.finalizingAnalysisRunId)
    if (sampleScope === 'all' && !profile.rules.some(isMatchingRule)) throw new CuratorError('constraint-conflict', 'profile-export', 'Enable at least one evidence-backed style rule before exporting.')
    const references = profile.references.filter(ref => sampleScope === 'all' || sampleScope === 'observations' || effectiveReviewReferenceRole(profile, ref) === sampleScope)
    if (!references.length) throw new CuratorError('constraint-conflict', 'profile-export', 'There are no analyzed references in the selected export scope.')
    if (actor.kind === 'agent' && !actor.sessionId) throw new CuratorError('owner-denied', 'profile-export', 'An Agent export requires an owning Session.')
    const removed = removedDatasetIds(this.domain.repository)
    const reusable = this.domain.repository.list('profileExport').filter(record => !removed.exports.has(record.id) && record.modelProfileId === profile.id && (record.sampleScope ?? 'all') === sampleScope).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).find(record => {
      const file = record.files.find(file => file.name === 'style-profile.json')
      if (!file) return false
      if (fileChecksum(file.content) !== file.checksum) throw new CuratorError('reference-unavailable', 'profile-export', 'A saved dataset failed file verification. Restore its files before retrying.')
      let metadata: unknown
      try { metadata = JSON.parse(file.content) }
      catch (cause) { throw new CuratorError('reference-unavailable', 'profile-export', 'A saved dataset profile cannot be read. Restore its files before retrying.', { cause }) }
      return z.object({ generatorVersion: z.literal(3) }).safeParse(metadata).success
    })
    if (reusable) {
      if (reusable.files.some(file => fileChecksum(file.content) !== file.checksum)) throw new CuratorError('reference-unavailable', 'profile-export', 'The reusable dataset failed file verification. Restore its saved files before retrying.')
      await this.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId, request, records: [], state: { id: reusable.id } })
      return reusable
    }
    await report('verifying', 0, profile.references.length, 'references')
    await this.domain.verifyRelease(profile, actor, { ...(options.signal ? { signal: options.signal } : {}), ...(options.acceptedLaunchId ? { acceptedLaunchId: options.acceptedLaunchId } : {}), ...(options.finalizingAnalysisRunId ? { finalizingAnalysisRunId: options.finalizingAnalysisRunId } : {}), verified: (completed, total) => report('verifying', completed, total, 'references') })
    const analysis = styleAnalysisOf(this.domain.require('run', profile.analysisRunId))!
    const referenceIds = new Set(references.map(ref => ref.reference.id)), samples = analysis.samples.filter(sample => referenceIds.has(sample.reference.id))
    const sampleLines: string[] = []
    await report('samples', 0, samples.length, 'samples')
    for (const sample of samples) {
      const observation = this.domain.require('observation', sample.observationId)
      const snapshot = references.find(ref => ref.reference.id === sample.reference.id)!
      const humanReasons = sample.feedbackIds.map(id => this.domain.require('feedback', id)).flatMap(feedback => feedback.comment?.trim() ? [{ source: 'human' as const, ...(feedback.judgment.kind === 'dimension-verdict' ? { dimension: feedback.judgment.dimension } : {}), text: feedback.comment, uncertain: false }] : feedback.reasonCodes.map(text => ({ source: 'human' as const, text, uncertain: false })))
      const modelReasons = (analysis.summary.negativeReasons ?? []).filter(reason => reason.imageVersionId === sample.reference.imageVersionId).map(reason => ({ source: 'model' as const, dimension: reason.dimension, text: reason.reason, uncertain: reason.uncertain }))
      sampleLines.push(JSON.stringify({ formatVersion: 2, source: 'vision-api-observation', referenceId: sample.reference.id, imageVersionId: sample.reference.imageVersionId, imageDigest: sample.imageDigest, importIntent: { role: sample.reference.role, intent: sample.reference.intent }, effectiveRole: effectiveReviewReferenceRole(profile, snapshot), judgments: snapshot.judgments ?? [], reasons: [...humanReasons, ...modelReasons], measured: observation.measured, inferred: observation.inferred, requestIds: [...new Set(observation.inferred.map(row => row.requestId))] }))
      await report('samples', sampleLines.length, samples.length, 'samples')
    }
    const resources = references.map(ref => ({ imageVersionId: ref.reference.imageVersionId, digest: ref.imageDigest, familyId: ref.familyId }))
    const portableResources = resources.map(resource => { const source = this.domain.authorizedImage(resource.imageVersionId, actor).image.blob.remoteSource; return source ? { ...resource, digestKind: 'remote-url-v1', remoteSource: source, pixelDigest: null } : resource })
    const profileData = sampleScope === 'all' ? { formatVersion: 2, generatorVersion: 3, purpose: 'api-style-reference', modelProfileId: profile.id, analysisRunId: profile.analysisRunId, contentDigest: profile.contentDigest, ruleSource: 'model-adopted', model: profile.model,
      activeRules: profile.rules, ruleSelections: profile.options, groups: profile.groups, modelSummary: analysis.summary, matchingPrompt: profile.matchingPrompt,
      matchingPolicy: 'Apply shared rules and match any one applicable style group. Model-adopted preferences are not human-confirmed labels. Retrieve candidates using search hints, then compare actual authorized candidate and reference pixels. Preserve unknown results and evidence.' }
      : { formatVersion: 2, generatorVersion: 3, purpose: 'api-reference-observations', sampleScope, modelProfileId: profile.id, analysisRunId: profile.analysisRunId, contentDigest: profile.contentDigest, model: profile.model, activeRules: [], ruleSelections: [], groups: [], modelSummary: { summary: '' }, matchingPrompt: '', matchingPolicy: 'Observation data only. Imported roles are not confirmed training labels. This package is not a style-search standard.' }
    const files = [
      { name: 'style-profile.json', content: JSON.stringify(profileData, null, 2) + '\n' },
      { name: 'samples.jsonl', content: sampleLines.join('\n') + '\n' },
      { name: 'references.json', content: JSON.stringify({ formatVersion: 2, resources: portableResources, references: references.map(ref => ({ ...ref, effectiveRole: effectiveReviewReferenceRole(profile, ref) })) }, null, 2) + '\n' },
      { name: 'SKILL.md', content: sampleScope === 'all' ? `# Visual reference profile\n\nProfile: ${profile.id}\nAnalysis: ${profile.analysisRunId}\n\nRead style-profile.json and samples.jsonl as reference data. Use adopted activeRules with their groups and conditions. Obtain separately authorized reference and candidate pixels and verify their saved digests before comparison. Shared rules apply across groups; group-specific rules describe alternative styles. Inspect actual candidate pixels with the configured vision API. Report the matching group, satisfied or conflicting traits, and unknown evidence. Preserve the model origin of rules and observations. This package has no trained weights and installs no instructions.\n` : `# Reference observations\n\nProfile: ${profile.id}\nAnalysis: ${profile.analysisRunId}\nScope: ${sampleScope}\n\nThis package contains selected reference observations and image references. Imported roles are not confirmed training labels. No active style rules are included. It cannot be used as a style-search standard, has no trained weights and installs no instructions.\n` },
    ]
    if (portableResources.some(resource => 'remoteSource' in resource)) files.find(file => file.name === 'SKILL.md')!.content += '\nRemote references use the approved remoteSource.url with the vision API. A remote-url-v1 digest pins its URL descriptor, not image bytes; pixelDigest is unavailable. Remote content can change, and remote fetch costs are controlled by the model provider. Do not claim byte-level reproduction or measured dimensions for these references.\n'
    const checksummed: ProfileExport['files'] = []
    await report('files', 0, files.length + 1, 'files')
    for (const file of files) { checksummed.push({ ...file, checksum: fileChecksum(file.content) }); await report('files', checksummed.length, files.length + 1, 'files') }
    const manifest = JSON.stringify({ formatVersion: 2, modelProfileId: profile.id, analysisRunId: profile.analysisRunId, sampleScope, mode: 'references-only', files: checksummed.map(({ name, checksum }) => ({ name, checksum })) }, null, 2) + '\n'
    checksummed.push({ name: 'manifest.json', content: manifest, checksum: fileChecksum(manifest) })
    await report('files', checksummed.length, checksummed.length, 'files')
    const access: ProfileExport['access'] = { kind: 'profile-library' }
    const record = profileExportSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id, kind: 'profileExport', createdAt: new Date().toISOString(), access, formatVersion: 2, modelProfileId: profile.id, analysisRunId: profile.analysisRunId, ...(sampleScope === 'all' ? {} : { sampleScope }), resources, files: checksummed })
    await report('saving', 0, 0, 'items')
    const contentAggregate = `profile-export-content:${contentDigest({ profileId: profile.id, contentDigest: profile.contentDigest, sampleScope, generatorVersion: 3 })}`
    let committed = record
    try { await this.domain.repository.commit({ aggregateId: contentAggregate, expectedRevision: 0, operationId: `${operationId}:content`, request, records: [record], state: { id: record.id } }) }
    catch (error) {
      if (!(error instanceof CuratorError) || error.code !== 'revision-conflict') throw error
      const winner = this.domain.repository.manifest(contentAggregate)
      if (!winner) throw error
      committed = this.domain.require('profileExport', z.object({ id: z.string() }).parse(winner.state).id)
    }
    if (committed.id !== id) await this.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId, request, records: [], state: { id: committed.id } })
    return this.domain.require('profileExport', committed.id)
  }

  private fresh(analysis: StyleAnalysis, actor: DomainActor): boolean {
    const style = this.domain.require('style', analysis.styleId), draft = this.domain.require('draft', style.draftId)
    if (style.archived) return false
    const references = draft.referenceIds.map(id => this.domain.require('reference', id)), threads = new Set(references.flatMap(ref => ref.feedbackThreadIds))
    const feedback = this.domain.currentFeedback(actor).filter(item => item.context.styleId === style.id && item.scope === 'style-candidate' && (threads.has(item.threadId) || draft.feedbackIds.includes(item.id)))
    return analysis.referenceDigest === analysisReferenceDigest(references, feedback.map(item => item.id))
  }

  private async commit(fields: Pick<ModelProfile, 'styleId' | 'draftId' | 'draftRevision' | 'analysisRunId' | 'referenceDigest' | 'model' | 'matchingPrompt' | 'references' | 'recipe' | 'groups' | 'options'>, previous: ModelProfile | undefined, operationId: string, request: unknown): Promise<ModelProfile> {
    const aggregateId = `model-profiles:${fields.styleId}`, revision = this.domain.repository.manifest(aggregateId)?.revision ?? 0
    const access: ModelProfile['access'] = { kind: 'profile-library' }
    const rules = fields.options.filter(option => option.enabled).map(option => option.rule)
    const content = { styleId: fields.styleId, draftId: fields.draftId, draftRevision: fields.draftRevision, analysisRunId: fields.analysisRunId, referenceDigest: fields.referenceDigest, model: fields.model, matchingPrompt: fields.matchingPrompt, references: fields.references, recipe: fields.recipe, groups: fields.groups, options: fields.options, rules }
    const record = modelProfileSchema.parse({ schemaVersion: 1, profileId: this.domain.profileId, id: identity('model-profile', { operationId, content }), kind: 'modelProfile', createdAt: new Date().toISOString(), ...content, access, revision: revision + 1, contentDigest: contentDigest(content), ...(previous ? { previousProfileId: previous.id } : {}) })
    await this.domain.repository.commit({ aggregateId, expectedRevision: revision, operationId, request, records: [record], state: { profileId: record.id } })
    return this.domain.require('modelProfile', record.id)
  }
}
