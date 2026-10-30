/** Versioned records and parsers shared by the Host, workbench and export reader. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

const id = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
export type TaskId = Branded<'StylePrompt.TaskId'>
export type RuleId = Branded<'StylePrompt.RuleId'>
export type ReferenceId = Branded<'StylePrompt.ReferenceId'>
export const taskIdSchema = id.transform(value => brandString<TaskId>(value))
export const ruleIdSchema = id.transform(value => brandString<RuleId>(value))
export const referenceIdSchema = id.transform(value => brandString<ReferenceId>(value))
const text = z.string().trim().min(1).max(1600)
const short = z.string().trim().min(1).max(300)
export const bilingualSchema = z.strictObject({ zh: text, en: text })
const bilingualInputSchema = z.strictObject({ zh: text, en: z.string().trim().max(1600).default('') })
export const dimensionSchema = z.enum(['medium', 'rendering', 'shape', 'color', 'lighting', 'texture', 'detail', 'depth', 'composition'])
export type Dimension = z.infer<typeof dimensionSchema>
export const routeSchema = z.strictObject({ provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(300) })
export type Route = z.infer<typeof routeSchema>
export const analysisSchema = z.strictObject({
  name: short, summary: text, medium: z.enum(['photography', 'illustration', '3d', 'graphic', 'mixed', 'unknown']),
  sourceContent: z.array(short).max(20), sceneSpecific: z.array(short).max(20), unknowns: z.array(short).max(20),
  rules: z.array(z.strictObject({
    id: ruleIdSchema, dimension: dimensionSchema, description: bilingualSchema, evidence: short,
    referenceIds: z.array(referenceIdSchema).min(1).max(8),
    scope: z.enum(['global', 'subject', 'background', 'scene']), status: z.enum(['observed', 'inferred', 'unknown']),
  })).min(1).max(20),
}).refine(value => new Set(value.rules.map(rule => rule.id)).size === value.rules.length, 'Rule IDs must be unique')
export type StyleAnalysis = z.infer<typeof analysisSchema>

export const generationInputSchema = z.strictObject({
  analysisId: taskIdSchema, selectedRuleIds: z.array(ruleIdSchema).min(1).max(20),
  brief: bilingualInputSchema, changes: bilingualInputSchema,
  platform: z.enum(['generic', 'flux2']).default('generic'),
  mode: z.enum(['quick', 'model']).default('quick'),
  route: routeSchema.optional(),
}).refine(value => new Set(value.selectedRuleIds).size === value.selectedRuleIds.length, 'Selected rules must be unique')
export type GenerationInput = z.infer<typeof generationInputSchema>
const prompt = z.strictObject({ zh: z.string().trim().min(1).max(8000), en: z.string().trim().min(1).max(8000) })
export const generationSchema = z.strictObject({
  stylePrompt: prompt, fullPrompt: prompt, usedRuleIds: z.array(ruleIdSchema).min(1).max(20),
  variants: z.array(z.strictObject({ title: bilingualSchema, prompt, changes: z.array(bilingualSchema).min(1).max(6) })).min(1).max(3),
  newCreativeChoices: z.array(bilingualSchema).max(12), notes: z.array(bilingualSchema).max(10),
})
export type PromptGeneration = z.infer<typeof generationSchema>

export const imageRefSchema = z.strictObject({ attachmentId: z.string().min(1).max(300), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().optional(), originalDimensions: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).optional() })
export const referenceSchema = z.strictObject({ id: referenceIdSchema, name: z.string().min(1).max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/), attachment: imageRefSchema })
export type Reference = z.infer<typeof referenceSchema>
export const failureSchema = z.strictObject({ code: z.enum(['invalid-input', 'missing-record', 'operation-conflict', 'busy', 'capability-unavailable', 'invalid-output', 'request-timeout', 'model-error', 'cancelled', 'interrupted', 'storage-error', 'not-ready']) })
export type FailureCode = z.infer<typeof failureSchema>['code']
export const callSchema = z.strictObject({
  templateVersion: z.string(), config: z.json(), system: z.string(), inputText: z.string(),
  references: z.array(referenceSchema), startedAt: z.string(), finish: z.json().nullable(), usage: z.json().nullable(),
})
export type CallRecord = z.infer<typeof callSchema>
const base = {
  formatVersion: z.literal(1), id: taskIdSchema, createdAt: z.string(), updatedAt: z.string(), digest: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  failure: failureSchema.nullable(), call: callSchema.nullable(),
}
export const analysisRecordSchema = z.strictObject({ ...base, kind: z.literal('analysis'), route: routeSchema, references: z.array(referenceSchema).min(1).max(8), dimensions: z.array(dimensionSchema).min(1), result: analysisSchema.nullable() })
export type AnalysisRecord = z.infer<typeof analysisRecordSchema>
export const generationRecordSchema = z.strictObject({ ...base, kind: z.literal('generation'), input: generationInputSchema, result: generationSchema.nullable() })
export type GenerationRecord = z.infer<typeof generationRecordSchema>
export const recordSchema = z.discriminatedUnion('kind', [analysisRecordSchema, generationRecordSchema])
export type TaskRecord = z.infer<typeof recordSchema>
export const modelsSchema = z.strictObject({ models: z.array(z.strictObject({ provider: z.string(), providerName: z.string(), id: z.string(), name: z.string() })), unavailable: z.array(z.string()) })
export type Models = z.infer<typeof modelsSchema>

/** Input image bytes only exist in the bounded upload request, never in durable task JSON. */
export const analyzeInputSchema = z.strictObject({ id: taskIdSchema, route: routeSchema, dimensions: z.array(dimensionSchema).min(1).max(9), files: z.array(z.strictObject({ name: z.string().trim().min(1).max(200), mediaType: imageRefSchema.shape.mediaType, base64: z.string().min(4) })).min(1).max(8) })
export const actionSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('models') }),
  z.strictObject({ operation: z.literal('get'), id: taskIdSchema }),
  z.strictObject({ operation: z.literal('cancel'), id: taskIdSchema }),
  z.strictObject({ operation: z.literal('delete'), id: taskIdSchema }),
  z.strictObject({ operation: z.literal('analyze'), input: analyzeInputSchema }),
  z.strictObject({ operation: z.literal('generate'), id: taskIdSchema, input: generationInputSchema }),
  z.strictObject({ operation: z.literal('export'), id: taskIdSchema }),
])
export type Action = z.infer<typeof actionSchema>

/** Safe expected failure; upstream messages and credentials never become Client error copy. */
export class StylePromptError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'StylePromptError' }
}

/** @param error Failed operation. @returns Stable public code without upstream detail. */
export function failureOf(error: unknown): { code: FailureCode } {
  return { code: error instanceof StylePromptError ? error.code : 'model-error' }
}
