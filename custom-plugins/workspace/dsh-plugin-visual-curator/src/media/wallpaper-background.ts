/** Background-only model inputs never expose the foreground pixels restored by deterministic composition. */
import sharp from 'sharp'
import { CuratorError } from '../shared/errors.ts'
import type { WallpaperPlan, WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperGeometry, wallpaperProtectedBounds } from '../shared/wallpaper-geometry.ts'

/** @param seed Placed source on a transparent target canvas. @param mask Existing source-edge edit mask. @param plan Frozen source regions. @param source Oriented source dimensions. @param settings Target and context margin. @param completeSource Whether complete supporting foregrounds are also erased; frame-contact context stays visible for continuation. @returns One opaque redacted canvas and matching edit mask, without original/detail references. */
export async function wallpaperBackgroundPlate(seed: Uint8Array, mask: Uint8Array, plan: WallpaperPlan, source: { width: number; height: number }, settings: WallpaperSettings, completeSource = false) {
  const geometry = wallpaperGeometry(source, plan, settings)
  const canvas = await sharp(seed).flatten({ background: '#808080' }).removeAlpha().raw().toBuffer()
  const alpha = await sharp(mask).ensureAlpha().extractChannel('alpha').raw().toBuffer()
  const margin = completeSource ? 0 : settings.backgroundContextPixels
  const regions = completeSource ? [...geometry.regions, ...wallpaperGeometry(source, { ...plan, regions: (plan.objectRoles ?? []).filter(object => object.role === 'supporting' && !object.sourceEdges.length).map(object => ({ name: object.name, role: 'subject', rect: object.rect })) }, settings).regions] : geometry.regions
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.left - margin)), right = Math.min(settings.width, Math.ceil(region.left + region.width + margin))
    const top = Math.max(0, Math.floor(region.top - margin)), bottom = Math.min(settings.height, Math.ceil(region.top + region.height + margin))
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { const i = y * settings.width + x; alpha[i] = 0; canvas.fill(128, i * 3, i * 3 + 3) }
  }
  return { image: await sharp(canvas, { raw: { width: settings.width, height: settings.height, channels: 3 } }).png().toBuffer(), mask: await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: '#ffffff' } }).joinChannel(alpha, { raw: { width: settings.width, height: settings.height, channels: 1 } }).png().toBuffer() }
}

/** @param seed Uniformly placed source before generation. @param output Actual final composite. @param plan Frozen source regions. @param source Source dimensions. @param settings Frozen target. @param completeSource Whether to verify the complete retained source frame and every placed pixel instead of inferred regions. @returns Count of protected pixels checked; any changed pixel fails before model acceptance. */
export async function verifyWallpaperPreservation(seed: Uint8Array, output: Uint8Array, plan: WallpaperPlan, source: { width: number; height: number }, settings: WallpaperSettings, completeSource = false): Promise<number> {
  const geometry = wallpaperGeometry(source, plan, settings)
  const expected = await sharp(seed).removeAlpha().raw().toBuffer(), actual = await sharp(output).removeAlpha().raw().toBuffer()
  let compared = 0
  const bounds = wallpaperProtectedBounds(settings), target = geometry.target
  if (completeSource && (target.width !== geometry.width || target.height !== geometry.height || target.left < bounds.critical.left || target.top < bounds.top || target.left + target.width > bounds.critical.right || target.top + target.height > bounds.critical.bottom)) throw new CuratorError('constraint-conflict', 'wallpaper-preservation', 'The complete source frame does not fit the strict safety bounds.')
  for (const region of completeSource ? [target] : geometry.regions) {
    const left = Math.max(0, Math.floor(region.left)), right = Math.min(settings.width, Math.ceil(region.left + region.width)), top = Math.max(0, Math.floor(region.top)), bottom = Math.min(settings.height, Math.ceil(region.top + region.height))
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * settings.width + x) * 3
      if (expected[i] !== actual[i] || expected[i + 1] !== actual[i + 1] || expected[i + 2] !== actual[i + 2]) throw new CuratorError('constraint-conflict', 'wallpaper-preservation', 'Final protected pixels differ from the uniformly placed source. Keep the original and saved generation; do not qualify this image.')
      compared++
    }
  }
  if (!compared || geometry.checks.length) throw new CuratorError('constraint-conflict', 'wallpaper-preservation', 'The preserved source has no valid protected placement.')
  return compared
}
