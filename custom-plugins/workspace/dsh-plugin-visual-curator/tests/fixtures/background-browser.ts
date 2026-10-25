/** Browser-only external gallery fixture; persistence, jobs, HTTP and Client use production code. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout } from 'node:timers/promises'
import { CuratorService } from '../../src/host/service.ts'
import { mountCurator } from '../../src/host/plugin.ts'
import { UnsplashApi } from '../../src/media/unsplash.ts'

export const name = 'visual-curator-background-browser'
export const inject = ['profileContext', 'storageDomain', 'credentials', 'jobs', 'pluginManager', 'configEditor', 'sessions']
const image = 'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=320'
const photo = (index: number) => ({ id: `background-photo-${index}`, width: 1200, height: 800, alt_description: `Fixture photo ${index}`, urls: { small: image, regular: image }, user: { username: 'fixture-artist', name: 'Fixture artist' } })

/** @param ctx Isolated dsh profile services. @returns Normal persisted Host with synthetic gallery responses. */
export async function apply(ctx: Context): Promise<void> {
  const api = new UnsplashApi({ request: async (path, params, bounds) => {
    if (path === '/me') return { id: 'fixture-user', username: 'fixture-user', name: 'Fixture account', total_collections: 1 }
    if (path.startsWith('/users/')) return [{ id: 'background-folder', title: 'Background reference fixture', total_photos: 62, cover_photo: { urls: { small: image } } }]
    if (path.startsWith('/collections/')) {
      const start = (Number(params.page) - 1) * Number(params.per_page)
      return { results: Array.from({ length: Math.min(Number(params.per_page), 62 - start) }, (_, index) => photo(start + index + 1)), total: 62 }
    }
    // 浏览器演示保留足够的交互窗口；单元取消测试使用 barrier，不依赖此延时。
    await setTimeout(250, undefined, { signal: bounds.signal })
    return photo(Number(path.split('-').at(-1)))
  } })
  await mountCurator(ctx, new CuratorService(ctx, {
    source: { provider: 'unsplash', unsplash: { defaultAccountId: 'fixture', accounts: [{ id: 'fixture', userId: 'fixture-user', username: 'fixture-user', name: 'Fixture account', label: 'Fixture gallery', credentialRef: 'VISUAL_CURATOR_FIXTURE_ONLY' }], cache: { ttlMs: 1 } } },
    vision: { endpoint: 'https://vision.example.test/chat', model: 'fixture', credentialRef: '' },
    limits: { pageSize: 10, maxImportFiles: 5, pollIntervalMs: 500 },
  }, { galleryApi: async () => api }))
}
