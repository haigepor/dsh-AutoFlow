/** Validated wire and disk records; article text is untrusted source material. */
import { z } from 'zod'
import { analysisPlanSchema } from './analysis-contracts.js'
export const PACKAGE = 'dsh-plugin-article-image'
export const idSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const textSchema = z.string().trim().min(1).max(10000)
export const ratioSchema = z.enum(['16:9', '4:3', '3:2', '1:1', '9:16'])
export const legacyPlanSchema = z.object({
  sourceHash: hashSchema,
  brief: z.object({ theme: textSchema, facts: z.array(textSchema).min(1).max(30), subjects: z.array(textSchema).min(1).max(30), scenes: z.array(textSchema).min(1).max(30) }).strict(),
  shots: z.array(z.object({ purpose: z.enum(['cover', 'inline']), paragraphs: z.array(z.number().int().positive()).min(1).max(50),
    rationale: textSchema, subject: textSchema, action: textSchema, environment: textSchema, composition: textSchema, lighting: textSchema,
    colors: textSchema, style: textSchema, details: textSchema, avoid: textSchema, prompt: textSchema, ratio: ratioSchema,
  }).strict()).min(1).max(12),
}).strict().refine(value => value.shots.filter(shot => shot.purpose === 'cover').length === 1, 'Exactly one cover is required')
export const planSchema = z.union([analysisPlanSchema, legacyPlanSchema])
export const revisionInput = z.object({ id: idSchema, revision: z.number().int().positive() }).strict()
export const articleSchema = z.object({ title: z.string().max(2000), url: z.string().url(), language: z.string().max(100),
  paragraphs: z.array(z.object({ id: z.number().int().positive(), text: z.string().min(1).max(2000) }).strict()).min(1),
  hash: hashSchema, fetchedAt: z.string(), basis: z.enum(['web', 'manual']),
}).strict()
const diagnosticCode = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(100)
const diagnosticNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Bounded diagnostics omit page text, credentials, URL paths and query parameters. */
export const runEventSchema = z.object({ seq: diagnosticNumber, at: z.string().datetime(), stage: diagnosticCode, event: diagnosticCode,
  details: z.object({ code: diagnosticCode.optional(), origin: z.string().max(300).refine(value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === value } catch { return false } }).optional(),
    resourceType: diagnosticCode.optional(), statusCode: diagnosticNumber.optional(), elapsedMs: diagnosticNumber.optional(), bytes: diagnosticNumber.optional(), chars: diagnosticNumber.optional(),
    blocks: diagnosticNumber.optional(), assets: diagnosticNumber.optional(), completed: diagnosticNumber.optional(), total: diagnosticNumber.optional(), limitMs: diagnosticNumber.optional(), diagnostics: z.array(diagnosticCode).max(30).optional(),
    operation: diagnosticCode.optional(), causeCode: diagnosticCode.optional(), errorType: diagnosticCode.optional(), causes: z.array(diagnosticCode).max(5).optional(),
    downloadMs: diagnosticNumber.optional(), decodeMs: diagnosticNumber.optional(), chargedBytes: diagnosticNumber.optional(), attempt: diagnosticNumber.optional(),
    blockId: z.string().regex(/^b[1-9]\d{0,5}$/).optional(),
  }).strict(),
}).strict()
export const runSchema = z.object({ id: idSchema, attemptId: idSchema, pid: z.number().int(), stage: z.string().max(100),
  status: z.enum(['queued', 'running', 'review', 'approved', 'failed', 'cancelled', 'interrupted', 'waiting-config', 'needs-source-review']),
  startedAt: z.string(), updatedAt: z.string(), error: z.string().nullable(), sourceHash: hashSchema.nullable(),
  counts: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), assetsCompleted: z.number().int().nonnegative().optional(), assetsTotal: z.number().int().nonnegative().optional(), blocksCompleted: z.number().int().nonnegative().optional(), blocksTotal: z.number().int().nonnegative().optional() }).strict(),
  checkpoints: z.array(z.object({ stageId: z.string(), ref: idSchema }).strict()), inputRef: idSchema.nullable(),
  metadataHash: hashSchema.nullable().default(null),
  events: z.array(runEventSchema).max(200).default([]), eventsDropped: diagnosticNumber.default(0),
}).strict()
export const itemSchema = z.object({ id: idSchema, url: z.string().url(), sourceKey: z.string(), category: z.string(), language: z.string(), notes: z.string(),
  rows: z.array(z.number().int().positive()), raw: z.record(z.string(), z.string()), revision: z.number().int().positive(),
  state: z.enum(['imported', 'fetching', 'ready', 'review', 'approved', 'failed', 'interrupted', 'skipped', 'queued', 'capturing', 'understanding', 'planning', 'checking', 'cancelled', 'waiting-config', 'needs-source-review']),
  article: articleSchema.nullable(), plan: planSchema.nullable(), approval: z.object({ revision: z.number().int(), sourceHash: hashSchema, planHash: hashSchema, at: z.string(), inputHash: hashSchema.optional(), origin: z.literal('workbench').optional() }).strict().nullable(),
  error: z.string().nullable(), fetching: z.object({ pid: z.number().int(), token: z.string() }).strict().nullable(),
  snapshotRef: idSchema.nullable().default(null), analysisRef: idSchema.nullable().default(null), planRef: idSchema.nullable().default(null),
  legacy: z.boolean().default(false), run: runSchema.nullable().default(null),
  sourceReview: z.object({ sourceHash: hashSchema, evidence: z.string().trim().min(1).max(4000), at: z.string() }).strict().nullable().default(null),
}).strict()

/** Create a safe machine error without remote URLs or credential-bearing text. @param {string} code Failure code. @returns {Error} Safe error. */
export function failure(code) { return Object.assign(new Error(code), { code }) }

/** Translate only owned errors across the Remote; unknown upstream text is withheld. @param {unknown} error Failure. @returns {string} Safe code. */
export function errorCode(error) { return error instanceof z.ZodError ? 'invalid-request' : error instanceof Error && error.code?.length <= 64 && /^[a-z]+(?:-[a-z]+)+$/.test(error.code) ? error.code : 'operation-failed' }
