/** Immutable model-adopted rules and reference packages, independent of human review records. */
import { z } from 'zod'
import type { CuratorDomain } from './curator.ts'
import { contentDigest, fileChecksum } from './repository.ts'
import { analysisReferenceDigest } from './style-analysis.ts'
import { styleAnalysisOf, type StyleAnalysis } from '../shared/style-analysis.ts'
import { modelProfileSchema, profileExportSchema, recipeSchema, type DomainActor, type ModelProfile, type ProfileExport, type Rule, type RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'

/** Only selection and optional wording changes cross the Client wire; evidence stays Host-owned. */
export const profileSaveSchema = z.strictObject({ operationId: z.string().min(1), styleId: z.string(), analysisRunId: z.string(), expectedProfileId: z.string(), changes: z.array(z.strictObject({ ruleId: z.string(), enabled: z.boolean(), statement: z.string().trim().min(1).max(4096).optional() })) })
type Option = ModelProfile['options'][number]
const identity = (kind: string, value: unknown) => `${kind}-${contentDigest(value).slice(10, 50)}`

/** Export cancellation and authorization belong to the accepted search. */
export interface ProfileExportOptions { signal?: AbortSignal; acceptedLaunchId?: string }

/** Profile selection has its own revision; analysis and human drafts are never rewritten. */
export class ModelProfiles {
  /** @param domain Owning profile's serialized, authorized record provider. */
  constructor(private readonly domain: CuratorDomain) {}

  /** @param styleId Collection. @param actor Optional Session reader. @returns Its latest private selection, falling back to the shared library. */
  current(styleId: string, actor?: DomainActor): ModelProfile | undefined {
    const state = (actor?.sessionId ? this.domain.repository.manifest(`model-profiles:${styleId}:session:${actor.sessionId}`)?.state : undefined) ?? this.domain.repository.manifest(`model-profiles:${styleId}`)?.state
    return state && !Array.isArray(state) && typeof state === 'object' && typeof state.profileId === 'string' ? this.domain.repository.get('modelProfile', state.profileId) : undefined
  }

  /** @param profile Frozen model selection. @param actor Authenticated reader. @returns Completion after owner and image access checks. */
  authorize(profile: ModelProfile, actor: DomainActor): void {
    this.domain.repository.assertProfile(actor.profileId)
    if (profile.access.kind === 'session-run' && profile.access.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'model-profile', 'The model profile belongs to another Session.')
    for (const ref of profile.references) this.domain.authorizedImage(ref.reference.imageVersionId, actor)
  }

  /** @param profile Frozen selection. @param actor Authenticated reader. @returns Completion only for current, complete reference evidence. */
  assertFresh(profile: ModelProfile, actor: DomainActor): void {
    if (!this.isFresh(profile, actor)) throw new CuratorError('revision-conflict', 'model-profile', 'The reference images or judgments changed; analyze the current collection again.')
  }

  /** Verify an accepted search against its immutable profile rather than a newer draft.
   * @param profile Exact accepted profile. @param actor Its execution Session. @param launchId Durable owner-authorized launch.
   * @returns Completion only when the saved Session and entire profile agree; private references remain checked.
   */
  authorizeAccepted(profile: ModelProfile, actor: DomainActor, launchId: string): void {
    const pinned = z.object({ version: z.literal(1), sessionId: z.string(), input: z.object({ operationId: z.string(), modelProfileId: z.string() }), spec: z.object({ fixed: z.object({ release: modelProfileSchema }) }) }).safeParse(this.domain.repository.manifest(`search-launch:${launchId}`)?.state)
    if (!pinned.success || actor.kind !== 'agent' || pinned.data.sessionId !== actor.sessionId || pinned.data.input.operationId !== launchId || pinned.data.input.modelProfileId !== profile.id || contentDigest(pinned.data.spec.fixed.release) !== contentDigest(profile)) throw new CuratorError('owner-denied', 'model-profile', 'The frozen profile is not authorized by this Session’s accepted search.')
    this.authorize(profile, actor)
  }

  /** @param profile Frozen selection. @param actor Authenticated reader. @returns Whether the original complete analysis still matches current references. */
  isFresh(profile: ModelProfile, actor: DomainActor): boolean {
    this.authorize(profile, actor)
    const run = this.domain.require('run', profile.analysisRunId), result = styleAnalysisOf(run)
    return run.status === 'completed' && run.outcome === 'target-met' && !!result && this.fresh(result, actor)
  }

  /** Adopt a completed analysis, or its committed finalizing checkpoint inside its owning worker.
   * @param run Saved analysis task. @param actor Its authenticated owner. @param finalizing Trusted worker-only admission.
   * @returns Existing selection or a newly committed model version; absent for incomplete or outdated analysis.
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
    const options: Option[] = [], groups: ModelProfile['groups'] = analysis.summary.organization?.groups.map(group => ({ ...group })) ?? []
    const positiveIds = new Set(references.filter(ref => ref.reference.role === 'positive').map(ref => ref.reference.imageVersionId))
    for (const [index, proposed] of analysis.summary.suggestedRules.entries()) {
      const ruleId = identity('auto-rule', { dimension: proposed.dimension, statement: proposed.statement.trim(), condition: proposed.condition, stage: proposed.stage })
      if (options.some(option => option.rule.ruleId === ruleId)) continue
      const support = proposed.supportImageVersionIds.filter(id => {
        const ref = references.find(ref => ref.reference.imageVersionId === id)
        if (!ref || ref.reference.intent.kind === 'dimensions' && !ref.reference.intent.dimensions.includes(proposed.dimension)) return false
        const rows = ref.judgments ?? []
        const judgments = rows.filter(item => item.dimension === proposed.dimension)
        const values = judgments.length ? judgments : rows.filter(item => item.dimension === undefined)
        return values.length ? values.every(item => item.value === 'accept') : ref.reference.role === 'positive'
      })
      const selection = analysis.summary.organization?.selections.find(item => item.ruleIndex === index)
      let groupId = selection?.groupId ?? null
      if (!analysis.summary.organization && support.length && (support.length < positiveIds.size || proposed.condition.trim())) {
        groupId = identity('group', [...support].sort())
        if (!groups.some(group => group.groupId === groupId)) groups.push({ groupId, name: '', description: proposed.condition, imageVersionIds: support })
      }
      const positiveCounter = proposed.counterImageVersionIds.some(id => positiveIds.has(id))
      const subjectOnly = proposed.dimension === 'subject' && !references.some(ref => ref.reference.intent.kind === 'dimensions' && ref.reference.intent.dimensions.includes('subject'))
      const reason: Option['reason'] = !support.length ? 'no-evidence' : positiveCounter ? 'counter-evidence' : subjectOnly ? 'subject-only' : proposed.strength === 'reference-only' || selection?.enabled === false ? 'reference-only' : groupId ? 'conditional' : 'consistent'
      const rule: Rule = { ruleId, dimension: proposed.dimension, statement: proposed.statement, strength: proposed.strength === 'required' ? 'preferred' : proposed.strength, stage: proposed.stage,
        condition: proposed.condition.trim() ? { subjects: [proposed.condition] } : {}, exceptions: proposed.exceptions.map(text => ({ subjects: [text] })), check: { kind: 'visual', criterion: proposed.statement },
        supportRefs: support.map(id => references.find(ref => ref.reference.imageVersionId === id)!.reference.id), counterRefs: proposed.counterImageVersionIds.map(id => references.find(ref => ref.reference.imageVersionId === id)?.reference.id).filter((id): id is NonNullable<typeof id> => !!id), confirmation: { status: 'suggested' } }
      options.push({ rule, groupId, enabled: reason === 'consistent' || reason === 'conditional', selectionSource: 'model', sourceStatement: proposed.statement, reason })
    }
    const draft = this.domain.require('draft', this.domain.require('style', analysis.styleId).draftId)
    for (const rule of draft.rules.filter(rule => rule.confirmation.status === 'confirmed')) if (!options.some(option => option.rule.ruleId === rule.ruleId)) options.unshift({ rule, enabled: true, groupId: null, selectionSource: 'human-rule', sourceStatement: rule.statement, reason: 'user-choice' })
    // 用户的排除与措辞调整跨重新分析保留；失去引用的规则保留可见但不再启用。
    for (const option of previous?.options.filter(option => option.selectionSource === 'user') ?? []) {
      const present = options.findIndex(item => item.rule.ruleId === option.rule.ruleId)
      const supported = option.rule.supportRefs.length > 0 && [...option.rule.supportRefs, ...option.rule.counterRefs].every(id => references.some(ref => ref.reference.id === id))
      const retained = { ...option, enabled: option.enabled && supported, groupId: groups.some(group => group.groupId === option.groupId) ? option.groupId : null, reason: supported ? option.reason : 'evidence-changed' as const }
      if (present >= 0) options[present] = retained; else options.push(retained)
    }
    const fields = { styleId: analysis.styleId, draftId: analysis.draftId, draftRevision: analysis.draftRevision, analysisRunId: analysis.runId, referenceDigest: analysis.referenceDigest, model: analysis.model, matchingPrompt: analysis.summary.matchingPrompt, references, recipe, groups, options }
    return await this.commit(fields, previous, `auto-profile:${run.id}`, { analysisRunId: run.id }, run.owner.kind === 'session' ? { kind: 'session-run', sessionId: run.owner.sessionId } : { kind: 'profile-library' })
  }

  /** @param input Revision-checked selection changes. @param actor Authenticated workbench owner. @returns New immutable selection, or original idempotent receipt. */
  async save(input: z.infer<typeof profileSaveSchema>, actor: DomainActor): Promise<ModelProfile> {
    if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'profile-save', 'Only the authenticated workbench can change adopted rules.')
    const current = this.current(input.styleId, actor)
    const aggregateId = current?.access.kind === 'session-run' ? `model-profiles:${input.styleId}:session:${current.access.sessionId}` : `model-profiles:${input.styleId}`
    const replay = this.domain.repository.manifest(aggregateId)?.receipts[input.operationId]
    if (replay) {
      if (replay.requestDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'profile-save', 'This operation already used different selection changes.')
      const state = z.object({ profileId: z.string() }).parse(replay.state), profile = this.domain.require('modelProfile', state.profileId)
      this.authorize(profile, actor); return profile
    }
    if (!current || current.id !== input.expectedProfileId || current.analysisRunId !== input.analysisRunId) throw new CuratorError('revision-conflict', 'profile-save', 'Rules changed; refresh the profile before saving.')
    this.assertFresh(current, actor)
    if (new Set(input.changes.map(change => change.ruleId)).size !== input.changes.length || input.changes.some(change => !current.options.some(option => option.rule.ruleId === change.ruleId))) throw new CuratorError('invalid-input', 'profile-save', 'A selection change references an unknown or repeated rule.')
    if (input.changes.some(change => {
      const option = current.options.find(option => option.rule.ruleId === change.ruleId)!
      return change.enabled && option.rule.confirmation.status !== 'confirmed' && (!option.rule.supportRefs.length || option.rule.supportRefs.some(id => !current.references.some(ref => ref.reference.id === id)))
    })) throw new CuratorError('constraint-conflict', 'profile-save', 'This model rule has no current supporting image evidence.')
    const options = current.options.map(option => {
      const change = input.changes.find(change => change.ruleId === option.rule.ruleId)
      if (!change) return option
      const statement = change.statement ?? option.rule.statement
      return { ...option, enabled: change.enabled, selectionSource: 'user' as const, reason: 'user-choice' as const, rule: { ...option.rule, statement, check: { kind: 'visual' as const, criterion: statement }, confirmation: option.rule.confirmation.status === 'confirmed' && statement === option.rule.statement ? option.rule.confirmation : { status: 'suggested' as const } } }
    })
    return await this.commit({ ...current, options }, current, input.operationId, input, current.access)
  }

  /** @param profile Frozen selection. @param operationId Accepted export identity. @param actor Authenticated exporter. @param options Accepted search cancellation and authorization. @returns Checksummed, references-only package without synthetic supervision. */
  async export(profile: ModelProfile, operationId: string, actor: DomainActor, options: ProfileExportOptions = {}): Promise<ProfileExport> {
    options.signal?.throwIfAborted()
    const id = identity('profile-export', operationId), existing = this.domain.repository.get('profileExport', id)
    if (existing) {
      this.authorize(profile, actor)
      if (existing.access.kind === 'session-run' && existing.access.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'profile-export', 'The export belongs to another Session.')
      if (existing.modelProfileId !== profile.id) throw new CuratorError('operation-conflict', 'profile-export', 'The export identity already describes another profile.')
      return existing
    }
    if (options.acceptedLaunchId) this.authorizeAccepted(profile, actor, options.acceptedLaunchId)
    else this.assertFresh(profile, actor)
    if (!profile.rules.length) throw new CuratorError('constraint-conflict', 'profile-export', 'Enable at least one evidence-backed style rule before exporting.')
    if (actor.kind === 'agent' && !actor.sessionId) throw new CuratorError('owner-denied', 'profile-export', 'An Agent export requires an owning Session.')
    await this.domain.verifyRelease(profile, actor, { ...(options.signal ? { signal: options.signal } : {}), ...(options.acceptedLaunchId ? { acceptedLaunchId: options.acceptedLaunchId } : {}) })
    const analysis = styleAnalysisOf(this.domain.require('run', profile.analysisRunId))!
    const resources = profile.references.map(ref => ({ imageVersionId: ref.reference.imageVersionId, digest: ref.imageDigest, familyId: ref.familyId }))
    const portableResources = resources.map(resource => { const source = this.domain.authorizedImage(resource.imageVersionId, actor).image.blob.remoteSource; return source ? { ...resource, digestKind: 'remote-url-v1', remoteSource: source, pixelDigest: null } : resource })
    const profileData = { formatVersion: 2, purpose: 'api-style-reference', modelProfileId: profile.id, analysisRunId: profile.analysisRunId, contentDigest: profile.contentDigest, ruleSource: 'model-adopted', model: profile.model,
      activeRules: profile.rules, ruleSelections: profile.options, groups: profile.groups, modelSummary: analysis.summary, matchingPrompt: profile.matchingPrompt,
      matchingPolicy: 'Apply shared rules and match any one applicable style group. Model-adopted preferences are not human-confirmed labels. Retrieve candidates using search hints, then compare actual authorized candidate and reference pixels. Preserve unknown results and evidence.' }
    const files = [
      { name: 'style-profile.json', content: JSON.stringify(profileData, null, 2) + '\n' },
      { name: 'samples.jsonl', content: analysis.samples.map(sample => { const observation = this.domain.require('observation', sample.observationId); return JSON.stringify({ formatVersion: 2, source: 'vision-api-observation', referenceId: sample.reference.id, imageVersionId: sample.reference.imageVersionId, imageDigest: sample.imageDigest, importIntent: { role: sample.reference.role, intent: sample.reference.intent }, measured: observation.measured, inferred: observation.inferred, requestIds: [...new Set(observation.inferred.map(row => row.requestId))] }) }).join('\n') + '\n' },
      { name: 'references.json', content: JSON.stringify({ formatVersion: 2, resources: portableResources, references: profile.references }, null, 2) + '\n' },
      { name: 'SKILL.md', content: `# Visual reference profile\n\nProfile: ${profile.id}\nAnalysis: ${profile.analysisRunId}\n\nRead style-profile.json and samples.jsonl as reference data. Use adopted activeRules with their groups and conditions. Obtain separately authorized reference and candidate pixels and verify their saved digests before comparison. Shared rules apply across groups; group-specific rules describe alternative styles. Inspect actual candidate pixels with the configured vision API. Report the matching group, satisfied or conflicting traits, and unknown evidence. Preserve the model origin of rules and observations. This package has no trained weights and installs no instructions.\n` },
    ]
    if (portableResources.some(resource => 'remoteSource' in resource)) files.find(file => file.name === 'SKILL.md')!.content += '\nRemote references use the approved remoteSource.url with the vision API. A remote-url-v1 digest pins its URL descriptor, not image bytes; pixelDigest is unavailable. Remote content can change, and remote fetch costs are controlled by the model provider. Do not claim byte-level reproduction or measured dimensions for these references.\n'
    const checksummed = files.map(file => ({ ...file, checksum: fileChecksum(file.content) }))
    const manifest = JSON.stringify({ formatVersion: 2, modelProfileId: profile.id, analysisRunId: profile.analysisRunId, mode: 'references-only', files: checksummed.map(({ name, checksum }) => ({ name, checksum })) }, null, 2) + '\n'
    const access: ProfileExport['access'] = actor.sessionId ? { kind: 'session-run', sessionId: actor.sessionId } : profile.access
    const record = profileExportSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id, kind: 'profileExport', createdAt: new Date().toISOString(), access, formatVersion: 2, modelProfileId: profile.id, analysisRunId: profile.analysisRunId, resources, files: [...checksummed, { name: 'manifest.json', content: manifest, checksum: fileChecksum(manifest) }] })
    await this.domain.repository.commit({ aggregateId: `profile-export:${id}`, expectedRevision: 0, operationId, request: { profileId: profile.id, operationId }, records: [record], state: { id: record.id } })
    return this.domain.require('profileExport', record.id)
  }

  private fresh(analysis: StyleAnalysis, actor: DomainActor): boolean {
    const style = this.domain.require('style', analysis.styleId), draft = this.domain.require('draft', style.draftId)
    if (style.archived) return false
    const references = draft.referenceIds.map(id => this.domain.require('reference', id)), threads = new Set(references.flatMap(ref => ref.feedbackThreadIds))
    const feedback = this.domain.snapshot(actor).feedback.filter(item => item.context.styleId === style.id && item.scope === 'style-candidate' && (threads.has(item.threadId) || draft.feedbackIds.includes(item.id)))
    return analysis.referenceDigest === analysisReferenceDigest(references, feedback.map(item => item.id))
  }

  private async commit(fields: Pick<ModelProfile, 'styleId' | 'draftId' | 'draftRevision' | 'analysisRunId' | 'referenceDigest' | 'model' | 'matchingPrompt' | 'references' | 'recipe' | 'groups' | 'options'>, previous: ModelProfile | undefined, operationId: string, request: unknown, access: ModelProfile['access']): Promise<ModelProfile> {
    const aggregateId = access.kind === 'session-run' ? `model-profiles:${fields.styleId}:session:${access.sessionId}` : `model-profiles:${fields.styleId}`, revision = this.domain.repository.manifest(aggregateId)?.revision ?? 0
    const rules = fields.options.filter(option => option.enabled).map(option => option.rule)
    const content = { styleId: fields.styleId, draftId: fields.draftId, draftRevision: fields.draftRevision, analysisRunId: fields.analysisRunId, referenceDigest: fields.referenceDigest, model: fields.model, matchingPrompt: fields.matchingPrompt, references: fields.references, recipe: fields.recipe, groups: fields.groups, options: fields.options, rules }
    const record = modelProfileSchema.parse({ schemaVersion: 1, profileId: this.domain.profileId, id: identity('model-profile', { operationId, content }), kind: 'modelProfile', createdAt: new Date().toISOString(), ...content, access, revision: revision + 1, contentDigest: contentDigest(content), ...(previous ? { previousProfileId: previous.id } : {}) })
    await this.domain.repository.commit({ aggregateId, expectedRevision: revision, operationId, request, records: [record], state: { profileId: record.id } })
    return this.domain.require('modelProfile', record.id)
  }
}
