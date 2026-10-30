/** Explicit profile-owned model choices, independent from account capability discovery. */
import { z } from 'zod'

/** A model ID is sent upstream unchanged; image models never enter the conversational adapter. */
export const catalogEntrySchema = z.strictObject({
  kind: z.enum(['text', 'image']), id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/), name: z.string().trim().min(1).max(200),
  nativeWebSearch: z.boolean().optional(),
})
/** Entries are unique by output kind and upstream route ID. */
export const catalogEntriesSchema = z.array(catalogEntrySchema).max(256).refine(entries => new Set(entries.map(entry => `${entry.kind}:${entry.id}`)).size === entries.length, 'Duplicate model')
/** Safe, detached catalog used by method callers and the settings page. */
export const modelCatalogSchema = z.object({ revision: z.number().int().nonnegative(), entries: catalogEntriesSchema, defaultImageModel: z.string(),
  candidates: z.array(z.object({ id: z.string(), name: z.string(), nativeWebSearch: z.boolean().optional(), contextWindow: z.number().optional(), maxTokens: z.number().optional(), input: z.array(z.enum(['text', 'image'])).optional() })),
})
/** Compare-and-swap input; a default image model changes only when explicitly supplied. */
export const saveModelCatalogSchema = z.strictObject({ revision: z.number().int().nonnegative(), entries: catalogEntriesSchema, defaultImageModel: z.string().min(1).max(128).optional() })
/** One user-selected text or image model, without account or credential references. */
export type CatalogEntry = z.infer<typeof catalogEntrySchema>
/** Credential-free model configuration and discovered text candidates. */
export type ModelCatalog = z.infer<typeof modelCatalogSchema>
