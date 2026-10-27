/** Only the owner-local dsh Web smoke uses these explicit HTTP responses. */
import type { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { setTimeout } from 'node:timers/promises'
import { mountCurator } from '../../src/host/plugin.ts'
import { CuratorService } from '../../src/host/service.ts'
import { resolveConfig, type CuratorConfig } from '../../src/host/config.ts'
import { CompatibleVisionProvider, SourceHttpProvider } from '../../src/media/index.ts'
import { FixtureHttp } from '../helpers/service-fixture.ts'
import { mountExecutionNavigation } from './execution-navigation.ts'
export const name = 'visual-curator-browser-fixture'
export const inject = ['profileContext', 'storageDomain', 'credentials', 'jobs', 'pluginManager', 'configEditor', 'sessions']
/** @param ctx Real profile services. @returns Normal provider, Remote and resource registration. */
export async function apply(ctx: Context): Promise<void> {
  const http = new FixtureHttp()
  const request = http.request.bind(http)
  // 仅浏览器验收延缓 fixture 视觉响应，提供可见的暂停/恢复窗口；取消仍由同一 signal 控制。
  http.request = async (url, input) => {
    if (url.startsWith('https://vision.example.test')) await setTimeout(1500, undefined, { signal: input.signal })
    return request(url, input)
  }
  http.image = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#536f53' } }).png().toBuffer()
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test/search', credentialRef: '' }, vision: { endpoint: 'https://vision.example.test/chat', model: 'fixture', credentialRef: '', vendorVersion: 'fixture-v1' }, limits: { maxRetryAttempts: 0, maxReferenceImages: 4 } })
  const source = new SourceHttpProvider({ endpoint: config.source.endpoint, method: 'GET', request: { query: 'q', cursor: 'cursor', pageSize: 'limit' }, response: { items: '/items', id: '/id', previewUrl: '/previewUrl', originalUrl: '/originalUrl', nextCursor: '/nextCursor' }, maxPageSize: 20 }, http)
  const vision = async (fixed: CuratorConfig) => new CompatibleVisionProvider({ endpoint: fixed.vision.endpoint, model: fixed.vision.model, supportsMultiImage: true, maxImages: fixed.limits.maxReferenceImages + 2, maxImageBytes: fixed.limits.maxReferenceBytes, maxRequestBytes: fixed.limits.maxVisionRequestBytes, maxOutputTokens: fixed.limits.maxVisionOutputTokens, temperature: 0, declaredModelVersion: 'fixture-v1' }, http)
  const service = new CuratorService(ctx, config, { providers: { source: async () => source, vision, media: () => http } })
  await mountCurator(ctx, service)
  mountExecutionNavigation(ctx, service)
}
