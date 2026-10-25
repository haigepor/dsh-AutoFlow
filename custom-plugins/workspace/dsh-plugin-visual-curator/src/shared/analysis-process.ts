/** Bounded, provider-visible task output; it never represents unreturned private model reasoning. */
import { z } from 'zod'
import { styleSummarySchema } from './style-analysis.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RequestId } from './model.ts'

const requestIdentity = z.string().min(1).transform(value => brandString<RequestId>(value))

/** Worker phases, including queueing and durable stop states. */
export const processPhaseSchema = z.enum(['queued', 'preparing', 'analyzing', 'receiving', 'validating', 'summarizing', 'saving', 'completed', 'interrupted', 'cancelled', 'failed'])
/** Ordered phase changes with the exact images admitted to each batch. */
export const processEventSchema = z.strictObject({ sequence: z.number().int().nonnegative(), at: z.string(), phase: processPhaseSchema, imageIds: z.array(z.string()), batch: z.number().int().nonnegative().optional() })
/** One retained provider response, distinct from retried or resumed responses. */
export const analysisMessageSchema = z.strictObject({ sequence: z.number().int().nonnegative(), requestId: requestIdentity.optional(), kind: z.enum(['analysis', 'summary']), batch: z.number().int().positive().optional(), imageIds: z.array(z.string()), content: z.string(), reasoning: z.string(), state: z.enum(['streaming', 'complete', 'interrupted', 'cancelled', 'failed']), at: z.string(), updatedAt: z.string() })
/** Bounded message content and its completion state. */
export type AnalysisMessage = z.infer<typeof analysisMessageSchema>
/** Checkpoint-compatible progress; legacy records may omit conversation messages. */
export const analysisProcessSchema = z.strictObject({ phase: processPhaseSchema, events: z.array(processEventSchema), content: z.string(), reasoning: z.string(), messages: z.array(analysisMessageSchema).optional(), truncated: z.boolean(), updatedAt: z.string() })
/** Ephemeral output becomes durable together with a task checkpoint. */
export type AnalysisProcess = z.infer<typeof analysisProcessSchema>
/** Phase changes and actual upstream text deltas; omitted text leaves the current response untouched. */
export interface ProcessUpdate { phase: AnalysisProcess['phase']; requestId?: RequestId; imageIds?: string[]; batch?: number; content?: string; reasoning?: string; resetOutput?: boolean }
/** Lightweight saved attempt index; request text loads only on explicit inspection. */
export const analysisRequestSchema = z.object({ requestId: requestIdentity, createdAt: z.string(), state: z.enum(['reserved', 'committed', 'outcome-unknown']), operation: z.enum(['analyze', 'summarize']).nullable(), model: z.string().nullable(), imageIds: z.array(z.string()), available: z.boolean() })
/** One authorized saved attempt. */
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>
/** Exact saved text and ordered resource references, without headers or inline image bytes. */
export const analysisInputSchema = z.object({ requestId: requestIdentity, instructions: z.string(), inputText: z.string(), images: z.array(z.object({ imageVersionId: z.string(), name: z.string(), digest: z.string(), mime: z.string(), role: z.string(), previewPath: z.string(), sourceKind: z.enum(['local', 'remote']) })) })
/** On-demand input for one saved request. */
export type AnalysisInput = z.infer<typeof analysisInputSchema>
/** Authorized lightweight task fields, without media or raw request diagnostics. */
export const analysisTaskSchema = z.object({ runId: z.string(), styleId: z.string(), name: z.string(), status: z.enum(['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling', 'cancelled', 'completed', 'failed']), outcome: z.string().optional(), observed: z.number(), total: z.number(), model: z.string(), reasoningEffort: z.string().nullable(), attempts: z.number(), startedAt: z.string(), phase: processPhaseSchema, autoResume: z.boolean(), error: z.object({ code: z.string(), stage: z.string(), retryable: z.boolean(), safeMessage: z.string(), suggestedAction: z.string() }).optional() })
/** Collection progress for the menu and shared workbench state. */
export type AnalysisTask = z.infer<typeof analysisTaskSchema>
/** Detailed process output and complete committed results, independent of raw-text retention. */
export const analysisDetailSchema = z.object({ task: analysisTaskSchema, process: analysisProcessSchema.optional(), requests: z.array(analysisRequestSchema).default([]), summary: styleSummarySchema.optional(), images: z.array(z.object({ imageVersionId: z.string(), name: z.string() })).default([]), observations: z.array(z.object({ imageVersionId: z.string(), dimensions: z.array(z.object({ field: z.string(), value: z.unknown(), uncertain: z.boolean() })) })) })
/** Read-only conversation details for one authorized task. */
export type AnalysisDetail = z.infer<typeof analysisDetailSchema>
/** @param status Durable task state. @returns Whether the task is queued, executing or stopping. */
export function analysisActive(status: string): boolean { return ['created', 'running', 'pausing', 'cancelling'].includes(status) }
