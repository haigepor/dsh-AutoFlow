/** The model receives eight bounded operations; all human confirmations remain in the workbench. */
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
  read: ['visual_style_list', 'visual_style_get', 'visual_run_get', 'visual_export_get'],
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
const declarations: Declaration[] = [
  { name: 'visual_style_list', operation: 'style-list', kind: 'read', description: 'List this profile’s saved visual styles and fixed release references. Continue only with the exact pageToken returned by this service; omit it on the first page. No publication or default changes.',
    properties: { pageToken: id, pageSize: { ...positive, maximum: 100 } }, required: [] },
  { name: 'visual_style_get', operation: 'style-get', kind: 'read', description: 'Read one saved style, its rules and immutable release/candidate summaries. Drafts are not executable search standards. Image resource references require this DSH owner and the original Session when present.',
    properties: { styleId: id }, required: ['styleId'] },
  { name: 'visual_search_start', operation: 'search-start', kind: 'search', description: 'Start a background image search with an explicit published release, immutable usage and configured source. Supply all hard budgets. Returns runId/jobId immediately; launch acknowledgment does not mean images qualified. Only saved, actual pixel reviews determine qualified results. Costs may be unavailable. Never loosen required rules or invent IDs.',
    properties: { releaseId: id, usageRevisionId: id, sourceId: id, taskBrief: text, budgets }, required: ['releaseId', 'usageRevisionId', 'sourceId', 'taskBrief', 'budgets'] },
  { name: 'visual_crop_start', operation: 'crop-start', kind: 'execute', description: 'Start a background crop of an authorized saved image version using an explicit published release and usage. The Host checks exact geometry and reviews the actual rendered crop. Returns runId/jobId, not a completed image. No human crop confirmation is created.',
    properties: { imageVersionId: id, releaseId: id, usageRevisionId: id, taskBrief: text, protectedContent: { type: 'array', maxItems: 30, items: text }, budgets }, required: ['imageVersionId', 'releaseId', 'usageRevisionId', 'taskBrief', 'protectedContent', 'budgets'] },
  { name: 'visual_run_get', operation: 'run-get', kind: 'read', description: 'Read a saved run belonging to this original Session, including durable status/stage/outcome, distinct stage counts and authorized result references. Technical failures are not visual rejections. Continue only a returned pageToken. Use job_output for bounded waits; do not poll unchanged reports repeatedly.',
    properties: { runId: id, pageToken: id, pageSize: { ...positive, maximum: 100 } }, required: ['runId'] },
  { name: 'visual_feedback_suggest', operation: 'feedback-suggest', kind: 'execute', description: 'Save an unconfirmed Agent suggestion with its original authorship. It cannot create a human label, confirm a rule or crop, publish a release, switch a default or confirm a dataset split. A human must review suggestions in the workbench.',
    properties: { text, feedbackIds: { type: 'array', maxItems: 100, items: id } }, required: ['text', 'feedbackIds'] },
  { name: 'visual_export_start', operation: 'export-start', kind: 'execute', description: 'Create a fixed export from authorized existing human labels and a saved release/split. Training includes learning families only. Defaults to references-only; image bytes require previously recorded permission. Returns an export run handle. A Skill is only a downloadable guide; this operation never activates Home instructions or trains a model.',
    properties: { kind: { type: 'string', enum: ['style', 'classification', 'preference', 'crop', 'skill'] }, purpose: { type: 'string', enum: ['training', 'development', 'holdout', 'reference'] }, releaseId: id, usageRevisionId: id, splitId: id, mode: { type: 'string', enum: ['references-only', 'with-bytes'] } },
    required: ['kind', 'purpose', 'releaseId', 'splitId', 'mode'] },
  { name: 'visual_export_get', operation: 'export-get', kind: 'read', description: 'Read a completed export’s safe manifest, exclusions and checksums. Download references require the current owner and original Session. Missing or corrupt resources are failures, not complete exports. Never invent a public download URL.',
    properties: { exportId: id }, required: ['exportId'] },
]

/** Build all tool definitions against one Host provider, without registering human-only commands.
 * @param service Shared initialized business provider.
 * @returns Eight reversible registry contributions.
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
 * @param config Validated tool selection; direct consumers retain all eight tools.
 */
export function apply(ctx: Context, config: z.infer<typeof Config> = { group: 'all' }): void {
  for (const tool of createAgentTools(ctx.visualCurator)) {
    if (config.group !== 'all' && !toolGroups[config.group].includes(tool.name)) continue
    ctx.effect(() => ctx.tools.register(tool), `Visual Curator tool ${tool.name}`)
  }
}
