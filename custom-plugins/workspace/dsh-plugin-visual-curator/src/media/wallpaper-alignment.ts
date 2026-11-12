/** Detect whole-source reframing before a generated image is combined with native protected pixels. */
import sharp from 'sharp'
import type { WallpaperPlan, WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'

function correlation(a: Uint8Array, b: Uint8Array): number {
  const averageA = a.reduce((sum, value) => sum + value, 0) / a.length, averageB = b.reduce((sum, value) => sum + value, 0) / b.length
  let covariance = 0, varianceA = 0, varianceB = 0
  for (let index = 0; index < a.length; index++) {
    const da = a[index]! - averageA, db = b[index]! - averageB
    covariance += da * db; varianceA += da * da; varianceB += db * db
  }
  return varianceA && varianceB ? covariance / Math.sqrt(varianceA * varianceB) : 0
}

/** A negative screen catches a source copied across the output instead of kept at its planned position; it never approves image quality.
 * @param original Unmodified source pixels.
 * @param generated Saved provider result before enhancement or composition.
 * @param plan Confirmed placement.
 * @param settings Task-frozen sample dimensions and detection thresholds; an absent policy performs no screen.
 * @param verifyProtection Require the protected source content at its planned position before native recomposition.
 * @returns Measured correlations and a specific reframing signal, or undefined when no screen applies.
 */
export async function wallpaperGenerationAlignment(original: Uint8Array, generated: Uint8Array, plan: WallpaperPlan, settings: WallpaperSettings, verifyProtection = false) {
  const policy = settings.backgroundAlignment
  if (!policy) return undefined
  const source = await sharp(original).metadata(), output = await sharp(generated).metadata()
  if (!source.width || !source.height || !output.width || !output.height) return undefined
  const geometry = wallpaperGeometry({ width: source.width, height: source.height }, plan, settings)
  if (!geometry.needsOutpaint) return undefined
  const sample = (bytes: Uint8Array) => sharp(bytes).resize(policy.sampleWidth, policy.sampleHeight, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer()
  const left = Math.max(0, Math.round(geometry.target.left * output.width / settings.width)), top = Math.max(0, Math.round(geometry.target.top * output.height / settings.height))
  const width = Math.min(output.width - left, Math.max(1, Math.round(geometry.target.width * output.width / settings.width))), height = Math.min(output.height - top, Math.max(1, Math.round(geometry.target.height * output.height / settings.height)))
  const expected = await sharp(generated).extract({ left, top, width, height }).png().toBuffer()
  const sourceCrop = await sharp(original).extract({ left: Math.round((geometry.target.left - geometry.left) / geometry.width * source.width), top: Math.round((geometry.target.top - geometry.top) / geometry.height * source.height), width: Math.min(source.width, Math.round(geometry.target.width / geometry.width * source.width)), height: Math.min(source.height, Math.round(geometry.target.height / geometry.height * source.height)) }).png().toBuffer()
  const [whole, full, cropped, placed] = await Promise.all([sample(original), sample(generated), sample(sourceCrop), sample(expected)])
  const wholeSourceCorrelation = correlation(whole, full), placedSourceCorrelation = correlation(cropped, placed)
  const reframed = wholeSourceCorrelation >= policy.minimumCopyCorrelation && wholeSourceCorrelation - placedSourceCorrelation >= policy.minimumPlacementGap
  let protectedSourceCorrelation: number | undefined
  if (verifyProtection && geometry.regions.length) {
    let weighted = 0, pixels = 0
    for (const region of geometry.regions) {
      const sx = Math.max(0, Math.floor(region.rect.x * source.width)), sy = Math.max(0, Math.floor(region.rect.y * source.height))
      const sw = Math.min(source.width - sx, Math.max(1, Math.round(region.rect.width * source.width))), sh = Math.min(source.height - sy, Math.max(1, Math.round(region.rect.height * source.height)))
      const gx = Math.max(0, Math.round(region.left * output.width / settings.width)), gy = Math.max(0, Math.round(region.top * output.height / settings.height))
      const gw = Math.min(output.width - gx, Math.max(1, Math.round(region.width * output.width / settings.width))), gh = Math.min(output.height - gy, Math.max(1, Math.round(region.height * output.height / settings.height)))
      const [before, after] = await Promise.all([sharp(original).extract({ left: sx, top: sy, width: sw, height: sh }).png().toBuffer().then(sample), sharp(generated).extract({ left: gx, top: gy, width: gw, height: gh }).png().toBuffer().then(sample)])
      const score = before.equals(after) ? 1 : correlation(before, after)
      const area = sw * sh; weighted += score * area; pixels += area
    }
    protectedSourceCorrelation = weighted / pixels
  }
  return { result: reframed ? 'reframed-source' as const : protectedSourceCorrelation !== undefined && protectedSourceCorrelation < policy.minimumProtectedCorrelation ? 'misaligned-source' as const : 'not-detected' as const, wholeSourceCorrelation, placedSourceCorrelation, ...(protectedSourceCorrelation === undefined ? {} : { protectedSourceCorrelation }) }
}
