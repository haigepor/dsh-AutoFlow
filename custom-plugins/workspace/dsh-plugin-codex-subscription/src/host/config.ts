/** Validated request limits and editable profile fields; authentication never lives in Config. */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { catalogEntriesSchema } from '../shared/model-catalog.ts'

const positive = z.number().int().positive()
const images = z.strictObject({
  defaultModel: z.string().min(1).max(128).default('gpt-image-2'),
  timeoutMs: positive.min(1000).max(3_600_000).default(300_000),
  quickWaitMs: z.number().int().min(0).max(20_000).default(20_000),
  uiPollIntervalMs: positive.min(250).max(30_000).default(1000),
  maxConcurrent: positive.max(16).default(2),
  maxQueued: z.number().int().min(0).max(100).default(16),
  maxHistoryTasks: positive.max(10_000).default(500),
  maxReferenceImages: positive.max(16).default(8),
  maxImageBytes: positive.max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  maxResponseBytes: positive.max(256 * 1024 * 1024).default(64 * 1024 * 1024),
  maxPromptChars: positive.max(100_000).default(32_000),
  maxRedirects: z.number().int().min(0).max(8).default(3),
})
const relay = z.strictObject({
  enabled: z.boolean().default(false),
  host: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  port: positive.max(65535).default(3426),
  allowedOrigins: z.array(z.string().url().refine(value => new URL(value).origin === value, 'Use exact origins')).max(16).default([]),
  maxRequestBytes: positive.max(128 * 1024 * 1024).default(32 * 1024 * 1024),
  maxResponseBytes: positive.max(256 * 1024 * 1024).default(64 * 1024 * 1024),
  requestTimeoutMs: positive.max(3_600_000).default(3_600_000),
  maxConcurrentRequests: positive.max(64).default(8),
  assetUrlTtlMs: positive.max(3_600_000).default(60_000),
})
const options = z.strictObject({
  catalog: catalogEntriesSchema.default([]),
  images: images.default(() => images.parse({})),
  relay: relay.default(() => relay.parse({})),
  upstream: z.strictObject({ mode: z.enum(['auto', 'sse']).default('auto'), connectTimeoutMs: positive.max(120_000).default(30_000),
    cooldownMs: positive.max(3_600_000).default(600_000), closeTimeoutMs: positive.max(30_000).default(1000),
    maxMessageBytes: positive.max(128 * 1024 * 1024).default(16 * 1024 * 1024), maxRequestBytes: positive.max(128 * 1024 * 1024).default(32 * 1024 * 1024),
    maxBufferedBytes: positive.max(256 * 1024 * 1024).default(32 * 1024 * 1024), maxBufferedFrames: positive.max(256).default(16),
  }).default(() => ({ mode: 'auto' as const, connectTimeoutMs: 30_000, cooldownMs: 600_000, closeTimeoutMs: 1000,
    maxMessageBytes: 16 * 1024 * 1024, maxRequestBytes: 32 * 1024 * 1024, maxBufferedBytes: 32 * 1024 * 1024, maxBufferedFrames: 16 })),
  models: z.strictObject({ fallbackMaxTokens: positive.max(1_048_576).default(8192) }).default(() => ({ fallbackMaxTokens: 8192 })),
  version: z.strictObject({ discoverLocal: z.boolean().default(true), probeIntervalMs: positive.max(3_600_000).default(600_000),
    maxCacheBytes: positive.max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  }).default(() => ({ discoverLocal: true, probeIntervalMs: 600_000, maxCacheBytes: 4 * 1024 * 1024 })),
})

/** Complete deployment values captured by newly admitted requests. */
export type SubscriptionOptions = z.infer<typeof options>

/** Loader configuration: static auth compatibility and live image/relay settings. */
export interface Config {
  clientVersion: string
  loginTimeoutMs: number
  tokenTimeoutMs: number
  discoveryTtlMs: number
  cooldownMs: number
  sessionAffinityLimit: number
  streamIdleTimeoutMs: number
  requestTimeoutMs: number
  maxRequestImageBytes: number
  requestImagePixelBudget: number
  requestImageMaxBytes: number
  options: { get(): unknown }
}

/** Editable settings are volatile so the existing Settings service owns persistence. */
export const Config = Schema.object({
  clientVersion: Schema.string().default('0.159.0'),
  loginTimeoutMs: Schema.natural().min(1000).max(600_000).default(600_000),
  tokenTimeoutMs: Schema.natural().min(1000).max(60_000).default(30_000),
  discoveryTtlMs: Schema.natural().min(1000).default(60_000),
  cooldownMs: Schema.natural().min(1000).default(60_000),
  sessionAffinityLimit: Schema.natural().min(1).max(10_000).default(512),
  streamIdleTimeoutMs: Schema.natural().min(1000).default(120_000),
  requestTimeoutMs: Schema.natural().min(1000).max(3_600_000).default(3_600_000),
  maxRequestImageBytes: Schema.natural().min(1).default(32 * 1024 * 1024),
  requestImagePixelBudget: Schema.natural().min(1).default(80_000_000),
  requestImageMaxBytes: Schema.natural().min(1).default(20 * 1024 * 1024),
  options: Schema.any().default({}).volatile(),
})

/** Parse configuration before publishing it or opening a listener.
 * @param input Plain editable fields from the profile.
 * @returns Fully resolved, detached settings.
 */
export function resolveOptions(input: unknown): SubscriptionOptions { return options.parse(input) }
