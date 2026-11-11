/** Official publication and subscription execution are independent observations. */
import { z } from 'zod'

/** A probe never infers access from a model name or a successful invalid-model control. */
export const imageCheckStateSchema = z.enum(['untested', 'checking', 'verified', 'rejected', 'indeterminate', 'blocked', 'outcome-unknown'])
/** Credential-free per-account evidence; task IDs point to existing durable image receipts. */
export const imageModelCheckSchema = z.strictObject({ accountKey: z.string(), label: z.string(), state: imageCheckStateSchema,
  checkedAt: z.number().optional(), taskId: z.string().optional(), errorCode: z.string().optional() })
/** Discovered models come only from links in the official public model index. */
export const officialImageModelSchema = z.strictObject({ id: z.string(), name: z.string(), url: z.string().url() })
/** Safe live projection for model settings; absence supports an older optional subscription plugin. */
export const imageCatalogViewSchema = z.strictObject({ sourceUrl: z.string().url(), status: z.enum(['idle', 'refreshing', 'ready', 'error']),
  autoProbe: z.boolean(), pollIntervalMs: z.number().int().positive(), checkedAt: z.number().optional(), errorCode: z.string().optional(),
  entries: z.array(officialImageModelSchema.extend({ checks: z.array(imageModelCheckSchema) })) })
/** Public model discovery and verification state, without credentials or remote image URLs. */
export type ImageCatalogView = z.infer<typeof imageCatalogViewSchema>
