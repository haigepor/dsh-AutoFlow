/** The model receives nine bounded operations; all human confirmations remain in the workbench. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ActionArgs } from '../client/contract.ts'
import type { CuratorService } from './service.ts'
import { CuratorError } from '../shared/errors.ts'
import { safeFailure } from './runtime.ts'
import type {} from './plugin.ts'
import { z } from 'zod'

export const name = 'visual-curator-tools'
export const inject = ['tools', 'visualCurator']

/** Existing direct consumers keep all tools; bundle rows select one independently managed group. */
export const Config = z.strictObject({ group: z.enum(['all', 'read', 'curate', 'export']).default('all') }).default({ group: 'all' })

const toolGroups = {
  read: ['visual_task_prepare', 'visual_style_list', 'visual_style_get', 'visual_run_get', 'visual_export_get'],
  curate: ['visual_search_start', 'visual_crop_start'],
  export: ['visual_feedback_suggest', 'visual_export_start'],
} satisfies Record<string, string[]>

const id = { type: 'string' as const, minLength: 1, maxLength: 256 }
const text = { type: 'string' as const, minLength: 1, maxLength: 4000 }
const positive = { type: 'integer' as const, minimum: 1, maximum: 1_000_000_000 }
const budgets = { type: 'object' as const, additionalProperties: false, properties: {
  targetCount: positive, maxSearchPages: positive, maxCandidates: positive, maxVisionCalls: positive,
  maxDownloadBytes: positive, maxCropCandidatesPerImage: positive, maxConcurrentRequests: { ...positive, maximum: 16 },
  maxRetryAttempts: { type: 'integer' as const, minimum: 0, maximum: 5 }, deadlineMs: positive,
}, required: ['targetCount', 'maxSearchPages', 'maxCandidates', 'maxVisionCalls', 'maxDownloadBytes', 'maxCropCandidatesPerImage', 'maxConcurrentRequests', 'maxRetryAttempts', 'deadlineMs'] }

interface Declaration {
  name: string
  operation: string
  description: string
  kind: 'read' | 'search' | 'execute'
  properties: Record<string, object>
  required: string[]
}
const output = { type: 'object', properties: { kind: { type: 'string', enum: ['preview', 'original', 'usage'], description: 'preview returns public Unsplash preview links without original downloads or a usage; original downloads and verifies source files; usage produces a sized crop.' }, usageRevisionId: id }, required: ['kind'], additionalProperties: false }
const declarations: Declaration[] = [
  { name: 'visual_task_prepare', operation: 'task-prepare', kind: 'read', description: 'Prepare a search or crop without jobs or paid requests. Discover saved usages, source ID and limits; report missing inputs or blockers. Use normalizedInput and preparationDigest with the start tool. Humans create missing usages in the workbench.',
    properties: { usagePageToken: id, usagePageSize: { ...positive, maximum: 100 }, kind: { type: 'string', enum: ['search', 'crop'] }, output, releaseId: id, usageRevisionId: id, taskBrief: text, sourceId: id, imageVersionId: id, protectedContent: { type: 'array', maxItems: 30, items: text }, targetCount: positive, queries: { type: 'array', items: text }, budgets: { ...budgets, required: [] } }, required: ['kind'] },
  { name: 'visual_style_list', operation: 'style-list', kind: 'read', description: 'List this profile’s saved visual styles and fixed release references. Continue only with the exact pageToken returned by this service; omit it on the first page. No publication or default changes.',
    properties: { pageToken: id, pageSize: { ...positive, maximum: 100 } }, required: [] },
  { name: 'visual_style_get', operation: 'style-get', kind: 'read', description: 'Read one saved style, human rules, immutable releases and its modelProfile with automatically adopted rules and evidence. A fresh modelProfile.id is an executable reference standard; pass that exact ID as releaseId. Drafts are not executable standards. Image resources require this DSH owner and the original Session when present.',
    properties: { styleId: id }, required: ['styleId'] },
  { name: 'visual_search_start', operation: 'search-start', kind: 'search', description: 'Start a background image search with a published release or fresh modelProfile.id, configured source and explicit output. Supply all hard budgets. Returns runId/jobId immediately; read saved results for actual matches. Model style groups are alternatives. Keep the current rules and identifiers fixed.',
    properties: { output, preparationDigest: id, targetCount: positive, protectedContent: { type: 'array', maxItems: 30, items: text }, releaseId: id, usageRevisionId: id, sourceId: { ...id, description: 'Use unsplash for the configured Unsplash source; otherwise use the configured generic source ID.' }, queries: { type: 'array', minItems: 1, maxItems: 20, items: text, description: 'For a launched preview search, supply English subject-and-style phrases based on enabled rules and groups, within maxSearchPages. Other searches may use saved hints. taskBrief remains the visual objective.' }, taskBrief: text, budgets }, required: ['releaseId', 'sourceId', 'taskBrief', 'budgets'] },
  { name: 'visual_crop_start', operation: 'crop-start', kind: 'execute', description: 'Start a background crop of an authorized saved image version using an explicit published release and usage. The Host checks exact geometry and reviews the actual rendered crop. Returns runId/jobId, not a completed image. No human crop confirmation is created.',
    properties: { preparationDigest: id, imageVersionId: id, releaseId: id, usageRevisionId: id, taskBrief: text, protectedContent: { type: 'array', maxItems: 30, items: text }, budgets }, required: ['imageVersionId', 'releaseId', 'usageRevisionId', 'taskBrief', 'protectedContent', 'budgets'] },
  { name: 'visual_run_get', operation: 'run-get', kind: 'read', description: 'Read a saved run belonging to this original Session, including durable status/stage/outcome, distinct stage counts and authorized result references. Technical failures are not visual rejections. Saved selections are preview matches when outputKind is preview; they do not verify originals. Preview results include public previewUrl links. Use resultFilter selected, review, rejected, failed, processing, pending, source or all, and keep the same filter with a returned pageToken. Use job_output for bounded waits; do not poll unchanged reports repeatedly.',
    properties: { resultFilter: { type: 'string', enum: ['all', 'selected', 'review', 'rejected', 'failed', 'processing', 'pending', 'source'] }, runId: id, pageToken: id, pageSize: { ...positive, maximum: 100 } }, required: ['runId'] },
  { name: 'visual_feedback_suggest', operation: 'feedback-suggest', kind: 'execute', description: 'Save an unconfirmed Agent suggestion with its original authorship. It cannot create a human label, confirm a rule or crop, publish a release, switch a default or confirm a dataset split. A human must review suggestions in the workbench.',
    properties: { text, feedbackIds: { type: 'array', maxItems: 100, items: id } }, required: ['text', 'feedbackIds'] },
  { name: 'visual_export_start', operation: 'export-start', kind: 'execute', description: 'Export a model profile as reference data using its exact modelProfile.id as releaseId, purpose reference, kind style or skill and mode references-only; no split is needed for this package. Human-release supervision exports still require a saved split and eligible labels. Image-byte permission remains separate. Returns an export run handle, not trained weights or installed instructions.',
    properties: { kind: { type: 'string', enum: ['style', 'classification', 'preference', 'crop', 'skill'] }, purpose: { type: 'string', enum: ['training', 'development', 'holdout', 'reference'] }, releaseId: id, usageRevisionId: id, splitId: id, mode: { type: 'string', enum: ['references-only', 'with-bytes'] } },
    required: ['kind', 'purpose', 'releaseId', 'mode'] },
  { name: 'visual_export_get', operation: 'export-get', kind: 'read', description: 'Read a completed export’s safe manifest, exclusions and checksums. Download references require the current owner and original Session. Missing or corrupt resources are failures, not complete exports. Never invent a public download URL.',
    properties: { exportId: id }, required: ['exportId'] },
]

/** Build all tool definitions against one Host provider, without registering human-only commands.
 * @param service Shared initialized business provider.
 * @returns Nine reversible registry contributions.
 */
export function createAgentTools(service: Pick<CuratorService, 'action' | 'profileId'>): ToolDefinition[] {
  return declarations.map(declaration => ({
    name: declaration.name, description: declaration.description,
    parameters: { type: 'object', additionalProperties: false, properties: declaration.properties, required: declaration.required },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ visualCurator: { version: 1, tool: declaration.name, result: value } }) },
    presentCall: () => ({ card: 'generic', title: declaration.name, kind: declaration.kind }),
    async execute(args, exec) {
      if (!exec.agent?.id) throw new Error(JSON.stringify(safeFailure(new CuratorError('owner-denied', 'tool', 'A Session is required.'))))
      if (typeof args !== 'object' || args === null || Array.isArray(args)
        || Object.keys(args).some(key => !Object.hasOwn(declaration.properties, key))
        || declaration.required.some(key => !Object.hasOwn(args, key))) {
        throw new Error(JSON.stringify(safeFailure(new CuratorError('invalid-input', 'tool', 'Tool arguments do not match this operation.'))))
      }
      try {
        exec.signal.throwIfAborted()
        const result = await service.action({ operation: declaration.operation, args: { ...args, operationId: exec.callId } as ActionArgs },
          { kind: 'agent', id: exec.agent.id, profileId: service.profileId, sessionId: exec.agent.id }, exec.signal)
        return JSON.stringify(result)
      } catch (error) { exec.signal.throwIfAborted(); throw new Error(JSON.stringify(safeFailure(error))) }
    },
  }))
}

/** Register the approved Agent tools as effects owned by the optional tools row.
 * @param ctx Scoped Cordis context with the shared provider and tools registry.
 * @param config Validated tool selection; direct consumers retain all nine tools.
 */
export function apply(ctx: Context, config: z.infer<typeof Config> = { group: 'all' }): void {
  for (const tool of createAgentTools(ctx.visualCurator)) {
    if (config.group !== 'all' && !toolGroups[config.group].includes(tool.name)) continue
    ctx.effect(() => ctx.tools.register(tool), `Visual Curator tool ${tool.name}`)
  }
}
