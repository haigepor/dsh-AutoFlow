/** Shared clock drawing and measured white-glyph contrast on the actual clean wallpaper. */
import sharp from 'sharp'
import type { z } from 'zod'
import type { WallpaperSettings } from '../shared/wallpaper.ts'
import type { wallpaperClockContrastPolicySchema, wallpaperClockContrastSchema } from '../shared/wallpaper-policy.ts'

/** @param settings Frozen canvas dimensions. @param controls Include bottom lock-screen controls in the simulation. @returns The same clock glyphs for simulation and pixel inspection. */
export function wallpaperClockSvg(settings: Pick<WallpaperSettings, 'width' | 'height'>, controls = true): Buffer {
  const { width, height } = settings
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="white" font-family="Arial,sans-serif" text-anchor="middle"><text x="${width / 2}" y="550" font-size="80">12 / 09</text><text x="${width / 2}" y="970" font-size="430">09:40</text></g>${controls ? `<g fill="white" fill-opacity=".8"><circle cx="150" cy="${height - 155}" r="60"/><circle cx="${width - 150}" cy="${height - 155}" r="60"/><rect x="${width / 2 - 190}" y="${height - 65}" width="380" height="18" rx="9"/></g>` : ''}</svg>`)
}

/** Measure background contrast at opaque date/time glyph interiors, excluding antialiased edges and bottom controls.
 * @param bytes Actual opaque final pixels. @param imageVersionId Immutable output identity. @param settings Frozen canvas dimensions. @param policy Frozen minimum contrast and readable coverage.
 * @returns Recorded pixel evidence; a passing measurement does not replace visual acceptance.
 */
export async function wallpaperClockContrast(bytes: Uint8Array, imageVersionId: string, settings: Pick<WallpaperSettings, 'width' | 'height'>, policy: z.infer<typeof wallpaperClockContrastPolicySchema>): Promise<z.infer<typeof wallpaperClockContrastSchema>> {
  const mask = await sharp(wallpaperClockSvg(settings, false)).ensureAlpha().extractChannel('alpha').raw().toBuffer()
  const { data, info } = await sharp(bytes).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const linear = (value: number) => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  let glyphPixels = 0, readablePixels = 0, minimumMeasuredRatio = 21
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 255) continue
    const p = i * info.channels
    const luminance = 0.2126 * linear(data[p]!) + 0.7152 * linear(data[p + 1]!) + 0.0722 * linear(data[p + 2]!)
    const ratio = 1.05 / (luminance + 0.05)
    minimumMeasuredRatio = Math.min(minimumMeasuredRatio, ratio); glyphPixels++
    if (ratio >= policy.minimumRatio) readablePixels++
  }
  return { ...policy, imageVersionId, glyphPixels, readablePixels, readableFraction: readablePixels / glyphPixels, minimumMeasuredRatio }
}
