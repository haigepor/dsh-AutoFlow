/** Static display images keep original sources out of both browser decodes and waiting native work. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'

describe('static display previews', () => {
  async function fixture() {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-display-preview-'))
    return {
      store: new LocalAttachmentStore(new Context(), { dshHome, imageCompressionConcurrency: 1 }),
      cleanup: () => rm(dshHome, { recursive: true, force: true }),
    }
  }

  it('reduces a real 9504×6336 JPEG, preserves source bytes, and caches by immutable source version', async () => {
    const f = await fixture()
    try {
      const bytes = await sharp({ create: { width: 9504, height: 6336, channels: 3, background: '#567a82' } }).jpeg().toBuffer()
      const before = Buffer.from(bytes), load = vi.fn(async () => ({ data: bytes, mediaType: 'image/jpeg' as const }))
      const image = await f.store.readImagePreview({ cacheKey: 'world-a:file-a:version-1', load })
      const metadata = await sharp(image.data).metadata()
      expect(metadata.width).toBeLessThanOrEqual(1024)
      expect(metadata.width).toBeGreaterThan(1000)
      expect(metadata.width / metadata.height).toBe(3 / 2)
      expect(image.width * image.height).toBeLessThanOrEqual(1024 * 1024)
      expect(image.bytes).toBeLessThanOrEqual(1024 * 1024)
      expect(image.mediaType).toBe(`image/${metadata.format}`)
      expect(bytes).toEqual(before)
      expect((await f.store.readImagePreview({ cacheKey: 'world-a:file-a:version-1', load })).data).toEqual(image.data)
      expect(load).toHaveBeenCalledTimes(1)
      await f.store.readImagePreview({ cacheKey: 'world-a:file-a:version-2', load })
      await f.store.readImagePreview({ cacheKey: 'world-b:file-a:version-1', load })
      expect(load).toHaveBeenCalledTimes(3)
    } finally { await f.cleanup() }
  })

  it('does not load waiting sources, skips cancelled queued work and preserves independent shared waiters', async () => {
    const f = await fixture()
    try {
      const data = await sharp({ create: { width: 32, height: 16, channels: 3, background: 'green' } }).png().toBuffer()
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve }), started = new Promise<void>((resolve) => { entered = resolve })
      const load = vi.fn(async () => { entered(); await gate; return { data, mediaType: 'image/png' as const } })
      const first = new AbortController(), queued = new AbortController(), waitingLoad = vi.fn(async () => ({ data, mediaType: 'image/png' as const }))
      const a = f.store.readImagePreview({ cacheKey: 'shared', load }, first.signal), b = f.store.readImagePreview({ cacheKey: 'shared', load })
      const cancelled = f.store.readImagePreview({ cacheKey: 'waiting', load: waitingLoad }, queued.signal)
      const aRejected = expect(a).rejects.toMatchObject({ name: 'AbortError' }), cancelledRejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      await started
      expect(waitingLoad).not.toHaveBeenCalled()
      first.abort(); queued.abort(); await Promise.all([aRejected, cancelledRejected])
      release(); expect((await b).width).toBe(32)
      await f.store.readImagePreview({ cacheKey: 'drain', load: waitingLoad })
      expect(load).toHaveBeenCalledTimes(1)
      expect(waitingLoad).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
  })

  it('uses existing EXIF and alpha normalization and rejects malformed or oversized sources without original fallback', async () => {
    const f = await fixture()
    try {
      const data = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
      const rotated = await f.store.readImagePreview({ cacheKey: 'rotated', load: async () => ({ data, mediaType: 'image/jpeg' }) })
      expect([rotated.width, rotated.height]).toEqual([40, 80])
      const alpha = await sharp({
        create: { width: 32, height: 16, channels: 4, background: { r: 30, g: 60, b: 90, alpha: 0.3 } },
      }).png().toBuffer()
      const transparent = await f.store.readImagePreview({ cacheKey: 'alpha', load: async () => ({ data: alpha, mediaType: 'image/png' }) })
      expect((await sharp(transparent.data).metadata()).hasAlpha).toBe(true)
      await expect(f.store.readImagePreview({ cacheKey: 'broken', load: async () => ({ data: new Uint8Array([1, 2]), mediaType: 'image/png' }) })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
      const tiny = new LocalAttachmentStore(new Context(), { dshHome: f.store.root, maxImagePixels: 1 })
      await expect(tiny.readImagePreview({ cacheKey: 'big-pixels', load: async () => ({ data, mediaType: 'image/jpeg' }) })).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
      const byteLimited = new LocalAttachmentStore(new Context(), { dshHome: f.store.root, maxImageBytes: 1 })
      await expect(byteLimited.readImagePreview({ cacheKey: 'big-bytes', load: async () => ({ data, mediaType: 'image/jpeg' }) })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    } finally { await f.cleanup() }
  })

  it('keeps a nineteen-source burst unread until each native slot is available', async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), started = new Promise<void>((resolve) => { entered = resolve })
    try {
      const data = await sharp({ create: { width: 32, height: 16, channels: 3, background: 'blue' } }).png().toBuffer()
      let reads = 0
      const pending = Array.from({ length: 19 }, (_, index) => f.store.readImagePreview({ cacheKey: `burst-${index}`, load: async () => { reads++; if (index === 0) { entered(); await gate }; return { data, mediaType: 'image/png' } } }))
      await started
      expect(reads).toBe(1)
      release()
      const images = await Promise.all(pending)
      expect(reads).toBe(19); expect(images).toHaveLength(19)
      expect(images.every(image => image.width === 32 && image.height === 16)).toBe(true)
    } finally { release(); await f.cleanup() }
  })
})
