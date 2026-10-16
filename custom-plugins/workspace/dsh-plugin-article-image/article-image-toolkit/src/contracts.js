/** Validated wire and disk records; article text is untrusted source material. */
import { z } from 'zod'
export const PACKAGE = 'article-image-toolkit'
export const idSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const textSchema = z.string().trim().min(1).max(10000)
export const ratioSchema = z.enum(['16:9', '4:3', '3:2', '1:1', '9:16'])
export const planSchema = z.object({
  sourceHash: hashSchema,
  brief: z.object({ theme: textSchema, facts: z.array(textSchema).min(1).max(30), subjects: z.array(textSchema).min(1).max(30), scenes: z.array(textSchema).min(1).max(30) }).strict(),
  shots: z.array(z.object({ purpose: z.enum(['cover', 'inline']), paragraphs: z.array(z.number().int().positive()).min(1).max(50),
    rationale: textSchema, subject: textSchema, action: textSchema, environment: textSchema, composition: textSchema, lighting: textSchema,
    colors: textSchema, style: textSchema, details: textSchema, avoid: textSchema, prompt: textSchema, ratio: ratioSchema,
  }).strict()).min(1).max(12),
}).strict().refine(value => value.shots.filter(shot => shot.purpose === 'cover').length === 1, 'Exactly one cover is required')
export const revisionInput = z.object({ id: idSchema, revision: z.number().int().positive() }).strict()
export const articleSchema = z.object({ title: z.string().max(2000), url: z.string().url(), language: z.string().max(100),
  paragraphs: z.array(z.object({ id: z.number().int().positive(), text: z.string().min(1).max(2000) }).strict()).min(1),
  hash: hashSchema, fetchedAt: z.string(), basis: z.enum(['web', 'manual']),
}).strict()
export const itemSchema = z.object({ id: idSchema, url: z.string().url(), sourceKey: z.string(), category: z.string(), language: z.string(), notes: z.string(),
  rows: z.array(z.number().int().positive()), raw: z.record(z.string(), z.string()), revision: z.number().int().positive(),
  state: z.enum(['imported', 'ready', 'review', 'approved', 'failed', 'skipped']),
  article: articleSchema.nullable(), plan: planSchema.nullable(), approval: z.object({ revision: z.number().int(), sourceHash: hashSchema, planHash: hashSchema, at: z.string() }).strict().nullable(),
  error: z.string().nullable(),
}).strict()

/** Create a safe machine error without remote URLs or credential-bearing text. @param {string} code Failure code. @returns {Error} Safe error. */
export function failure(code) { return Object.assign(new Error(code), { code }) }

/** Translate only owned errors across the wire; unknown upstream text is withheld. @param {unknown} error Failure. @returns {string} Safe code. */
export function errorCode(error) { return error instanceof z.ZodError ? 'invalid-request' : error instanceof Error && error.code?.length <= 64 && /^[a-z]+(?:-[a-z]+)+$/.test(error.code) ? error.code : 'operation-failed' }
