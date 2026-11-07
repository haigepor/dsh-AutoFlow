/** A bounded model plan is frozen before retrieval and replayed from its committed receipt after interruption. */
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { visionSearchPlanSchema, type StructuredVisionProvider, type VisionInput } from '../media/vision.ts'
import { CuratorError } from '../shared/errors.ts'
import { jsonSchema } from '../shared/model.ts'
import { dataOf, toJson, type WorkContext } from './runtime.ts'
import { visionBounds } from './providers.ts'
import { searchQueryPlanningGuidance } from './search-guidance.ts'

const checkpointSchema = visionSearchPlanSchema.extend({ version: z.literal(1), requestDigest: z.string() })

/** @param ctx Saved search task. @param domain Its record owner. @param vision The frozen model route. @returns Effective queries while retaining the original execution specification. */
export async function planSearch(ctx: WorkContext, domain: CuratorDomain, vision: StructuredVisionProvider): Promise<WorkContext> {
  const maxQueries = Math.min(ctx.spec.config.limits.maxSearchPages, ctx.spec.config.limits.maxCandidates)
  let input: VisionInput = {
    requestId: `search-plan:${ctx.runId}`, rules: [], images: [],
    taskBrief: JSON.stringify({ task: ctx.spec.input.taskBrief, style: ctx.spec.fixed.executionInstructions ?? ctx.spec.fixed.release,
      seedQueries: ctx.spec.input.queries, source: ctx.spec.config.source.provider, maxQueries,
      targetCount: ctx.spec.input.targetCount, output: ctx.spec.fixed.output, wallpaper: ctx.spec.fixed.wallpaperAuto === true,
      limits: { maxSearchPages: ctx.spec.config.limits.maxSearchPages, maxCandidates: ctx.spec.config.limits.maxCandidates },
      requirement: `${searchQueryPlanningGuidance} Propose diverse directions for the configured source in descending relevance, using at most maxQueries unique queries, and explain the rationale. Never turn negative references into positive keywords. Keep shared requirements and alternative style groups distinct. A query does not establish acceptance of returned pixels. Do not change the source, budget, output, style rules or wallpaper safety template, or invent new visual evidence.` }),
  }
  let bundle = toJson(vision.describeRequest(input, 'plan-search')), requestDigest = contentDigest(bundle)
  const checkpoint = dataOf(ctx.current()).checkpoint.searchPlan
  const requests = dataOf(ctx.current()).requestIds.map(id => domain.require('request', id))
  const priorPlans = requests.flatMap(request => {
    if (request.runId !== ctx.runId) throw new CuratorError('reference-unavailable', 'search-planning', 'A saved planning receipt belongs to another task.')
    const envelope = z.object({ bundle: jsonSchema }).safeParse(request.data)
    const savedBundle = request.state === 'reserved' ? request.data : envelope.success ? envelope.data.bundle : undefined
    const identity = z.object({ requestId: z.string().optional(), operation: z.string().optional() }).safeParse(savedBundle)
    return identity.success && (identity.data.requestId === input.requestId || identity.data.operation === 'plan-search') ? [{ request, bundle: savedBundle! }] : []
  })
  if (priorPlans.length) {
    // Saved requests pin earlier instructions; every other frozen input and descriptor field must still match.
    try {
      const prior = priorPlans[0]!, descriptor = z.object({ inputText: z.string() }).parse(prior.bundle)
      const prompt = z.object({ input: z.object({ taskBrief: z.string() }) }).parse(JSON.parse(descriptor.inputText))
      const { requirement: _previousRequirement, ...previous } = z.object({ requirement: z.string().min(1) }).passthrough().parse(JSON.parse(prompt.input.taskBrief))
      const { requirement: _currentRequirement, ...current } = z.object({ requirement: z.string().min(1) }).passthrough().parse(JSON.parse(input.taskBrief))
      if (contentDigest(previous) !== contentDigest(current)) throw new Error('The frozen planning inputs differ')
      input = { ...input, taskBrief: prompt.input.taskBrief }
      bundle = toJson(vision.describeRequest(input, 'plan-search')); requestDigest = contentDigest(bundle)
      if (priorPlans.some(prior => prior.request.requestDigest !== requestDigest || contentDigest(prior.bundle) !== requestDigest)) throw new Error('The saved planning request differs')
    } catch (error) {
      throw new CuratorError('reference-unavailable', 'search-planning', 'The saved query request does not match this task.')
    }
  } else if (checkpoint !== undefined || requests.length) throw new CuratorError('reference-unavailable', 'search-planning', 'The saved query request receipt is unavailable.')
  const saved = priorPlans.find(prior => prior.request.state === 'committed' && prior.request.requestDigest === requestDigest)?.request
  let plan: z.infer<typeof checkpointSchema>
  if (checkpoint !== undefined) {
    plan = checkpointSchema.parse(checkpoint)
    if (plan.requestDigest !== requestDigest) throw new CuratorError('reference-unavailable', 'search-planning', 'The saved query plan does not match this task.')
    if (!saved || contentDigest(z.object({ output: visionSearchPlanSchema }).parse(saved.data).output) !== contentDigest({ queries: plan.queries, rationale: plan.rationale })) throw new CuratorError('reference-unavailable', 'search-planning', 'The saved query plan differs from its committed response.')
  } else {
    let output: z.infer<typeof visionSearchPlanSchema>
    if (saved) {
      const receipt = z.object({ bundle: jsonSchema, output: visionSearchPlanSchema }).parse(saved.data)
      if (contentDigest(receipt.bundle) !== requestDigest) throw new CuratorError('reference-unavailable', 'search-planning', 'The saved search response does not match its request.')
      output = receipt.output
    } else output = await ctx.request('vision', bundle, async (signal, recordMetadata) => {
      const result = await vision.planSearch(input, visionBounds(ctx.spec.config, ctx, signal, recordMetadata))
      if (result.queries.length > maxQueries) throw new CuratorError('vision-invalid-output', 'search-planning', 'The query plan exceeds the frozen search-page budget.', { retryable: true })
      return result
    })
    plan = { ...output, version: 1, requestDigest }
  }
  if (plan.queries.length > maxQueries || new Set(plan.queries.map(query => query.toLocaleLowerCase('en'))).size !== plan.queries.length) throw new CuratorError('reference-unavailable', 'search-planning', 'The saved query plan exceeds its limits or repeats a direction.')
  if (checkpoint === undefined) await ctx.save('planning', { checkpoint: { ...dataOf(ctx.current()).checkpoint, searchPlan: toJson(plan) } })
  return { ...ctx, spec: { ...ctx.spec, input: { ...ctx.spec.input, queries: plan.queries } } }
}
