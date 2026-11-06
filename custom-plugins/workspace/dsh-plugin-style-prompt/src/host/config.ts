/** Local request, storage and lifetime limits; native model settings own generation controls. */
import { z } from 'zod'

const fields = z.strictObject({
  maxImages: z.number().int().min(1).max(8).default(4),
  maxImageBytes: z.number().int().positive().default(8 * 1024 * 1024),
  maxUploadBytes: z.number().int().positive().default(32 * 1024 * 1024),
  maxRequestBytes: z.number().int().positive().default(48 * 1024 * 1024),
  maxResponseBytes: z.number().int().positive().default(256 * 1024),
  requestTimeoutMs: z.number().int().min(1000).max(3_600_000).default(180_000),
  // Existing profile patches may contain these keys; resolved limits discard them.
  maxOutputTokens: z.number().int().min(256).max(32768).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(8).default(2),
  maxStoredTasks: z.number().int().min(1).max(10000).default(200),
  maxHistoryItems: z.number().int().min(1).max(200).default(50),
  pollIntervalMs: z.number().int().min(250).max(10000).default(1000),
  maxCanvases: z.number().int().min(1).max(1000).default(50),
  maxCanvasAssets: z.number().int().min(1).max(10000).default(500),
  canvasAssetGraceMs: z.number().int().min(1000).max(86_400_000).default(900_000),
  maxCanvasFileBytes: z.number().int().positive().default(16 * 1024 * 1024),
  maxCanvasRuns: z.number().int().min(1).max(10000).default(200),
  maxConcurrentCanvasRuns: z.number().int().min(1).max(8).default(2),
  imageTimeoutMs: z.number().int().min(1000).max(3_600_000).default(600000),
  canvasSaveDelayMs: z.number().int().min(100).max(10000).default(600),
}).transform(({ maxOutputTokens: _legacyMaxOutputTokens, temperature: _legacyTemperature, ...value }) => ({ ...value, maxCanvasFileBytes: Math.min(value.maxCanvasFileBytes, Math.max(1, value.maxRequestBytes - 512)) }))
export const Config = fields.default(() => fields.parse({}))
export type Config = z.infer<typeof Config>
