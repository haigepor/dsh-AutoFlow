/** All new reconstruction uses ESPCN, including explicitly resumed historical policies. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { enhanceWallpaper, superResolveWallpaperBackground } from '../src/media/clarity.ts'
import { claritySettingsSchema, espcnWeightsDigest, resolveEspcnClarity } from '../src/shared/clarity.ts'
import { backgroundResolutionSettingsSchema, resolveEspcnBackground } from '../src/shared/background-resolution.ts'
import { applyWallpaperEspcn, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'

test('new policies select ESPCN and old policies remain readable without changing saved evidence', () => {
  assert.equal(claritySettingsSchema.parse({}).version, 'espcn-luma-v1')
  assert.equal(backgroundResolutionSettingsSchema.parse({}).version, 'espcn-background-v1')
  const oldClarity = claritySettingsSchema.parse({ version: 'realesrgan-general-v1' })
  const oldBackground = backgroundResolutionSettingsSchema.parse({ version: 'realesrgan-background-v1' })
  assert.equal(resolveEspcnClarity(oldClarity).version, 'espcn-luma-v1')
  assert.equal(resolveEspcnBackground(oldBackground).version, 'espcn-background-v1')
  assert.equal(resolveEspcnBackground(oldBackground).timeoutMs, 120_000)
  const settings = wallpaperSettingsSchema.parse({ clarity: oldClarity, backgroundResolution: oldBackground })
  applyWallpaperEspcn(settings)
  assert.equal(settings.clarity?.version, 'espcn-luma-v1')
  assert.equal(settings.backgroundResolution?.version, 'espcn-background-v1')
  assert.equal(oldClarity.version, 'realesrgan-general-v1')
  assert.equal(oldBackground.version, 'realesrgan-background-v1')
})

test('historical model selectors execute the bundled ESPCN worker for background and subject pixels', async () => {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#345678' } }).png().toBuffer()
  const background = await superResolveWallpaperBackground({ bytes, width: 128, height: 128, policy: backgroundResolutionSettingsSchema.parse({ version: 'realesrgan-background-v1' }), maxPixels: 100_000 }, new AbortController().signal)
  assert.equal(background.model, 'espcn-x3-luma')
  assert.equal(background.modelSha256, espcnWeightsDigest)
  assert.deepEqual([background.nativeOutputWidth, background.nativeOutputHeight], [192, 192])
  assert.deepEqual([background.outputWidth, background.outputHeight], [128, 128])
  const subject = await enhanceWallpaper({ bytes, regions: [{ left: 0, top: 0, width: 64, height: 64 }], protectedRegions: [], maxPixels: 100_000, policy: claritySettingsSchema.parse({ version: 'realesrgan-general-v1' }) }, new AbortController().signal)
  assert.equal(subject.model, 'espcn-x3-luma')
  assert.equal(subject.modelSha256, espcnWeightsDigest)
})
