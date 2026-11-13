/** Safe image catalogs shared by settings and task admission. */
import { z } from 'zod'
import { wallpaperSettingsSchema } from '../shared/wallpaper.ts'

export const imageOptionsSchema = z.object({
  settings: wallpaperSettingsSchema,
  models: z.array(z.object({ id: z.string(), name: z.string() })),
  providers: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string() })), sources: z.array(z.object({ id: z.string(), name: z.string(), available: z.boolean(), models: z.array(z.object({ id: z.string(), name: z.string() })).optional(), modelError: z.string().optional() })) })),
})
export type ImageOptions = z.infer<typeof imageOptionsSchema>

/** Resolve the visible model catalog for one explicitly selected source. */
export function imageModelsForRoute(options: Pick<ImageOptions, 'providers'> | null, route: Pick<z.infer<typeof wallpaperSettingsSchema>, 'imageProvider' | 'imageSourceId'>): ImageOptions['models'] {
  const provider = options?.providers.find(item => item.id === route.imageProvider)
  const source = provider?.sources.find(item => item.id === route.imageSourceId)
  return source?.models ?? provider?.models ?? []
}

/** A newly chosen official key starts with its first advertised model. */
export function defaultImageModel(options: Pick<ImageOptions, 'providers'> | null, route: Pick<z.infer<typeof wallpaperSettingsSchema>, 'imageProvider' | 'imageSourceId'>): string {
  return route.imageProvider === 'visual-curator-openai' && route.imageSourceId ? imageModelsForRoute(options, route)[0]?.id ?? '' : ''
}

/** A new task must name an available image route before it can be accepted. */
export function imageRouteReady(options: Pick<ImageOptions, 'providers'> | null, route: Pick<z.infer<typeof wallpaperSettingsSchema>, 'imageProvider' | 'imageSourceId' | 'imageModel'>): boolean {
  const provider = options?.providers.find(item => item.id === route.imageProvider)
  const models = imageModelsForRoute(options, route)
  if (!provider || !models.length || route.imageModel && !models.some(model => model.id === route.imageModel)) return false
  if (!route.imageSourceId) return provider.id === 'autoflow-codex'
  return provider.sources.some(source => source.id === route.imageSourceId && source.available)
}
