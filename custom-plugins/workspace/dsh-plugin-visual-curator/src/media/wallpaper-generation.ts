/** Ordered native-pixel references and a frozen, scene-specific background editing request. */
import sharp from 'sharp'
import type { WallpaperPlan, WallpaperItem, WallpaperSettings } from '../shared/wallpaper.ts'

type Region = WallpaperPlan['regions'][number]['rect']
type Reference = { data: Uint8Array; mediaType: 'image/png' | 'image/webp'; name: string; role: 'canvas' | 'original' | 'subject-detail' | 'critical-detail' | 'layout-only'; sourceRect?: Region }

/** Prepare the edit canvas, original, native detail crops and a separately labelled layout guide.
 * @param original Verified, oriented source pixels. @param canvas Unmarked target canvas. @param layout Diagnostic safe-area overlay. @param plan Current inferred protection regions.
 * @returns Ordered lossless image inputs; the full original uses exact WebP and all other images remain PNG. The edit mask belongs only to the first image. Attachment admission may further normalize these references.
 */
export async function wallpaperGenerationReferences(original: Uint8Array, canvas: Uint8Array, layout: Uint8Array, plan: WallpaperPlan): Promise<Reference[]> {
  const metadata = await sharp(original).metadata(), width = metadata.width!, height = metadata.height!
  const references: Reference[] = [
    { data: canvas, mediaType: 'image/png', name: 'wallpaper-canvas.png', role: 'canvas' },
    { data: await sharp(original).webp({ lossless: true, exact: true }).toBuffer(), mediaType: 'image/webp', name: 'wallpaper-original.webp', role: 'original' },
  ]
  const crop = async (rect: Region, role: 'subject-detail' | 'critical-detail') => {
    const left = Math.max(0, Math.floor(rect.x * width)), top = Math.max(0, Math.floor(rect.y * height))
    const right = Math.min(width, Math.ceil((rect.x + rect.width) * width)), bottom = Math.min(height, Math.ceil((rect.y + rect.height) * height))
    references.push({ data: await sharp(original).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer(), mediaType: 'image/png', name: `wallpaper-${role}.png`, role, sourceRect: { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height } })
  }
  const subjects = plan.regions.filter(region => region.role === 'subject')
  if (subjects.length) {
    const x = Math.min(...subjects.map(region => region.rect.x)), y = Math.min(...subjects.map(region => region.rect.y))
    await crop({ x, y, width: Math.max(...subjects.map(region => region.rect.x + region.rect.width)) - x, height: Math.max(...subjects.map(region => region.rect.y + region.rect.height)) - y }, 'subject-detail')
  }
  const critical = plan.regions.filter(region => region.role === 'critical').sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]
  if (critical) await crop(critical.rect, 'critical-detail')
  references.push({ data: layout, mediaType: 'image/png', name: 'wallpaper-layout-only.png', role: 'layout-only' })
  return references
}

/** Freeze model-authored scene instructions together with exact reference roles and known review defects.
 * @param instruction Versioned background-only policy. @param plan Current model observation and scene edit brief. @param settings Frozen target geometry. @param references Ordered references after attachment normalization. @param attempts Retained attempts, including independent failed reviews.
 * @returns Exact prompt submitted to image generation; no prior verdict is promoted to current acceptance.
 */
export function wallpaperGenerationPrompt(instruction: string, plan: WallpaperPlan, settings: WallpaperSettings, references: readonly { role: Reference['role']; width: number; height: number; sourceRect?: Region }[], attempts: WallpaperItem['attempts']): string {
  const prior = attempts.findLast(attempt => attempt.review)?.review
  return `${instruction}\n${JSON.stringify({ sceneEditPrompt: plan.editPrompt ?? { subject: plan.subject, evidence: plan.evidence, priorities: plan.priorities, anchors: plan.anchors, reason: plan.reason }, referenceRoles: references.map((reference, index) => ({ image: index + 1, ...reference })), template: { width: settings.width, height: settings.height, safe: settings.safe, topBuffer: settings.topBuffer }, placement: plan.placement, protectedRegions: plan.regions, previousDefects: prior ? Object.entries(prior.checks).filter(([, check]) => check.result !== 'satisfied').map(([check, result]) => ({ check, ...result })) : [] })}`
}
