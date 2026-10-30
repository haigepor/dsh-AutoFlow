/** Deployment limits for API admission, durable history and bounded model output. */
import { z } from 'zod'

const fields = z.strictObject({
  maxImages: z.number().int().min(1).max(8).default(4),
  maxImageBytes: z.number().int().positive().default(8 * 1024 * 1024),
  maxUploadBytes: z.number().int().positive().default(32 * 1024 * 1024),
  maxRequestBytes: z.number().int().positive().default(48 * 1024 * 1024),
  maxResponseBytes: z.number().int().positive().default(256 * 1024),
  requestTimeoutMs: z.number().int().min(1000).max(3_600_000).default(180_000),
  maxOutputTokens: z.number().int().min(256).max(32768).default(8192),
  temperature: z.number().min(0).max(2).default(0.2),
  maxConcurrentTasks: z.number().int().min(1).max(8).default(2),
  maxStoredTasks: z.number().int().min(1).max(10000).default(200),
  maxHistoryItems: z.number().int().min(1).max(200).default(50),
  pollIntervalMs: z.number().int().min(250).max(10000).default(1000),
})
export const Config = fields.default(() => fields.parse({}))
export type Config = z.infer<typeof Config>
