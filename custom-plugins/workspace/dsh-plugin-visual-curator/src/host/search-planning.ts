/** A bounded model plan is frozen before retrieval and replayed from its committed receipt after interruption. */
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { visionSearchPlanSchema, type StructuredVisionProvider, type VisionInput } from '../media/vision.ts'
import { CuratorError } from '../shared/errors.ts'
import { jsonSchema } from '../shared/model.ts'
import { dataOf, toJson, type WorkContext } from './runtime.ts'
import { visionBounds } from './providers.ts'

const checkpointSchema = visionSearchPlanSchema.extend({ version: z.literal(1), requestDigest: z.string() })

/** @param ctx Saved search task. @param domain Its record owner. @param vision The frozen model route. @returns Effective queries while retaining the original execution specification. */
export async function planSearch(ctx: WorkContext, domain: CuratorDomain, vision: StructuredVisionProvider): Promise<WorkContext> {
  const maxQueries = Math.min(ctx.spec.config.limits.maxSearchPages, ctx.spec.config.limits.maxCandidates)
  const input: VisionInput = {
    requestId: `search-plan:${ctx.runId}`, rules: [], images: [],
    taskBrief: JSON.stringify({ task: ctx.spec.input.taskBrief, style: ctx.spec.fixed.executionInstructions ?? ctx.spec.fixed.release,
      seedQueries: ctx.spec.input.queries, source: ctx.spec.config.source.provider, maxQueries,
      targetCount: ctx.spec.input.targetCount, output: ctx.spec.fixed.output, wallpaper: ctx.spec.fixed.wallpaperAuto === true,
      limits: { maxSearchPages: ctx.spec.config.limits.maxSearchPages, maxCandidates: ctx.spec.config.limits.maxCandidates },
      requirement: 'Propose concise, diverse search phrases for the configured image source, in descending relevance. Use the task and enabled style rules to decide the subject and appearance; never turn negative references into positive keywords. Keep shared requirements and alternative style groups distinct. Do not assume that a query proves the subject of a returned image. Use at most maxQueries unique directions; prioritize reusable broad terms and describe the rationale. Do not change the source, budget, output, style rules or wallpaper safety template. This is retrieval planning from existing observations; do not invent new visual evidence.' }),
  }
  const bundle = toJson(vision.describeRequest(input, 'plan-search')), requestDigest = contentDigest(bundle)
  const checkpoint = dataOf(ctx.current()).checkpoint.searchPlan
  let plan: z.infer<typeof checkpointSchema>
  if (checkpoint !== undefined) {
    plan = checkpointSchema.parse(checkpoint)
    if (plan.requestDigest !== requestDigest) throw new CuratorError('reference-unavailable', 'search-planning', 'The saved query plan does not match this task.')
  } else {
    const saved = domain.repository.list('request').find(request => request.runId === ctx.runId && request.state === 'committed' && request.requestDigest === requestDigest)
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
    await ctx.save('planning', { checkpoint: { ...dataOf(ctx.current()).checkpoint, searchPlan: toJson(plan) } })
  }
  return { ...ctx, spec: { ...ctx.spec, input: { ...ctx.spec.input, queries: plan.queries } } }
}
