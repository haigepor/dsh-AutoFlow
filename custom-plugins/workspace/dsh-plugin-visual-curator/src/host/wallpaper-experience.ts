/** Profile-private case evidence and evaluated Skill revisions; no global instructions or weights are changed. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { DomainActor, RunRecord } from '../shared/model.ts'
import { wallpaperExperienceSchema, wallpaperDistillationSchema, wallpaperStateSchema, wallpaperPromptBundleSchema, type WallpaperExperience, type WallpaperState } from '../shared/wallpaper.ts'
import { wallpaperBaseSkill, wallpaperPromptBundle } from '../shared/wallpaper-prompts.ts'
import type { CuratorConfig } from './config.ts'
import { executionSchema, specOf, dataOf, toJson, type RunEngine, type Worker, type WorkContext } from './runtime.ts'
import type { StructuredVisionProvider, VisionInput } from '../media/index.ts'
import { visionBounds } from './providers.ts'
import { CuratorError } from '../shared/errors.ts'

type Case = WallpaperExperience['cases'][number]
/** Real replay uses the existing source and any exactly reusable output; it never generates new image bytes. */
export interface WallpaperLearningDependencies {
  domain: CuratorDomain; engine: RunEngine; config(): CuratorConfig
  vision(config: CuratorConfig): Promise<StructuredVisionProvider>
  evaluate(ctx: WorkContext, sample: Case, content: string, variant: number): Promise<{ verdict: 'pass' | 'reject' | 'needs-review'; rounds: number; needsGeneration: boolean }>
}

const aggregateId = 'wallpaper-experience:v1'
/** Append-only manifests keep prior catalogs recoverable while the current pointer selects one revision. */
export class WallpaperExperienceStore {
  private updates: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  constructor(private readonly deps: WallpaperLearningDependencies) {}

  /**
   * @returns Validated current catalog or the bundled starting Skill before any case exists.
   */
  read(): WallpaperExperience {
    const saved = this.deps.domain.repository.manifest(aggregateId)
    if (saved) {
      const state = wallpaperExperienceSchema.parse(saved.state)
      return { ...state, cases: state.cases.map(row => ({ ...row, familyId: this.deps.domain.familyOf(row.familyId) })), distilledFamilyIds: [...new Set(state.distilledFamilyIds.map(id => this.deps.domain.familyOf(id)))] }
    }
    return { version: 1, cases: [], active: 'bundled-v1', autoPromote: this.deps.config().wallpaper.autoPromote, lastDistilledCount: 0, distilledFamilyIds: [], versions: [{ id: 'bundled-v1', content: wallpaperBaseSkill, createdAt: '2026-11-05T00:00:00.000Z', status: 'active', reason: 'bundled-starting-guidance', caseIds: [] }] }
  }
  /**
   * @returns Bounded active content frozen by each newly accepted wallpaper task.
   */
  skill(): { id: string; content: string } { const state = this.read(), version = state.versions.find(row => row.id === state.active)!; return { id: version.id, content: version.content } }
  /**
   * @param listener Native catalog refresh.
   * @returns Subscription disposer.
   */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(change: (state: WallpaperExperience) => void): Promise<void> {
    const work = this.updates.then(async () => {
      const state = this.read(); change(state)
      wallpaperExperienceSchema.parse(state)
      const previous = this.deps.domain.repository.manifest(aggregateId), operationId = contentDigest(state)
      if (previous && contentDigest(previous.state) === operationId) return
      await this.deps.domain.repository.commit({ aggregateId, expectedRevision: previous?.revision ?? 0, operationId, request: toJson(state), records: [], state: toJson(state) })
      for (const listener of this.listeners) listener()
    })
    this.updates = work.then(() => {}, () => {}); return work
  }

  /** Preserve inferred outcomes separately from later explicit human benchmark decisions.
   * @param run Completed execution.
   * @param wallpaper Actual per-source results.
   * @returns Durable case capture and optional bounded learning admission.
   */
  async record(run: RunRecord, wallpaper: WallpaperState): Promise<void> {
    await this.update(state => {
      for (const item of wallpaper.items) {
        const id = contentDigest({ runId: run.id, imageVersionId: item.imageVersionId }).slice(10)
        if (state.cases.some(row => row.id === id) || !item.attempts.length) continue
        state.cases.push({ id, familyId: item.familyId, runId: run.id, imageVersionId: item.imageVersionId, mode: item.attempts.at(-1)!.plan.mode, passed: item.status === 'passed', rounds: item.attempts.length, needsGeneration: item.attempts.some(row => row.needsOutpaint), reason: item.reason ?? item.status, learningEligible: item.status === 'passed' || item.attempts.some(row => row.review || row.checks.length), benchmark: false })
      }
    })
    await this.schedule()
  }

  /** Apply authenticated benchmark labels or choose a previously evaluated Skill revision.
   * @param raw Explicit owner action.
   * @param actor Authenticated human; model callers cannot create benchmark truth.
   * @returns Current catalog.
   */
  async action(raw: unknown, actor: DomainActor): Promise<WallpaperExperience> {
    if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'wallpaper-experience', 'Only the authenticated owner can confirm benchmark expectations or change the active Skill.')
    const input = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('benchmark'), caseId: z.string(), expectedPass: z.boolean() }), z.strictObject({ kind: z.literal('auto'), enabled: z.boolean() }), z.strictObject({ kind: z.literal('activate'), versionId: z.string() })]).parse(raw)
    await this.update(state => {
      if (input.kind === 'auto') state.autoPromote = input.enabled
      else if (input.kind === 'benchmark') {
        const sample = state.cases.find(row => row.id === input.caseId)
        if (!sample) throw new CuratorError('reference-unavailable', 'wallpaper-benchmark', 'This case is unavailable.')
        sample.benchmark = true; sample.expectedPass = input.expectedPass; sample.confirmedBy = actor.id; sample.confirmedAt = new Date().toISOString()
      } else {
        const target = state.versions.find(row => row.id === input.versionId)
        if (!target || !['verified', 'active', 'retired'].includes(target.status)) throw new CuratorError('constraint-conflict', 'wallpaper-skill', 'Only a verified or previously active Skill can be selected.')
        for (const version of state.versions) if (version.status === 'active') version.status = 'retired'
        target.status = 'active'; state.active = target.id
      }
    })
    await this.schedule(); return this.read()
  }

  private async schedule(): Promise<void> {
    const state = this.read(), config = this.deps.config(), families = new Set(state.cases.map(row => row.familyId)).size
    const holdout = new Set(state.cases.filter(row => row.benchmark).map(row => row.familyId)), used = new Set(state.distilledFamilyIds)
    const trainingByFamily = new Map<string, Case>()
    for (const row of state.cases.slice().reverse()) if (row.learningEligible && !holdout.has(row.familyId) && !trainingByFamily.has(row.familyId)) trainingByFamily.set(row.familyId, row)
    const training = [...trainingByFamily.values()]
    const fresh = training.filter(row => !used.has(row.familyId)), distill = fresh.length >= config.wallpaper.learningInterval
    if (!config.wallpaper.learningEnabled || this.deps.domain.repository.list('run').some(run => specOf(run).fixed.wallpaperLearning === true && ['created', 'running', 'pausing', 'paused', 'interrupted'].includes(run.status))) return
    const candidate = distill ? undefined : state.versions.slice().reverse().find(row => row.status === 'pending-evidence' && row.reason !== 'requires-new-generation' && row.reason !== 'benchmark-overlap')
    if (!distill && (!candidate || holdout.size < config.wallpaper.minBenchmarks)) return
    const chosen = (distill ? fresh : training).slice(0, config.wallpaper.learningInterval), benchmarks = state.cases.filter(row => row.benchmark).sort((a, b) => (a.confirmedAt ?? '').localeCompare(b.confirmedAt ?? ''))
    const input = { workflow: 'wallpaper-learning-v1', activeVersion: state.active, caseIds: chosen.map(row => row.id), caseEvidence: distill ? chosen.map(row => this.caseEvidence(row)) : [], benchmarks, candidateId: candidate?.id ?? null, families }
    const frozen = { ...config, limits: { ...config.limits, maxVisionCalls: config.wallpaper.maxEvalVisionCalls } }, prompts = wallpaperPromptBundle(), fixed = { wallpaperLearning: true, baseSkill: wallpaperBaseSkill, prompts: toJson(prompts), promptDigest: contentDigest(prompts) }, operationId = `wallpaper-learning:${contentDigest({ input, config: frozen }).slice(10)}`
    const spec = executionSchema.parse({ kind: 'evaluate', config: frozen, input, fixed, specDigest: contentDigest({ kind: 'evaluate', config: frozen, input, fixed }) })
    await this.deps.engine.create(spec, { kind: 'human', id: 'wallpaper-experience', profileId: this.deps.domain.profileId }, this.worker(), operationId)
  }

  /** Schedule pending verification after distillation has released its independent Run budget.
   * @returns Completion after any eligible evaluation has been admitted.
   */
  async processPending(): Promise<void> { await this.schedule() }

  private caseEvidence(sample: Case) {
    const run = this.deps.domain.require('run', sample.runId), spec = specOf(run), state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper)
    const item = state.items.find(row => row.imageVersionId === sample.imageVersionId)!, source = this.deps.domain.require('imageVersion', item.originalId ?? item.imageVersionId), asset = this.deps.domain.require('asset', source.assetId)
    const ids = new Set([item.imageVersionId, item.originalId, ...item.attempts.map(row => row.outputId)])
    const human = this.deps.domain.currentFeedback({ kind: 'human', id: 'wallpaper-experience', profileId: run.profileId, ...(typeof spec.fixed.sourceSessionId === 'string' ? { sessionId: spec.fixed.sourceSessionId } : {}) }).filter(row => row.context.runId === run.id || (row.subject.kind === 'pair' ? ids.has(row.subject.leftImageVersionId) || ids.has(row.subject.rightImageVersionId) : ids.has(row.subject.imageVersionId)))
    return toJson({ case: sample, modelEvidenceAuthor: 'vision-model', source: { imageVersionId: source.id, digest: source.blob.digest, geometry: source.geometry, origin: asset.source }, settings: spec.fixed.wallpaper, skillVersion: state.skillVersion, attempts: item.attempts, humanFeedback: human })
  }

  /** Evaluate candidate guidance with real plans and rendered pixels, without new image generation.
   * @returns Worker whose requests and comparison receipt are owned by a separate durable Run.
   */
  worker(): Worker {
    return async ctx => {
      const prompts = wallpaperPromptBundleSchema.parse(ctx.spec.fixed.prompts), baseSkill = z.string().parse(ctx.spec.fixed.baseSkill)
      const config = ctx.spec.config, provider = await this.deps.vision(config), start = this.read()
      const caseIds = z.array(z.string()).parse(ctx.spec.input.caseIds), cases = start.cases.filter(row => caseIds.includes(row.id) && !row.benchmark)
      let candidate = typeof ctx.spec.input.candidateId === 'string' ? start.versions.find(row => row.id === ctx.spec.input.candidateId) : undefined
      if (!candidate) {
        if (!cases.length) return 'partial-failure'
        const baseline = start.versions.find(row => row.id === ctx.spec.input.activeVersion)!
        if (!baseline) throw new CuratorError('reference-unavailable', 'wallpaper-distill', 'The frozen active guidance is unavailable.')
        const input: VisionInput = { wallpaperPrompt: prompts.distill, requestId: `${ctx.runId}:distill`, taskBrief: JSON.stringify(ctx.spec.input.caseEvidence), rules: [], images: [], usage: { templateVersion: 1, activeGuidance: baseline.content, maxGuidanceChars: config.wallpaper.maxSkillChars - baseSkill.length - 36, noNewGenerationForEvaluation: true } }
        const bundle = toJson(provider.describeRequest(input, 'wallpaper-distill')), previous = this.deps.domain.repository.list('request').find(row => row.runId === ctx.runId && row.state === 'committed' && row.requestDigest === contentDigest(bundle))
        const proposal = previous ? wallpaperDistillationSchema.parse(z.object({ output: z.unknown() }).parse(previous.data).output) : await ctx.request('vision', bundle, async (signal, metadata) => wallpaperDistillationSchema.parse(await provider.wallpaper(input, 'wallpaper-distill', visionBounds(config, ctx, signal, metadata))))
        if (proposal.evidenceCaseIds.some(id => !caseIds.includes(id))) throw new CuratorError('invalid-input', 'wallpaper-distill', 'The proposed Skill cites an unavailable case.')
        const content = `${baseSkill}\n## Model-authored case guidance\n\n${proposal.guidance}\n`, id = contentDigest(content).slice(10)
        if (content.length > config.wallpaper.maxSkillChars) throw new CuratorError('invalid-input', 'wallpaper-distill', 'The proposed guidance exceeds its configured length bound.')
        const oldLines = baseline.content.split('\n'), newLines = content.split('\n')
        candidate = { id, content, parentId: baseline.id, changes: { added: newLines.filter(line => !oldLines.includes(line)), removed: oldLines.filter(line => !newLines.includes(line)) }, createdAt: new Date().toISOString(), status: 'pending-evidence', reason: proposal.requiresNewGeneration ? 'requires-new-generation' : 'awaiting-benchmarks', caseIds: proposal.evidenceCaseIds }
        const accepted = candidate
        await this.update(state => { if (!state.versions.some(row => row.id === id)) state.versions.push(accepted); state.lastDistilledCount = z.number().int().parse(ctx.spec.input.families); state.distilledFamilyIds = [...new Set([...state.distilledFamilyIds, ...cases.map(row => row.familyId)])] })
        return proposal.requiresNewGeneration ? 'partial-failure' : 'source-exhausted'
      }
      if (candidate.reason === 'requires-new-generation') return 'partial-failure'
      const benchmarks = wallpaperExperienceSchema.shape.cases.parse(ctx.spec.input.benchmarks).filter(row => row.benchmark && row.confirmedBy && row.expectedPass !== undefined).map(row => ({ ...row, familyId: this.deps.domain.familyOf(row.familyId) }))
      const unique = [...new Map(benchmarks.map(row => [row.familyId, row])).values()]
      const heldFamilies = new Set(unique.map(row => row.familyId))
      if (start.cases.some(row => candidate!.caseIds.includes(row.id) && heldFamilies.has(row.familyId))) { await this.update(state => { state.versions.find(row => row.id === candidate!.id)!.reason = 'benchmark-overlap' }); return 'partial-failure' }
      if (unique.length < config.wallpaper.minBenchmarks || ['single', 'group', 'scene', 'abstract'].some(mode => unique.filter(row => row.mode === mode).length < 3)) return 'partial-failure'
      const baseline = start.versions.find(row => row.id === ctx.spec.input.activeVersion)
      if (!baseline) throw new CuratorError('reference-unavailable', 'wallpaper-evaluation', 'The frozen baseline Skill is unavailable.')
      const score = { compared: 0, baselinePass: 0, candidatePass: 0, baselineRounds: 0, candidateRounds: 0, falseAccepts: 0 }
      for (const sample of unique) {
        const old = await this.deps.evaluate(ctx, sample, baseline.content, 1), next = await this.deps.evaluate(ctx, sample, candidate.content, 2)
        if (old.needsGeneration || next.needsGeneration) { await this.update(state => { const row = state.versions.find(row => row.id === candidate!.id)!; row.reason = 'requires-new-generation'; row.status = 'pending-evidence' }); return 'partial-failure' }
        score.compared++; score.baselineRounds += old.rounds; score.candidateRounds += next.rounds
        if (old.verdict !== 'needs-review' && (old.verdict === 'pass') === sample.expectedPass) score.baselinePass++
        if (next.verdict !== 'needs-review' && (next.verdict === 'pass') === sample.expectedPass) score.candidatePass++
        if (next.verdict === 'pass' && sample.expectedPass === false) score.falseAccepts++
        await ctx.save('reviewing', { checkpoint: { ...dataOf(ctx.current()).checkpoint, wallpaperEvaluation: toJson({ candidateId: candidate.id, score }) } })
      }
      const improved = score.falseAccepts === 0 && score.candidatePass >= score.baselinePass && (score.candidatePass > score.baselinePass || score.candidateRounds < score.baselineRounds)
      await this.update(state => {
        const version = state.versions.find(row => row.id === candidate!.id)!
        version.evaluation = score; version.reason = improved ? 'fixed-benchmarks-improved' : 'no-demonstrated-improvement'; version.status = improved ? 'verified' : 'pending-evidence'
        if (improved && state.autoPromote && state.active === baseline.id) { for (const row of state.versions) if (row.status === 'active') row.status = 'retired'; version.status = 'active'; state.active = version.id }
      })
      return improved ? 'target-met' : 'partial-failure'
    }
  }
}
