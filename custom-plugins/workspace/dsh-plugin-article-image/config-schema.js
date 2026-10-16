/** Deployment limits and source defaults shared by the Host and package checks. */
import { z } from 'zod'

export const mappingSchema = z.object({ link: z.string().min(1).max(100), category: z.string().max(100).default(''), language: z.string().max(100).default(''), notes: z.string().max(100).default('') }).strict()
const schema = z.object({
  sourceUrl: z.string().url().default('https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'),
  mapping: mappingSchema.default({ link: 'Links', category: 'Category', language: '语言', notes: '备注' }),
  maxCsvBytes: z.number().int().min(1024).max(16000000).default(2000000),
  maxRows: z.number().int().min(1).max(10000).default(2000),
  maxArticleChars: z.number().int().min(1000).max(500000).default(100000),
  minArticleChars: z.number().int().min(100).max(5000).default(200),
  retryLargeHtml: z.boolean().default(true),
  maxArticleHtmlBytes: z.number().int().min(100000).max(32000000).default(8000000),
  maxArticleHtmlChars: z.number().int().min(100000).max(8000000).default(2000000),
  maxArticleElements: z.number().int().min(1000).max(200000).default(50000),
  articleUserAgent: z.string().min(1).max(300).regex(/^[^\r\n]+$/).default('AutoFlow-ArticleImage (+https://github.com/haigepor/dsh-AutoFlow)'),
  maxStateBytes: z.number().int().min(1000000).max(268435456).default(33554432),
  requestTimeoutMs: z.number().int().min(1000).max(600000).default(30000),
  maxRedirects: z.number().int().min(0).max(8).default(3),
  fetchConcurrency: z.number().int().min(1).max(8).default(2),
  pageSize: z.number().int().min(1).max(100).default(30),
  articlePageChars: z.number().int().min(2000).max(20000).default(10000),
  maxWireBytes: z.number().int().min(65536).max(8000000).default(1048576),
  toolResultBytes: z.number().int().min(8000).max(64000).default(16000),
  maxPlanBytes: z.number().int().min(8000).max(100000).default(48000),
  pollIntervalMs: z.number().int().min(1000).max(60000).default(3000),
}).strict().refine(value => value.minArticleChars <= value.maxArticleChars, 'Invalid article limits')

/** Resolve and validate explicit deployment settings. @param {object} input Config fields. @returns {object} Complete settings. */
export function resolveConfig(input = {}) { return schema.parse(input) }
export const Config = { '~standard': { version: 1, vendor: 'dsh-plugin-article-image', validate(input) {
  const result = schema.safeParse(input ?? {})
  return result.success ? { value: result.data } : { issues: result.error.issues }
} } }
