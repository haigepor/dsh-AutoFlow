/** Operation-owned native compaction keeps fixed image evidence and human judgments outside summaries. */
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { estimateContent, ROLE_OVERHEAD } from '@deepseek-ai/dsh-token-meter/estimate'
import { z } from 'zod'
import type { StructuredVisionProvider, VisionInput } from '../media/vision.ts'
import type { DomainRepository } from '../domain/repository.ts'
import { contentDigest } from '../domain/repository.ts'
import { MediaError } from '../media/errors.ts'
import { CuratorError } from '../shared/errors.ts'
import { toJson, type WorkContext } from './runtime.ts'

/** Profile services are resolved at the operation entry, never captured as a global current model. */
export interface SummaryCompactionDependencies { llm?: Pick<LlmRuntime, 'prepareCall'>; compaction?: Pick<CompactionEngine, 'compactInput'> }
const outputSchema = z.object({ text: z.string().min(1) })

/**
 * Compress saved observation text before reserving the final vision request.
 * @param deps Native services; missing services reject new native tasks at this operation.
 * @param repository Committed request records owned by the task.
 * @param provider Existing structured vision serializer.
 * @param input Complete summary input; legacy tasks pass through unchanged.
 * @param ctx Durable owner, budget and cancellation.
 * @returns Original input below pressure or input containing a separately identified inferred summary.
 */
export async function compactStyleSummary(deps: SummaryCompactionDependencies, repository: DomainRepository, provider: StructuredVisionProvider, input: VisionInput, ctx: WorkContext): Promise<VisionInput> {
  if (ctx.spec.config.vision.backend !== 'native' || ctx.spec.config.vision.useModelDefaults !== true) return input
  if (!deps.llm || !deps.compaction) throw new MediaError('capability-unavailable', 'context-compaction', false, 'Native context compaction is unavailable.', 'Enable the native Compaction service for this profile.')
  const brief = z.object({ samples: z.array(z.object({ observation: z.json() }).catchall(z.json())) }).catchall(z.json()).parse(JSON.parse(input.taskBrief))
  const chunks = brief.samples.map(sample => JSON.stringify(sample.observation))
  const samples = brief.samples.map(({ observation, ...sample }) => ({ ...sample, observationId: z.object({ id: z.string() }).parse(observation).id }))
  const fixed = { ...brief, samples, observationSummary: '' }
  const fixedInput = { ...input, taskBrief: JSON.stringify(fixed) }
  const descriptor = provider.describeRequest(fixedInput, 'summarize')
  const prepared = await deps.llm.prepareCall({ provider: ctx.spec.config.vision.provider!, model: ctx.spec.config.vision.model }, ctx.signal)
  if (!prepared.context) throw new MediaError('capability-unavailable', 'context-compaction', false, 'The native model has no configured context capacity.', 'Set its context capacity in project model settings.')
  const price = (text: string) => estimateContent([{ type: 'text', text }]) + ROLE_OVERHEAD
  try {
    const result = await deps.compaction.compactInput({ config: prepared.config, contextWindow: prepared.context.contextWindow,
      retainedTokens: price(descriptor.instructions) + price(descriptor.inputText), chunks,
      instruction: 'Preserve per-image visual dimensions, exact imageVersionIds, uncertainty, positive/negative roles and conflicting substyles. These are inferred observations; never change or override the separately retained human judgments.',
      maxOutputBytes: ctx.spec.config.limits.maxResponseBytes }, async (call, work) => {
      // 消息的进程内随机身份不影响模型输入；回执摘要采用其实际角色、来源和内容。
      const bundle = toJson({ operation: 'compact-input', config: call.config, messages: call.messages.map(({ id: _id, ...message }) => message) })
      const cached = repository.list('request').find(request => request.runId === ctx.runId && request.state === 'committed' && request.requestDigest === contentDigest(bundle))
      if (cached) return outputSchema.parse(z.object({ output: z.unknown() }).parse(cached.data).output)
      const startedAt = Date.now()
      return ctx.request('vision', bundle, (signal, record) => work(AbortSignal.any([signal, AbortSignal.timeout(ctx.spec.config.limits.requestTimeoutMs)]), metadata => record(toJson({ transport: 'native-llm', provider: call.config.provider, model: call.config.model, request: { config: call.config, messages: call.messages }, timing: { elapsedMs: Date.now() - startedAt }, ...metadata }))))
    }, ctx.signal)
    if (!result) return input
    const compacted = { ...input, taskBrief: JSON.stringify({ ...fixed, observationSummary: result.text }) }
    const actual = provider.describeRequest(compacted, 'summarize')
    if (price(actual.instructions) + price(actual.inputText) + (prepared.config.maxTokens ?? 0) >= prepared.context.contextWindow) throw new Error('The serialized compressed input still exceeds the model context budget.')
    return compacted
  } catch (error) {
    ctx.signal.throwIfAborted()
    if (error instanceof MediaError || error instanceof CuratorError) throw error
    throw new MediaError('vision-context-compaction-failed', 'context-compaction', false, 'The saved observations could not be compacted safely.', 'Retain the observations and review native context and compaction settings.')
  }
}
