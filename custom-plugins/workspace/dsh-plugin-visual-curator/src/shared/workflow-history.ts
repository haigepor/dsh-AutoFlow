/** Human-only workflow removal keeps image files and immutable task evidence. */
import { z } from 'zod'
import { runSchema, styleSchema } from './model.ts'
import { searchLaunchInputSchema } from './search-launch.ts'

/** A launch owns all its linked executions; standalone historical runs have their own target. */
export const workflowHistoryTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('launch'), id: searchLaunchInputSchema.shape.operationId }),
  z.strictObject({ kind: z.literal('run'), id: runSchema.shape.id }),
])
/** Fixed selection for the confirmation dialog and its idempotent command. */
export type WorkflowHistoryTarget = z.input<typeof workflowHistoryTargetSchema>
/** Removal requires explicit consent to stop unfinished work in the selected workflow. */
export const workflowHistoryDeleteSchema = z.strictObject({ styleId: styleSchema.shape.id, target: workflowHistoryTargetSchema, operationId: z.string().min(1), stopActive: z.literal(true) })
/** Acknowledged identities used to invalidate both task and preparation views. */
export const workflowHistoryReceiptSchema = z.strictObject({ deleted: z.literal(true), target: workflowHistoryTargetSchema, runIds: z.array(runSchema.shape.id), launchIds: z.array(searchLaunchInputSchema.shape.operationId) })
/** Confirmed logical deletion; original records remain readable by authorized owners. */
export type WorkflowHistoryReceipt = z.infer<typeof workflowHistoryReceiptSchema>
/** Profile-private atomic visibility marker; existing single-run markers remain valid. */
export const workflowHistoryMarkerSchema = workflowHistoryReceiptSchema.extend({ version: z.literal(1), styleId: styleSchema.shape.id })
