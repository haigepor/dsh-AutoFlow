/** Source-normalized annotations share the Host's rounded, isotropic placement. */
import type { WallpaperPlan } from '../shared/wallpaper.ts'

type Rect = WallpaperPlan['regions'][number]['rect']
type Point = { x: number; y: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** @param source Full-resolution source dimensions. @param plan Editable placement. @returns The same rounded image dimensions used by rendering. */
export function wallpaperEditorImageSize(source: { width: number; height: number }, plan: WallpaperPlan) {
  return { width: Math.max(1, Math.round(source.width * plan.placement.scale)), height: Math.max(1, Math.round(source.height * plan.placement.scale)) }
}

/** @param rect Current source-normalized rectangle. @param patch Requested fields. @returns A positive rectangle fully contained in the source. */
export function editWallpaperRegion(rect: Rect, patch: Partial<Rect>): Rect {
  const width = clamp(patch.width ?? rect.width, Number.EPSILON, patch.x === undefined ? 1 - rect.x : 1)
  const height = clamp(patch.height ?? rect.height, Number.EPSILON, patch.y === undefined ? 1 - rect.y : 1)
  return { x: patch.x === undefined ? rect.x : clamp(patch.x, 0, 1 - width), y: patch.y === undefined ? rect.y : clamp(patch.y, 0, 1 - height), width, height }
}

/** @param plan Drag-start plan. @param source Full-resolution source dimensions. @param delta Drag in target-canvas coordinates. @param region Region index, absent for image movement. @param resize Whether the region's lower-right corner moves. @returns Detached plan preserving all other evidence and annotations. */
export function dragWallpaperPlan(plan: WallpaperPlan, source: { width: number; height: number }, delta: Point, region?: number, resize = false): WallpaperPlan {
  if (region === undefined) return { ...plan, placement: { ...plan.placement, left: Math.round(plan.placement.left + delta.x), top: Math.round(plan.placement.top + delta.y) } }
  const item = plan.regions[region]
  if (!item) return plan
  const size = wallpaperEditorImageSize(source, plan)
  const rect = editWallpaperRegion(item.rect, resize ? { width: item.rect.width + delta.x / size.width, height: item.rect.height + delta.y / size.height } : { x: item.rect.x + delta.x / size.width, y: item.rect.y + delta.y / size.height })
  return { ...plan, regions: plan.regions.map((value, index) => index === region ? { ...value, rect } : value) }
}
